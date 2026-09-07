import * as assert from 'assert';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { WorkspaceBookmarkStore } from '../../workspaceBookmarkStore';
import { WorkspaceMirrorCoordinator } from '../../workspaceMirrorCoordinator';
import { FakeMemento, FakeMirror, FakeOutput, FakePartitionMirrorResources } from './fixtures';
import { BookmarkData } from '../../types';
import { WORKSPACE_PARTITION_STORAGE_KEY } from '../../workspacePartitionTypes';
import { hashContent, serializeBookmarkData } from '../../bookmarkMirror';

const roots = ['a', 'b'].map((id) => ({ id, label: id, uri: vscode.Uri.parse(`file:///${id}`) }));
const disposables: vscode.Disposable[] = [];

async function fixture() {
  const state = new FakeMemento();
  const output = new FakeOutput();
  const store = await WorkspaceBookmarkStore.create({ state, output, roots });
  const [a, b] = store.getView().attached.map((p) => p.partitionId);
  const ownerA = { kind: 'partition' as const, partitionId: a };
  const ownerB = { kind: 'partition' as const, partitionId: b };
  const resources = new Map<string, FakePartitionMirrorResources>();
  const coordinator = new WorkspaceMirrorCoordinator({ store, output, writeDelayMs: 60000,
    createResources: (root) => {
      const resource = new FakePartitionMirrorResources();
      resources.set(root.path, resource);
      return resource;
    }
  });
  disposables.push(store, coordinator);
  await coordinator.reconcileBindings();
  return { store, state, output, a, b, ownerA, ownerB, coordinator, resources,
    mirrorA: resources.get('/a')!.port, mirrorB: resources.get('/b')!.port };
}

function external(uri = 'file:///a/external.ts', id: string = randomUUID()): BookmarkData {
  return { version: 2, collections: [], items: [{ id, uri, type: 'file', collectionId: null, order: 0 }] };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

suite('WorkspaceMirrorCoordinator', () => {
  teardown(() => { disposables.splice(0).reverse().forEach((item) => item.dispose()); });
  test('binds and seeds one independent mirror per attached partition', async () => {
    const store = await WorkspaceBookmarkStore.create({
      state: new FakeMemento(), output: new FakeOutput(), roots: [
        { id: 'a', label: 'A', uri: vscode.Uri.parse('file:///a') },
        { id: 'b', label: 'B', uri: vscode.Uri.parse('file:///b') }
      ]
    });
    for (const root of ['a', 'b']) {
      await store.addItem(store.resolveAttachedOwner(vscode.Uri.parse(`file:///${root}/item.ts`))!, {
        type: 'file', uri: `file:///${root}/item.ts`
      });
    }
    const mirrors = new Map<string, FakeMirror>();
    const coordinator = new WorkspaceMirrorCoordinator({
      store, output: new FakeOutput(), createResources: (root) => {
        const port = new FakeMirror();
        mirrors.set(root.path, port);
        const emitter = new vscode.EventEmitter<void>();
        return { port, onDidChange: emitter.event, onDidCreate: emitter.event,
          onDidDelete: emitter.event, dispose: () => emitter.dispose() };
      }
    });
    try {
      await coordinator.reconcileBindings();
      assert.strictEqual(mirrors.size, 2);
      assert.deepStrictEqual(JSON.parse(mirrors.get('/a')!.content!).items.map((item: {uri: string}) => item.uri), ['file:///a/item.ts']);
      assert.deepStrictEqual(JSON.parse(mirrors.get('/b')!.content!).items.map((item: {uri: string}) => item.uri), ['file:///b/item.ts']);
      assert.strictEqual(store.getMirrorState(store.getView().attached[0].partitionId)!.dirty, false);
    } finally { coordinator.dispose(); store.dispose(); }
  });

  test('flushAll attempts every root before rejecting and leaves only failed writes dirty', async () => {
    const f = await fixture();
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/local.ts' });
    await f.store.addItem(f.ownerB, { type: 'file', uri: 'file:///b/local.ts' });
    f.mirrorA.failNextWrite = true;
    const gate = deferred();
    const started = deferred();
    const write = f.mirrorB.write.bind(f.mirrorB);
    f.mirrorB.write = async (content) => { started.resolve(); await gate.promise; await write(content); };
    let settled = false;
    const flush = f.coordinator.flushAll();
    void flush.then(() => { settled = true; }, () => { settled = true; });
    await started.promise;
    assert.strictEqual(settled, false);
    gate.resolve();
    await assert.rejects(flush);
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, true);
    assert.strictEqual(f.store.getMirrorState(f.b)!.dirty, false);
    await f.coordinator.reloadPartition(f.a);
    assert.strictEqual(JSON.parse(f.mirrorA.content!).items[0].uri, 'file:///a/local.ts');
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, false);
  });

  test('hash bookkeeping and watcher echoes emit no content event or redundant write', async () => {
    const f = await fixture();
    let events = 0;
    f.store.onBookmarksChanged(() => events++);
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/local.ts' });
    await f.coordinator.flushAll();
    f.resources.get('/a')!.change.fire();
    f.resources.get('/a')!.create.fire();
    await f.coordinator.reloadPartition(f.a);
    await f.coordinator.flushAll();
    assert.strictEqual(events, 1);
    assert.strictEqual(f.mirrorA.writeCount, 2);
    assert.strictEqual(f.mirrorB.writeCount, 1);
  });

  test('adopts valid external edits exactly once and records their hash atomically', async () => {
    const f = await fixture();
    const data = external();
    let events = 0;
    f.store.onBookmarksChanged(() => events++);
    f.mirrorA.content = JSON.stringify(data);
    await f.coordinator.reloadPartition(f.a);
    await f.coordinator.reloadPartition(f.a);
    assert.deepStrictEqual(f.store.getOwnerData(f.ownerA), data);
    assert.strictEqual(events, 1);
    assert.strictEqual(f.mirrorA.writeCount, 1);
    assert.strictEqual(f.store.getView().attached[0].replacementEligible, false);
  });

  for (const [name, payload] of [
    ['invalid JSON', '{broken'], ['malformed item', JSON.stringify({ version: 2, items: [{}], collections: [] })],
    ['future schema', JSON.stringify({ version: 99, items: [], collections: [] })],
    ['cross-root URI', JSON.stringify(external('file:///b/leak.ts'))],
    ['outside URI', JSON.stringify(external('file:///outside/leak.ts'))]
  ]) {
    test(`rejects ${name} without partial adoption or rewrite`, async () => {
      const f = await fixture();
      const before = f.store.getView();
      const writes = f.state.updateCallCount;
      f.mirrorA.content = payload;
      await f.coordinator.reloadPartition(f.a);
      assert.deepStrictEqual(f.store.getView(), before);
      assert.strictEqual(f.state.updateCallCount, writes);
      assert.strictEqual(f.mirrorA.content, payload);
    });
  }

  test('retains unchanged nested URIs but rejects changed URIs in one atomic payload', async () => {
    const f = await fixture();
    const item = await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/nested/old.ts' });
    await f.coordinator.handleRootsChanged([...roots, { id: 'nested', label: 'Nested', uri: vscode.Uri.parse('file:///a/nested') }]);
    await f.coordinator.flushAll();
    const data = f.store.getOwnerData(f.ownerA)!;
    data.items[0].description = 'external';
    f.mirrorA.content = JSON.stringify(data);
    await f.coordinator.reloadPartition(f.a);
    assert.strictEqual(f.store.getOwnerData(f.ownerA)!.items[0].description, 'external');
    data.items[0].uri = 'file:///a/nested/new.ts';
    data.items.push({ ...item, id: randomUUID(), uri: 'file:///a/valid.ts', order: 1 });
    f.mirrorA.content = JSON.stringify(data);
    await f.coordinator.reloadPartition(f.a);
    assert.strictEqual(f.store.getOwnerData(f.ownerA)!.items.length, 1);
    assert.strictEqual(f.store.getOwnerData(f.ownerA)!.items[0].uri, item.uri);
  });

  test('repairs globally colliding and non-UUID identifiers with owner-local collection rebinding', async () => {
    const f = await fixture();
    const collection = await f.store.addCollection(f.ownerB, 'B');
    const item = await f.store.addItem(f.ownerB, { type: 'file', uri: 'file:///b/item.ts' });
    const data = external('file:///a/item.ts', item.id);
    data.collections = [{ ...collection, order: 9 }];
    data.items[0].collectionId = collection.id;
    data.items.push({ ...data.items[0], id: 'bad', uri: 'file:///a/other.ts', collectionId: 'missing', order: 8 });
    f.mirrorA.content = JSON.stringify(data);
    await f.coordinator.reloadPartition(f.a);
    await f.coordinator.flushAll();
    const adopted = f.store.getOwnerData(f.ownerA)!;
    assert.notStrictEqual(adopted.collections[0].id, collection.id);
    assert.notStrictEqual(adopted.items[0].id, item.id);
    assert.strictEqual(adopted.items[0].collectionId, adopted.collections[0].id);
    assert.match(adopted.items[1].id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(adopted.items[1].collectionId, null);
    assert.deepStrictEqual(JSON.parse(f.mirrorA.content!), adopted);
    assert.strictEqual(f.mirrorA.writeCount, 2);
  });

  test('local mutations during an external read take precedence', async () => {
    const f = await fixture();
    const started = deferred(); const gate = deferred();
    f.mirrorA.read = async () => { started.resolve(); await gate.promise; return JSON.stringify(external()); };
    const reload = f.coordinator.reloadPartition(f.a);
    await started.promise;
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/local.ts' });
    gate.resolve(); await reload; await f.coordinator.flushAll();
    assert.deepStrictEqual(f.store.getOwnerData(f.ownerA)!.items.map((item) => item.uri), ['file:///a/local.ts']);
  });

  test('serializes delayed physical writes while another partition reloads independently', async () => {
    const f = await fixture(); const started = deferred(); const gate = deferred();
    const write = f.mirrorA.write.bind(f.mirrorA); const writes: string[] = [];
    f.mirrorA.write = async (content) => {
      writes.push(content);
      if (writes.length === 1) { started.resolve(); await gate.promise; }
      await write(content);
    };
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/first.ts' });
    const first = f.coordinator.flushPartition(f.a); await started.promise;
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/second.ts' });
    const second = f.coordinator.flushPartition(f.a);
    f.mirrorB.content = JSON.stringify(external('file:///b/external.ts'));
    await f.coordinator.reloadPartition(f.b);
    assert.strictEqual(f.store.getOwnerData(f.ownerB)!.items.length, 1);
    assert.strictEqual(writes.length, 1);
    gate.resolve(); await Promise.all([first, second]);
    assert.strictEqual(JSON.parse(f.mirrorA.content!).items.length, 2);
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, false);
  });

  test('flushes removed roots before disposal and detachment and preserves failed dirty data', async () => {
    const f = await fixture();
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/local.ts' });
    const write = f.mirrorA.write.bind(f.mirrorA);
    f.mirrorA.write = async (content) => {
      assert.strictEqual(f.resources.get('/a')!.disposed, false);
      assert.ok(f.store.getView().attached.some((p) => p.partitionId === f.a));
      await write(content);
    };
    await f.coordinator.handleRootsChanged([roots[1]]);
    assert.strictEqual(f.resources.get('/a')!.disposed, true);
    assert.strictEqual(f.store.getView().detached[0].data.items.length, 1);
    await f.store.addItem(f.ownerB, { type: 'file', uri: 'file:///b/local.ts' });
    f.mirrorB.failNextWrite = true;
    await f.coordinator.handleRootsChanged([]);
    assert.strictEqual(f.store.getMirrorState(f.b)!.dirty, true);
    assert.strictEqual(f.resources.get('/b')!.disposed, true);
  });

  test('disposal cancels pending writes and an outstanding read cannot adopt afterward', async () => {
    const f = await fixture(); const gate = deferred(); const started = deferred();
    f.mirrorA.read = async () => { started.resolve(); await gate.promise; return JSON.stringify(external()); };
    const reload = f.coordinator.reloadPartition(f.a); await started.promise;
    await f.store.addItem(f.ownerB, { type: 'file', uri: 'file:///b/local.ts' });
    f.coordinator.dispose(); gate.resolve(); await reload; await f.coordinator.flushAll();
    assert.strictEqual(f.store.getOwnerData(f.ownerA)!.items.length, 0);
    assert.strictEqual(f.mirrorB.writeCount, 1);
    assert.ok([...f.resources.values()].every((resource) => resource.disposed));
  });

  test('failed adoption rolls back snapshot and hash and permits a retry', async () => {
    const f = await fixture(); const before = f.store.getMirrorState(f.a);
    f.mirrorA.content = JSON.stringify(external());
    f.state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
    await assert.rejects(f.coordinator.reloadPartition(f.a));
    assert.deepStrictEqual(f.store.getMirrorState(f.a), before);
    await f.coordinator.reloadPartition(f.a);
    assert.strictEqual(f.store.getOwnerData(f.ownerA)!.items.length, 1);
  });

  test('failed resource creation does not persist binding state or suppress another root', async () => {
    const f = await fixture(); f.coordinator.dispose();
    const before = f.state.updateCallCount; const created: string[] = []; let fail = true;
    const coordinator = new WorkspaceMirrorCoordinator({ store: f.store, output: f.output, createResources: (root) => {
      if (root.path === '/a' && fail) { throw new Error('resource failure'); }
      created.push(root.path); return new FakePartitionMirrorResources(new FakeMirror(f.mirrorA.content));
    } });
    disposables.push(coordinator);
    await coordinator.reconcileBindings();
    assert.deepStrictEqual(created, ['/b']);
    assert.strictEqual(f.state.updateCallCount, before);
    fail = false; await coordinator.reconcileBindings();
    assert.deepStrictEqual(created, ['/b', '/a']);
  });

  test('removal drains a local mutation committed while its previous physical write is pending', async () => {
    const f = await fixture(); const started = deferred(); const gate = deferred();
    const write = f.mirrorA.write.bind(f.mirrorA); let calls = 0;
    f.mirrorA.write = async (content) => {
      if (++calls === 1) { started.resolve(); await gate.promise; }
      await write(content);
    };
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/first.ts' });
    const removal = f.coordinator.handleRootsChanged([roots[1]]);
    await started.promise;
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/second.ts' });
    gate.resolve(); await removal;
    assert.strictEqual(JSON.parse(f.mirrorA.content!).items.length, 2);
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, false);
  });

  test('disposal prevents a queued topology change from detaching store data', async () => {
    const f = await fixture();
    const before = f.store.getView();
    const change = f.coordinator.handleRootsChanged([]);
    f.coordinator.dispose();
    await assert.rejects(change, /disposed/i);
    assert.deepStrictEqual(f.store.getView(), before);
  });

  test('failed root reconciliation restores bindings for the still-attached store snapshot', async () => {
    const f = await fixture();
    f.state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
    await assert.rejects(f.coordinator.handleRootsChanged([roots[1]]));
    assert.strictEqual(f.resources.get('/a')!.disposed, false);
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/after.ts' });
    await f.coordinator.flushAll();
    assert.strictEqual(JSON.parse(f.resources.get('/a')!.port.content!).items.length, 1);
  });

  test('reattachment writes edits made while detached instead of adopting a stale external mirror', async () => {
    const f = await fixture();
    const item = await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/local.ts' });
    await f.coordinator.handleRootsChanged([roots[1]]);
    await f.store.setItemDescription(f.ownerA, item.id, 'edited detached');
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, true);
    f.coordinator.dispose();
    const resources = new FakePartitionMirrorResources(f.mirrorA);
    const coordinator = new WorkspaceMirrorCoordinator({ store: f.store, output: f.output,
      createResources: (root) => root.path === '/a' ? resources : new FakePartitionMirrorResources(f.mirrorB) });
    disposables.push(coordinator);
    f.mirrorA.content = JSON.stringify(external());
    await coordinator.handleRootsChanged(roots);
    assert.strictEqual(JSON.parse(f.mirrorA.content!).items[0].description, 'edited detached');
  });

  test('read failure and deletion preserve content without writes and a later create event adopts', async () => {
    const f = await fixture(); const before = f.store.getMirrorState(f.a);
    f.mirrorA.failNextRead = true;
    await f.coordinator.reloadPartition(f.a);
    f.mirrorA.content = undefined;
    f.resources.get('/a')!.delete.fire();
    await f.coordinator.reloadPartition(f.a);
    assert.deepStrictEqual(f.store.getMirrorState(f.a), before);
    assert.strictEqual(f.mirrorA.writeCount, 1);
    const adopted = deferred();
    f.store.onBookmarksChanged(() => adopted.resolve());
    f.mirrorA.content = JSON.stringify(external());
    f.resources.get('/a')!.create.fire();
    await adopted.promise;
    assert.strictEqual(f.store.getOwnerData(f.ownerA)!.items.length, 1);
  });

  test('migrates v1 data and rewrites normalized descriptions, ordering, and duplicate identifiers', async () => {
    const f = await fixture(); const id = randomUUID();
    const data = external('file:///a/first.ts', id); data.version = 1;
    data.collections = [{ id: 'legacy', name: 'Imported', order: 6 }, { id: 'legacy', name: 'Duplicate', order: 9 }];
    data.items[0].collectionId = 'legacy';
    data.items.push({ ...data.items[0], uri: 'file:///a/second.ts', description: '  trimmed  ', order: 6 });
    f.mirrorA.content = JSON.stringify(data);
    await f.coordinator.reloadPartition(f.a);
    const result = JSON.parse(f.mirrorA.content!) as BookmarkData;
    assert.strictEqual(result.version, 2);
    const ids = [...result.items, ...result.collections].map((entry) => entry.id);
    assert.strictEqual(new Set(ids).size, 4);
    ids.forEach((value) => assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
    assert.deepStrictEqual(result.collections.map((entry) => entry.order), [0, 1]);
    assert.deepStrictEqual(result.items.map((entry) => entry.order), [0, 1]);
    assert.ok(result.items.every((entry) => entry.collectionId === result.collections[0].id));
    assert.strictEqual(result.items[1].description, 'trimmed');
    assert.strictEqual(f.mirrorA.writeCount, 2);
  });

  test('failed repair rewrite remains dirty and retries without another adoption event', async () => {
    const f = await fixture(); let events = 0;
    f.store.onBookmarksChanged(() => events++);
    f.mirrorA.content = JSON.stringify(external('file:///a/repaired.ts', 'legacy'));
    f.mirrorA.failNextWrite = true;
    await assert.rejects(f.coordinator.reloadPartition(f.a));
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, true);
    await f.coordinator.flushAll();
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, false);
    assert.strictEqual(events, 1);
    assert.deepStrictEqual(JSON.parse(f.mirrorA.content!), f.store.getOwnerData(f.ownerA));
  });

  test('hash persistence failure retains dirty precedence and retries physical writes', async () => {
    const f = await fixture();
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/local.ts' });
    const previousHash = f.store.getMirrorState(f.a)!.hash;
    f.state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
    await assert.rejects(f.coordinator.flushPartition(f.a));
    assert.strictEqual(f.store.getMirrorState(f.a)!.hash, previousHash);
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, true);
    await f.coordinator.flushPartition(f.a);
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, false);
  });

  test('a write finishing after coordinator disposal cannot clear dirty state', async () => {
    const f = await fixture(); const started = deferred(); const gate = deferred();
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/local.ts' });
    f.mirrorA.write = async () => { started.resolve(); await gate.promise; };
    const flush = f.coordinator.flushPartition(f.a); await started.promise;
    f.coordinator.dispose(); gate.resolve(); await flush;
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, true);
  });

  test('mirror bookkeeping is atomic, defensive, silent, and cannot erase a newer committed mutation', async () => {
    const f = await fixture();
    const old = f.store.getMirrorState(f.a)!;
    const content = serializeBookmarkData(old.data);
    old.data.items.push(external().items[0]);
    assert.strictEqual(f.store.getOwnerData(f.ownerA)!.items.length, 0);
    const add = f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/new.ts' });
    const record = f.store.recordMirrorWrite(f.a, hashContent(content));
    await Promise.all([add, record]);
    assert.strictEqual(f.store.getMirrorState(f.a)!.dirty, true);
    const before = f.store.getMirrorState(f.a);
    await f.store.adoptMirrorData(f.a, external(), hashContent('external'), false);
    assert.deepStrictEqual(f.store.getMirrorState(f.a), before);
    const writes = f.state.updateCallCount;
    await f.store.recordMirrorDirty('unknown');
    await f.store.recordMirrorWrite('unknown', hashContent(content));
    assert.strictEqual(f.state.updateCallCount, writes);
    assert.strictEqual(f.store.getMirrorState('unknown'), undefined);
  });

  test('never binds unavailable snapshots, Detached partitions, or Unassigned data', async () => {
    const state = new FakeMemento({ 'bookmarks.data': external('file:///outside/kept.ts', 'legacy') });
    const store = await WorkspaceBookmarkStore.create({ state, output: new FakeOutput(), roots });
    await store.reconcileRoots([]);
    let creations = 0;
    const coordinator = new WorkspaceMirrorCoordinator({ store, output: new FakeOutput(), createResources: () => {
      creations++; return new FakePartitionMirrorResources();
    } });
    disposables.push(store, coordinator);
    await coordinator.reconcileBindings();
    assert.strictEqual(creations, 0);
    assert.strictEqual(store.getView().unassigned.items.length, 1);
    const unavailable = await WorkspaceBookmarkStore.create({ state: new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: { version: 99 } }), output: new FakeOutput(), roots });
    const unavailableCoordinator = new WorkspaceMirrorCoordinator({ store: unavailable, output: new FakeOutput(), createResources: () => {
      creations++; return new FakePartitionMirrorResources();
    } });
    disposables.push(unavailable, unavailableCoordinator);
    await unavailableCoordinator.reconcileBindings();
    assert.strictEqual(creations, 0);
  });

  test('debounces committed local mutations and schedules automatic writes only for the dirty owner', async () => {
    const f = await fixture(); f.coordinator.dispose();
    const written = deferred();
    const resourcesA = new FakePartitionMirrorResources(f.mirrorA);
    const resourcesB = new FakePartitionMirrorResources(f.mirrorB);
    const coordinator = new WorkspaceMirrorCoordinator({ store: f.store, output: f.output, writeDelayMs: 0,
      createResources: (root) => root.path === '/a' ? resourcesA : resourcesB });
    disposables.push(coordinator);
    await coordinator.reconcileBindings();
    const write = f.mirrorA.write.bind(f.mirrorA);
    f.mirrorA.write = async (content) => { await write(content); written.resolve(); };
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/first.ts' });
    await f.store.addItem(f.ownerA, { type: 'file', uri: 'file:///a/second.ts' });
    await written.promise;
    await coordinator.flushAll();
    assert.strictEqual(f.mirrorA.writeCount, 2);
    assert.strictEqual(f.mirrorB.writeCount, 1);
    assert.strictEqual(JSON.parse(f.mirrorA.content!).items.length, 2);
  });

  test('rewrites an externally reordered array even when each entry already has the correct order value', async () => {
    const f = await fixture(); const data = external('file:///a/second.ts');
    data.items[0].order = 1;
    data.items.push({ ...external('file:///a/first.ts').items[0] });
    f.mirrorA.content = JSON.stringify(data);
    await f.coordinator.reloadPartition(f.a);
    assert.strictEqual(f.mirrorA.writeCount, 2);
    assert.deepStrictEqual(JSON.parse(f.mirrorA.content!).items.map((item: { uri: string }) => item.uri), ['file:///a/first.ts', 'file:///a/second.ts']);
  });

  test('simultaneous external imports repair identifiers against the snapshot at atomic commit time', async () => {
    const f = await fixture(); const sharedId = randomUUID(); const collectionId = randomUUID();
    const a = external('file:///a/import.ts', sharedId); const b = external('file:///b/import.ts', sharedId);
    for (const data of [a, b]) {
      data.collections = [{ id: collectionId, name: 'Shared import', order: 0 }];
      data.items[0].collectionId = collectionId;
    }
    f.mirrorA.content = JSON.stringify(a); f.mirrorB.content = JSON.stringify(b);
    await Promise.all([f.coordinator.reloadPartition(f.a), f.coordinator.reloadPartition(f.b)]);
    await f.coordinator.flushAll();
    const importedA = f.store.getOwnerData(f.ownerA)!; const importedB = f.store.getOwnerData(f.ownerB)!;
    assert.strictEqual(importedA.items.length, 1); assert.strictEqual(importedB.items.length, 1);
    assert.notStrictEqual(importedA.items[0].id, importedB.items[0].id);
    assert.notStrictEqual(importedA.collections[0].id, importedB.collections[0].id);
    assert.strictEqual(importedB.items[0].collectionId, importedB.collections[0].id);
    assert.deepStrictEqual(JSON.parse(f.mirrorB.content!), importedB);
  });
});
