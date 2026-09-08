import * as assert from 'assert';
import * as vscode from 'vscode';
import { DuplicateBookmarkError } from '../../bookmarkStore';
import { BookmarkItem } from '../../types';
import {
  PartitionBoundaryError,
  PartitionLifecycleChange,
  RecoveryConflictError,
  StaleRecoveryPreviewError,
  WorkspaceBookmarkStore,
  WorkspaceDataUnavailableError
} from '../../workspaceBookmarkStore';
import { RootCandidate } from '../../rootUri';
import {
  RecoveryFileSystem,
  WORKSPACE_PARTITION_STORAGE_KEY,
  WorkspacePartitionSnapshot
} from '../../workspacePartitionTypes';
import { FakeMemento, FakeOutput } from './fixtures';

const ROOT_A = vscode.Uri.parse('file:///workspace/a');
const ROOT_B = vscode.Uri.parse('file:///workspace/b');

function roots(): readonly RootCandidate[] {
  return [
    { id: 'root-a', label: 'Root A', uri: ROOT_A },
    { id: 'root-b', label: 'Root B', uri: ROOT_B }
  ];
}

function ids(): () => string {
  let value = 1;
  return () => `00000000-0000-4000-8000-${(value++).toString().padStart(12, '0')}`;
}

async function readyStore() {
  const state = new FakeMemento();
  const store = await WorkspaceBookmarkStore.create({
    state,
    roots: roots(),
    output: new FakeOutput(),
    createId: ids()
  });
  const attached = store.getView().attached;
  return {
    state,
    store,
    ownerA: { kind: 'partition' as const, partitionId: attached[0].partitionId },
    ownerB: { kind: 'partition' as const, partitionId: attached[1].partitionId }
  };
}

suite('WorkspaceBookmarkStore - move position regression (#62)', () => {
  test('moving within one collection preserves the requested insertion position', async () => {
    const { store, ownerA } = await readyStore();
    const collection = await store.addCollection(ownerA, 'Collection');
    const first = await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/first', collectionId: collection.id });
    const second = await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/second', collectionId: collection.id });
    const third = await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/third', collectionId: collection.id });
    await store.moveItem(ownerA, third.id, collection.id, 0);
    assert.deepStrictEqual(store.getOwnerData(ownerA)!.items.slice().sort((a, b) => a.order - b.order).map(item => item.id),
      [third.id, first.id, second.id]);
    await store.moveItem(ownerA, third.id, null, 0);
    assert.deepStrictEqual(store.getOwnerData(ownerA)!.items.filter(item => item.collectionId === collection.id).map(item => item.order), [0, 1]);
    const before = store.getAll();
    await store.moveItem(ownerA, 'missing', collection.id, 0);
    assert.deepStrictEqual(store.getAll(), before);
    store.dispose();
  });
});

function snapshotWithDetachedAndUnassigned(): WorkspacePartitionSnapshot {
  return {
    version: 1,
    partitions: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        attachment: null,
        lastKnownRootUri: ROOT_A.toString(),
        canonicalLastKnownRootUri: ROOT_A.toString(),
        replacementEligible: true,
        data: { version: 2, items: [], collections: [] },
        mirror: { dirty: false }
      }
    ],
    unassigned: { version: 2, items: [], collections: [] }
  };
}

function snapshotWithAttachedRoot(): WorkspacePartitionSnapshot {
  const snapshot = snapshotWithDetachedAndUnassigned();
  snapshot.partitions[0].attachment = {
    rootUri: ROOT_A.toString(),
    canonicalRootUri: ROOT_A.toString()
  };
  return snapshot;
}

function recoverySnapshot(options: { destination?: 'none' | 'eligible' | 'established' } = {}): WorkspacePartitionSnapshot {
  const destination = options.destination ?? 'none';
  const partitions: WorkspacePartitionSnapshot['partitions'] = [{
    id: '00000000-0000-4000-8000-000000000001', attachment: null,
    lastKnownRootUri: 'file:///old/repo', canonicalLastKnownRootUri: 'file:///old/repo',
    replacementEligible: false,
    data: {
      version: 2, collections: [], items: [
        { id: '00000000-0000-4000-8000-000000000011', type: 'file', uri: 'file:///old/repo/src/a.ts', collectionId: null, order: 0 },
        { id: '00000000-0000-4000-8000-000000000012', type: 'file', uri: 'file:///old/repo/src/missing.ts', collectionId: null, order: 1 },
        { id: '00000000-0000-4000-8000-000000000013', type: 'file', uri: 'file:///elsewhere/kept.ts', collectionId: null, order: 2 }
      ]
    }, mirror: { dirty: false }
  }];
  if (destination !== 'none') {
    partitions.push({
      id: '00000000-0000-4000-8000-000000000002',
      attachment: { rootUri: 'file:///new/repo', canonicalRootUri: 'file:///new/repo' },
      lastKnownRootUri: 'file:///new/repo', canonicalLastKnownRootUri: 'file:///new/repo',
      replacementEligible: destination === 'eligible',
      data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
    });
  }
  return { version: 1, partitions, unassigned: { version: 2, items: [], collections: [] } };
}

function recoveryFilesystem(resolving: readonly string[]): RecoveryFileSystem {
  const targets = new Set(resolving);
  return {
    stat: async (uri) => {
      if (targets.has(uri.toString())) {
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 1 };
      }
      throw new Error('not found');
    }
  };
}

class DeferredRecoveryFileSystem implements RecoveryFileSystem {
  private releaseStat: (() => void) | undefined;
  private signalStarted: (() => void) | undefined;
  readonly statStarted: Promise<void>;
  private readonly statGate: Promise<void>;

  constructor() {
    this.statStarted = new Promise<void>((resolve) => {
      this.signalStarted = resolve;
    });
    this.statGate = new Promise<void>((resolve) => {
      this.releaseStat = resolve;
    });
  }

  stat(): Thenable<vscode.FileStat> {
    this.signalStarted?.();
    return this.statGate.then(() => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 1 }));
  }

  release(): void {
    this.releaseStat?.();
  }
}

class DeferredFirstWorkspaceUpdateMemento extends FakeMemento {
  private readonly firstUpdateGate: Promise<void>;
  private releaseFirstUpdate: (() => void) | undefined;
  private signalFirstUpdate: (() => void) | undefined;
  private shouldDeferWorkspaceUpdate = true;

  readonly firstWorkspaceUpdateStarted: Promise<void>;

  constructor(initial: Record<string, unknown>) {
    super(initial);
    this.firstUpdateGate = new Promise<void>((resolve) => {
      this.releaseFirstUpdate = resolve;
    });
    this.firstWorkspaceUpdateStarted = new Promise<void>((resolve) => {
      this.signalFirstUpdate = resolve;
    });
  }

  releaseFirstWorkspaceUpdate(): void {
    this.releaseFirstUpdate?.();
  }

  update(key: string, value: unknown): Thenable<void> {
    if (key === WORKSPACE_PARTITION_STORAGE_KEY && this.shouldDeferWorkspaceUpdate) {
      this.shouldDeferWorkspaceUpdate = false;
      this.signalFirstUpdate?.();
      return this.firstUpdateGate.then(() => super.update(key, value));
    }

    return super.update(key, value);
  }
}

suite('WorkspaceBookmarkStore content operations', () => {
  for (const failure of [false, true]) {
    test(`supported older owner schemas migrate atomically before publishing, persistence failure=${failure}`, async () => {
      const snapshot = snapshotWithAttachedRoot();
      snapshot.partitions[0].data.version = 1;
      snapshot.partitions.push({ ...snapshot.partitions[0], id: '00000000-0000-4000-8000-000000000002', attachment: null,
        lastKnownRootUri: ROOT_B.toString(), canonicalLastKnownRootUri: ROOT_B.toString(),
        data: { version: 1, collections: [], items: [] } });
      snapshot.unassigned.version = 1;
      const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
      if (failure) state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
      const loading = WorkspaceBookmarkStore.create({ state, roots: roots(), output: new FakeOutput() });
      if (failure) {
        await assert.rejects(loading);
        assert.deepStrictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), snapshot);
        assert.strictEqual(state.updateCallCount, 0);
      } else {
        const store = await loading;
        try {
          assert.strictEqual(state.updateCallCount, 1);
          const persisted = state.get<WorkspacePartitionSnapshot>(WORKSPACE_PARTITION_STORAGE_KEY)!;
          assert.deepStrictEqual(persisted.partitions.map(partition => partition.data.version), [2, 2]);
          assert.strictEqual(persisted.unassigned.version, 2);
          assert.deepStrictEqual(persisted.partitions.map(partition => partition.mirror.dirty), [true, true]);
          assert.strictEqual(store.getView().attached[0].data.version, 2);
          assert.strictEqual(store.getView().detached[0].data.version, 2);
        } finally { store.dispose(); }
      }
    });
  }

  test('branch-created unsafe canonical percent metadata remains unavailable without remapping', async () => {
    const snapshot = snapshotWithAttachedRoot();
    snapshot.partitions[0].attachment = { rootUri: 'file:///work/%2561', canonicalRootUri: 'file:///work/a' };
    snapshot.partitions[0].lastKnownRootUri = 'file:///work/%2561';
    snapshot.partitions[0].canonicalLastKnownRootUri = 'file:///work/a';
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
    const store = await WorkspaceBookmarkStore.create({ state, roots: [], output: new FakeOutput() });
    try {
      assert.strictEqual(store.getView().kind, 'unavailable');
      assert.deepStrictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), snapshot);
      assert.strictEqual(state.updateCallCount, 0);
    } finally { store.dispose(); }
  });

  test('resource lookup safely parses Unassigned URIs without conflating literal percent names or path case', async () => {
    const snapshot = snapshotWithDetachedAndUnassigned();
    snapshot.unassigned.items = ['not an absolute URI', 'file:///a/%66ile.ts', 'file:///a/%2566ile.ts', 'file:///a/File.ts', 'file:///a/file.ts?view=1#part']
      .map((uri, index) => ({ id: `00000000-0000-4000-8000-00000000001${index}`, uri, type: 'file', collectionId: null, order: index }));
    const store = await WorkspaceBookmarkStore.create({ state: new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot }),
      roots: [], output: new FakeOutput() });
    try {
      const matches = store.findItemsByUri(vscode.Uri.parse('file:///a/file.ts'));
      assert.deepStrictEqual(matches.map(match => match.item.id), ['00000000-0000-4000-8000-000000000011']);
      assert.deepStrictEqual(matches[0].owner, { kind: 'unassigned' });
      assert.deepStrictEqual(store.findItemsByUri(vscode.Uri.file('/a/%66ile.ts')).map(match => match.item.id), ['00000000-0000-4000-8000-000000000012']);
      assert.deepStrictEqual(store.findItemsByUri(vscode.Uri.parse('file:///a/File.ts')).map(match => match.item.id), ['00000000-0000-4000-8000-000000000013']);
      assert.deepStrictEqual(store.findItemsByUri(vscode.Uri.parse('file:///a/file.ts?view=1#part')).map(match => match.item.id), ['00000000-0000-4000-8000-000000000014']);
    } finally { store.dispose(); }
  });

  test('whenIdle drains operations accepted while an earlier write is pending', async () => {
    const { store, state, ownerA } = await readyStore();
    let releaseFirst!: () => void, releaseSecond!: () => void;
    let enterFirst!: () => void, enterSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const firstEntered = new Promise<void>(resolve => { enterFirst = resolve; });
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    const update = state.update.bind(state);
    let writes = 0;
    state.update = async (key, value) => {
      if (++writes === 1) { enterFirst(); await firstGate; }
      else { enterSecond(); await secondGate; }
      await update(key, value);
    };
    const first = store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/first' });
    let second: Promise<BookmarkItem> | undefined;
    try {
      await firstEntered;
      let idle = false;
      const drained = store.whenIdle().then(() => { idle = true; });
      second = store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/second' });
      releaseFirst();
      await secondEntered;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.strictEqual(idle, false, 'a later accepted write is still pending');
      releaseSecond();
      await drained;
      assert.deepStrictEqual(store.getAll().items.map(item => item.uri), ['file:///workspace/a/first', 'file:///workspace/a/second']);
    } finally { releaseFirst(); releaseSecond(); await Promise.all([first, second]); store.dispose(); }
  });

  test('whenIdle waits past a rejected operation for the next successful commit', async () => {
    const { store, state, ownerA } = await readyStore();
    try {
      state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
      const failed = assert.rejects(store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/failed' }));
      const committed = store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/kept' });
      await store.whenIdle();
      await Promise.all([failed, committed]);
      assert.deepStrictEqual(store.getAll().items.map(item => item.uri), ['file:///workspace/a/kept']);
    } finally { store.dispose(); }
  });

  test('creates only inside the explicit matching attached partition', async () => {
    const { store, state, ownerA, ownerB } = await readyStore();
    const events: number[] = [];
    store.onBookmarksChanged(() => events.push(1));
    const updatesBefore = state.updateCallCount;

    await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/src/a.ts' });

    assert.strictEqual(store.getOwnerData(ownerA)?.items.length, 1);
    assert.strictEqual(store.getOwnerData(ownerB)?.items.length, 0);
    assert.strictEqual(state.updateCallCount, updatesBefore + 1);
    assert.strictEqual(events.length, 1);
  });

  test('rejects a cross-root URI without mutation or event', async () => {
    const { store, state, ownerA } = await readyStore();
    const before = state.get(WORKSPACE_PARTITION_STORAGE_KEY);
    let events = 0;
    store.onBookmarksChanged(() => events++);

    await assert.rejects(
      store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/b/src/b.ts' }),
      PartitionBoundaryError
    );

    assert.deepStrictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), before);
    assert.strictEqual(events, 0);
  });

  test('uses owner-local identifiers and preserves BookmarkStore duplicate and ordering rules', async () => {
    const { store, state, ownerA, ownerB } = await readyStore();
    const first = await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/one.ts' });
    const second = await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/two.ts' });
    const updatesBeforeNoOp = state.updateCallCount;

    await store.removeItem(ownerB, first.id);
    await store.moveItem(ownerB, second.id, null, 0);
    await store.renameCollection(ownerB, 'missing', 'ignored');
    await store.setItemDescription(ownerB, first.id, 'ignored');
    await store.deleteCollection(ownerB, 'missing');

    assert.strictEqual(state.updateCallCount, updatesBeforeNoOp);
    assert.deepStrictEqual(
      store.getOwnerData(ownerA)?.items.map((item: BookmarkItem) => item.order),
      [0, 1]
    );
    await assert.rejects(
      store.addItem(ownerA, { type: 'folder', uri: first.uri }),
      DuplicateBookmarkError
    );
    await store.moveItem(ownerA, second.id, null, 99);
    assert.deepStrictEqual(
      store.getOwnerData(ownerA)?.items.map((item: BookmarkItem) => item.id),
      [first.id, second.id]
    );
  });

  test('sets descriptions, creates collections, moves items, and deletes collections with local parity', async () => {
    const { store, ownerA } = await readyStore();
    const item = await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/one.ts' });
    const collection = await store.addCollection(ownerA, ' Group ');

    await store.setItemDescription(ownerA, item.id, '  item note  ');
    await store.setCollectionDescription(ownerA, collection.id, '  collection note  ');
    await store.moveItem(ownerA, item.id, collection.id, 5);
    await store.renameCollection(ownerA, collection.id, 'Renamed');
    await store.deleteCollection(ownerA, collection.id);

    const data = store.getOwnerData(ownerA)!;
    assert.deepStrictEqual(data.collections, []);
    assert.deepStrictEqual(data.items.map((entry: BookmarkItem) => ({
      collectionId: entry.collectionId,
      description: entry.description,
      order: entry.order
    })), [{ collectionId: null, description: 'item note', order: 0 }]);
  });

  test('rejects Unassigned and detached creates without writing', async () => {
    const state = new FakeMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: snapshotWithDetachedAndUnassigned()
    });
    const store = await WorkspaceBookmarkStore.create({ state, roots: roots(), output: new FakeOutput(), createId: ids() });
    const updatesBefore = state.updateCallCount;

    await assert.rejects(
      store.addCollection({ kind: 'unassigned' }, 'Nope'),
      PartitionBoundaryError
    );
    await assert.rejects(
      store.addItem(
        { kind: 'partition', partitionId: '00000000-0000-4000-8000-000000000001' },
        { type: 'file', uri: 'file:///workspace/a/nope.ts' }
      ),
      PartitionBoundaryError
    );

    assert.strictEqual(state.updateCallCount, updatesBefore);
  });

  test('keeps replacement eligibility false after the first content mutation', async () => {
    const { store, ownerA } = await readyStore();
    const item = await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/a.ts' });
    await store.removeItem(ownerA, item.id);

    assert.strictEqual(store.getView().attached[0].replacementEligible, false);
  });

  test('aggregates all owners for read-only consumers without sharing mutable records', async () => {
    const { store, ownerA, ownerB } = await readyStore();
    await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/a.ts' });
    await store.addItem(ownerB, { type: 'file', uri: 'file:///workspace/b/b.ts' });

    const aggregate = store.getAll();
    aggregate.items[0].uri = 'file:///mutated.ts';

    assert.deepStrictEqual(
      store.getAll().items.map((item: BookmarkItem) => item.uri).sort(),
      ['file:///workspace/a/a.ts', 'file:///workspace/b/b.ts']
    );
  });

  test('serializes concurrent mutations and persists one snapshot/event per change', async () => {
    const { store, state, ownerA } = await readyStore();
    let events = 0;
    store.onBookmarksChanged(() => events++);
    const updatesBefore = state.updateCallCount;

    await Promise.all([
      store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/one.ts' }),
      store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/two.ts' })
    ]);

    assert.deepStrictEqual(store.getOwnerData(ownerA)?.items.map((item: BookmarkItem) => item.order), [0, 1]);
    assert.strictEqual(state.updateCallCount, updatesBefore + 2);
    assert.strictEqual(events, 2);
  });

  test('does not publish or fire when persistence fails', async () => {
    const { store, state, ownerA } = await readyStore();
    let events = 0;
    store.onBookmarksChanged(() => events++);
    state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;

    await assert.rejects(store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/a.ts' }));

    assert.strictEqual(store.getOwnerData(ownerA)?.items.length, 0);
    assert.strictEqual(events, 0);
  });

  test('marks attached mirror metadata dirty in the same persisted content transition', async () => {
    const { store, state, ownerA } = await readyStore();
    await store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/a.ts' });

    const persisted = state.get<WorkspacePartitionSnapshot>(WORKSPACE_PARTITION_STORAGE_KEY)!;
    assert.strictEqual(
      persisted.partitions.find((partition) => partition.id === ownerA.partitionId)?.mirror.dirty,
      true
    );
  });

  test('reallocates a colliding generated identifier before publishing the snapshot', async () => {
    const state = new FakeMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: snapshotWithAttachedRoot()
    });
    const generated = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    ];
    const store = await WorkspaceBookmarkStore.create({
      state,
      roots: roots(),
      output: new FakeOutput(),
      createId: () => generated.shift()!
    });
    const owner = { kind: 'partition' as const, partitionId: '00000000-0000-4000-8000-000000000001' };

    const item = await store.addItem(owner, { type: 'file', uri: 'file:///workspace/a/a.ts' });

    assert.strictEqual(item.id, '00000000-0000-4000-8000-000000000002');
  });

  test('skips a unique malformed generated identifier before publishing the snapshot', async () => {
    const state = new FakeMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: snapshotWithAttachedRoot()
    });
    const generated = ['not-a-uuid', '00000000-0000-4000-8000-000000000002'];
    const store = await WorkspaceBookmarkStore.create({
      state,
      roots: roots(),
      output: new FakeOutput(),
      createId: () => generated.shift()!
    });
    const owner = { kind: 'partition' as const, partitionId: '00000000-0000-4000-8000-000000000001' };

    const item = await store.addItem(owner, { type: 'file', uri: 'file:///workspace/a/a.ts' });

    assert.strictEqual(item.id, '00000000-0000-4000-8000-000000000002');
  });

  test('rejects mutations after disposal without writing, firing, or blocking later calls', async () => {
    const { store, state, ownerA } = await readyStore();
    let events = 0;
    store.onBookmarksChanged(() => events++);
    const updatesBefore = state.updateCallCount;
    store.dispose();

    await assert.rejects(
      store.addItem(ownerA, { type: 'file', uri: 'file:///workspace/a/a.ts' }),
      (error: unknown) => error instanceof WorkspaceDataUnavailableError
        && error.message === 'Workspace bookmark store is disposed.'
    );
    await assert.rejects(
      store.removeItem(ownerA, 'missing'),
      (error: unknown) => error instanceof WorkspaceDataUnavailableError
        && error.message === 'Workspace bookmark store is disposed.'
    );

    assert.strictEqual(state.updateCallCount, updatesBefore);
    assert.strictEqual(events, 0);
  });

  test('allows an in-flight write to settle but rejects a queued mutation after disposal', async () => {
    const state = new DeferredFirstWorkspaceUpdateMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: snapshotWithAttachedRoot()
    });
    const store = await WorkspaceBookmarkStore.create({
      state,
      roots: roots(),
      output: new FakeOutput(),
      createId: ids()
    });
    const owner = {
      kind: 'partition' as const,
      partitionId: '00000000-0000-4000-8000-000000000001'
    };
    let events = 0;
    store.onBookmarksChanged(() => events++);

    const firstMutation = store.addItem(owner, { type: 'file', uri: 'file:///workspace/a/a.ts' });
    await state.firstWorkspaceUpdateStarted;

    const secondMutation = store.addItem(owner, { type: 'file', uri: 'file:///workspace/a/b.ts' });
    const firstSettled = firstMutation.then(
      (item) => ({ status: 'fulfilled' as const, item }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );
    const secondSettled = secondMutation.then(
      (item) => ({ status: 'fulfilled' as const, item }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );

    store.dispose();
    state.releaseFirstWorkspaceUpdate();

    const [firstResult, secondResult] = await Promise.all([firstSettled, secondSettled]);

    assert.strictEqual(firstResult.status, 'fulfilled');
    if (firstResult.status === 'fulfilled') {
      assert.strictEqual(firstResult.item.uri, 'file:///workspace/a/a.ts');
    }
    assert.strictEqual(secondResult.status, 'rejected');
    if (secondResult.status === 'rejected') {
      assert.ok(secondResult.error instanceof WorkspaceDataUnavailableError);
      assert.strictEqual(secondResult.error.message, 'Workspace bookmark store is disposed.');
    }
    assert.strictEqual(state.updateCallCount, 1);
    assert.strictEqual(events, 0);

    const persisted = state.get<WorkspacePartitionSnapshot>(WORKSPACE_PARTITION_STORAGE_KEY);
    assert.deepStrictEqual(
      persisted?.partitions[0].data.items.map((item) => item.uri),
      ['file:///workspace/a/a.ts']
    );
  });

  test('keeps malformed workspace state unavailable and rejects every mutation without writing', async () => {
    const state = new FakeMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: { version: 99, partitions: [], unassigned: {} }
    });
    const store = await WorkspaceBookmarkStore.create({ state, roots: roots(), output: new FakeOutput(), createId: ids() });
    const updatesBefore = state.updateCallCount;

    assert.deepStrictEqual(store.getView().kind, 'unavailable');
    await assert.rejects(
      store.addItem({ kind: 'partition', partitionId: 'missing' }, { type: 'file', uri: 'file:///workspace/a/a.ts' }),
      WorkspaceDataUnavailableError
    );
    await assert.rejects(store.addCollection({ kind: 'unassigned' }, 'Nope'), WorkspaceDataUnavailableError);
    assert.strictEqual(state.updateCallCount, updatesBefore);
  });
});

suite('WorkspaceBookmarkStore root lifecycle', () => {
  test('adding a nested root preserves existing ownership while assigning future URIs to the nested partition', async () => {
    const state = new FakeMemento();
    const parent = vscode.Uri.parse('file:///work');
    const store = await WorkspaceBookmarkStore.create({
      state,
      roots: [{ id: 'parent', label: 'Work', uri: parent }],
      output: new FakeOutput(),
      createId: ids()
    });
    const parentId = store.getView().attached[0].partitionId;
    const item = await store.addItem(
      { kind: 'partition', partitionId: parentId },
      { type: 'file', uri: 'file:///work/child/existing.ts' }
    );

    const result = await store.reconcileRoots([
      { id: 'parent', label: 'Work', uri: parent },
      { id: 'child', label: 'Child', uri: vscode.Uri.parse('file:///work/child') }
    ]);

    assert.strictEqual(store.getOwnerData({ kind: 'partition', partitionId: parentId })?.items[0].id, item.id);
    const childOwner = store.resolveAttachedOwner(vscode.Uri.parse('file:///work/child/new.ts'));
    assert.strictEqual(childOwner?.kind, 'partition');
    assert.notStrictEqual(childOwner?.kind === 'partition' ? childOwner.partitionId : undefined, parentId);
    assert.strictEqual(result.attachedPartitionIds.length, 1);
  });

  test('reconciliation detaches a missing root and reattaches its exact canonical return', async () => {
    const state = new FakeMemento();
    const root = vscode.Uri.parse('file:///work');
    const store = await WorkspaceBookmarkStore.create({
      state,
      roots: [{ id: 'work', label: 'Work', uri: root }],
      output: new FakeOutput(),
      createId: ids()
    });
    const partitionId = store.getView().attached[0].partitionId;

    const removal = await store.reconcileRoots([]);
    const returned = await store.reconcileRoots([
      { id: 'returned', label: 'Returned work', uri: vscode.Uri.parse('FILE:///work/') }
    ]);

    assert.deepStrictEqual(removal.detachedPartitionIds, [partitionId]);
    assert.deepStrictEqual(returned.attachedPartitionIds, [partitionId]);
    assert.strictEqual(store.getView().attached[0].partitionId, partitionId);
  });

  test('reordering and relabeling roots updates the lifecycle view without persistence but emits one lifecycle event', async () => {
    const { store, state } = await readyStore();
    const changes: PartitionLifecycleChange[] = [];
    store.onDidChangePartitions((change) => changes.push(change));
    let contentEvents = 0;
    store.onBookmarksChanged(() => contentEvents++);
    const writes = state.updateCallCount;

    await store.reconcileRoots([
      { id: 'root-b', label: 'Renamed B', uri: ROOT_B },
      { id: 'root-a', label: 'Renamed A', uri: ROOT_A }
    ]);

    assert.deepStrictEqual(store.getView().attached.map((partition) => partition.label), ['Renamed B', 'Renamed A']);
    assert.strictEqual(state.updateCallCount, writes);
    assert.strictEqual(contentEvents, 0);
    assert.strictEqual(changes.length, 1);
    assert.deepStrictEqual(changes[0].attachedPartitionIds, []);
    assert.deepStrictEqual(changes[0].detachedPartitionIds, []);
  });

  test('content listeners observe committed roots and ownership during a persisted reconciliation', async () => {
    const state = new FakeMemento();
    const parent = vscode.Uri.parse('file:///work');
    const child = vscode.Uri.parse('file:///work/child');
    const store = await WorkspaceBookmarkStore.create({
      state, roots: [{ id: 'parent', label: 'Old label', uri: parent }], output: new FakeOutput(), createId: ids()
    });
    const parentId = store.getView().attached[0].partitionId;
    let observed: { labels: readonly string[]; owner: string | undefined } | undefined;
    store.onBookmarksChanged(() => {
      const owner = store.resolveAttachedOwner(vscode.Uri.parse('file:///work/child/new.ts'));
      observed = {
        labels: store.getView().attached.map((partition) => partition.label),
        owner: owner?.kind === 'partition' ? owner.partitionId : undefined
      };
    });

    await store.reconcileRoots([
      { id: 'parent', label: 'Renamed parent', uri: parent },
      { id: 'child', label: 'Child', uri: child }
    ]);

    assert.deepStrictEqual(observed?.labels, ['Renamed parent', 'Child']);
    assert.notStrictEqual(observed?.owner, parentId);
  });

  test('canonical collisions keep roots unavailable without replacing or reassigning partitions', async () => {
    const state = new FakeMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: {
        version: 1,
        partitions: [
          {
            id: '00000000-0000-4000-8000-000000000001', attachment: null,
            lastKnownRootUri: 'file:///work', canonicalLastKnownRootUri: 'file:///work',
            replacementEligible: false, data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
          },
          {
            id: '00000000-0000-4000-8000-000000000002', attachment: null,
            lastKnownRootUri: 'FILE:///work/', canonicalLastKnownRootUri: 'file:///work',
            replacementEligible: false, data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
          }
        ],
        unassigned: { version: 2, items: [], collections: [] }
      }
    });
    const store = await WorkspaceBookmarkStore.create({ state, roots: [], output: new FakeOutput(), createId: ids() });
    const writes = state.updateCallCount;

    const result = await store.reconcileRoots([
      { id: 'one', label: 'One', uri: vscode.Uri.parse('file:///work') },
      { id: 'two', label: 'Two', uri: vscode.Uri.parse('FILE:///work/') }
    ]);

    assert.deepStrictEqual(result.unavailableCanonicalRoots, ['file:///work']);
    assert.strictEqual(store.getView().attached.length, 0);
    assert.strictEqual(store.getView().detached.length, 2);
    assert.strictEqual(state.updateCallCount, writes);
  });

  test('multiple detached partitions matching one returning identity leave that root unavailable', async () => {
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: recoverySnapshot() });
    const snapshot = state.get<WorkspacePartitionSnapshot>(WORKSPACE_PARTITION_STORAGE_KEY)!;
    snapshot.partitions.push({
      id: '00000000-0000-4000-8000-000000000099', attachment: null,
      lastKnownRootUri: 'FILE:///old/repo/', canonicalLastKnownRootUri: 'file:///old/repo',
      replacementEligible: false, data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
    });
    const root = { id: 'returning', label: 'Old repo', uri: vscode.Uri.parse('file:///old/repo') };
    const store = await WorkspaceBookmarkStore.create({ state, roots: [], output: new FakeOutput(), createId: ids() });

    const result = await store.reconcileRoots([root]);

    assert.deepStrictEqual(result.unavailableCanonicalRoots, ['file:///old/repo']);
    assert.strictEqual(store.getView().attached.length, 0);
    assert.strictEqual(store.getView().detached.length, 2);
  });
});

suite('WorkspaceBookmarkStore recovery', () => {
  const destination: RootCandidate = {
    id: 'new-root', label: 'New repo', uri: vscode.Uri.parse('file:///new/repo')
  };

  async function recoveryStore(destinationState: 'none' | 'eligible' | 'established' = 'none') {
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: recoverySnapshot({ destination: destinationState }) });
    const store = await WorkspaceBookmarkStore.create({
      state, roots: [destination], output: new FakeOutput(), createId: ids()
    });
    return { state, store, detachedId: '00000000-0000-4000-8000-000000000001' };
  }

  test('salvage previews resolving, missing, and incompatible items then rewrites only resolving URIs', async () => {
    const { state, store, detachedId } = await recoveryStore();
    const writes = state.updateCallCount;
    const preview = await store.previewRecovery(
      detachedId,
      destination,
      'salvage',
      recoveryFilesystem(['file:///new/repo/src/a.ts'])
    );

    assert.deepStrictEqual(
      { resolving: preview.resolving, missing: preview.missing, incompatible: preview.incompatible },
      { resolving: 1, missing: 1, incompatible: 1 }
    );
    await store.commitRecovery(preview.token);

    assert.strictEqual(state.updateCallCount, writes + 1);
    assert.deepStrictEqual(
      store.getView().attached[0].data.items.map((item) => item.uri),
      ['file:///new/repo/src/a.ts', 'file:///old/repo/src/missing.ts', 'file:///elsewhere/kept.ts']
    );
  });

  test('reattach-only preserves every item URI and consumes its recovery token once', async () => {
    const { store, detachedId } = await recoveryStore();
    const preview = await store.previewRecovery(detachedId, destination, 'reattach-only', recoveryFilesystem([]));

    await store.commitRecovery(preview.token);

    assert.deepStrictEqual(
      store.getView().attached[0].data.items.map((item) => item.uri),
      ['file:///old/repo/src/a.ts', 'file:///old/repo/src/missing.ts', 'file:///elsewhere/kept.ts']
    );
    await assert.rejects(store.commitRecovery(preview.token), RecoveryConflictError);
  });

  test('recovery replaces only an empty replacement-eligible destination partition', async () => {
    const { store, detachedId } = await recoveryStore('eligible');
    const preview = await store.previewRecovery(detachedId, destination, 'reattach-only', recoveryFilesystem([]));

    await store.commitRecovery(preview.token);

    assert.deepStrictEqual(store.getView().attached.map((partition) => partition.partitionId), [detachedId]);
  });

  test('recovery of an explicitly selected duplicate clears availability and publishes one attachment lifecycle change', async () => {
    const snapshot = recoverySnapshot();
    snapshot.partitions.push({
      id: '00000000-0000-4000-8000-000000000099', attachment: null,
      lastKnownRootUri: 'FILE:///old/repo/', canonicalLastKnownRootUri: 'file:///old/repo',
      replacementEligible: false, data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
    });
    const returning: RootCandidate = { id: 'old-root', label: 'Old repo', uri: vscode.Uri.parse('file:///old/repo') };
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
    const store = await WorkspaceBookmarkStore.create({ state, roots: [], output: new FakeOutput(), createId: ids() });
    await store.reconcileRoots([returning]);
    assert.deepStrictEqual(store.getView().unavailableRoots, ['file:///old/repo']);
    const changes: PartitionLifecycleChange[] = [];
    store.onDidChangePartitions((change) => changes.push(change));

    const preview = await store.previewRecovery(snapshot.partitions[0].id, returning, 'reattach-only', recoveryFilesystem([]));
    await store.commitRecovery(preview.token);

    assert.deepStrictEqual(store.getView().unavailableRoots, []);
    assert.strictEqual(changes.length, 1);
    assert.deepStrictEqual(changes[0].attachedPartitionIds, [snapshot.partitions[0].id]);
    assert.deepStrictEqual(changes[0].removedReplacementPartitionIds, []);
  });

  test('recovery elsewhere leaves an unattached current root unavailable without reassigning its remaining detached partition', async () => {
    const snapshot = recoverySnapshot();
    const remainingDetachedId = '00000000-0000-4000-8000-000000000099';
    snapshot.partitions.push({
      id: remainingDetachedId, attachment: null,
      lastKnownRootUri: 'FILE:///old/repo/', canonicalLastKnownRootUri: 'file:///old/repo',
      replacementEligible: false, data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
    });
    const oldRoot: RootCandidate = { id: 'old-root', label: 'Old repo', uri: vscode.Uri.parse('file:///old/repo') };
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
    const store = await WorkspaceBookmarkStore.create({ state, roots: [], output: new FakeOutput(), createId: ids() });
    await store.reconcileRoots([oldRoot, destination]);
    const changes: PartitionLifecycleChange[] = [];
    store.onDidChangePartitions((change) => changes.push(change));

    const preview = await store.previewRecovery(snapshot.partitions[0].id, destination, 'reattach-only', recoveryFilesystem([]));
    await store.commitRecovery(preview.token);

    assert.deepStrictEqual(store.getView().unavailableRoots, ['file:///old/repo']);
    assert.strictEqual(store.resolveAttachedOwner(vscode.Uri.parse('file:///old/repo/src/kept.ts')), undefined);
    assert.ok(store.getView().detached.some((partition) => partition.partitionId === remainingDetachedId));
    assert.strictEqual(changes.length, 1);
    assert.deepStrictEqual(changes[0].unavailableCanonicalRoots, ['file:///old/repo']);
  });

  test('recovery publishes one replacement-removal lifecycle change only after persistence succeeds', async () => {
    const { state, store, detachedId } = await recoveryStore('eligible');
    const changes: PartitionLifecycleChange[] = [];
    store.onDidChangePartitions((change) => changes.push(change));
    const preview = await store.previewRecovery(detachedId, destination, 'reattach-only', recoveryFilesystem([]));
    state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;

    await assert.rejects(store.commitRecovery(preview.token));
    assert.strictEqual(changes.length, 0);
    assert.deepStrictEqual(store.getView().attached.map((partition) => partition.partitionId), ['00000000-0000-4000-8000-000000000002']);

    await store.commitRecovery(preview.token);

    assert.strictEqual(changes.length, 1);
    assert.deepStrictEqual(changes[0].attachedPartitionIds, [detachedId]);
    assert.deepStrictEqual(changes[0].removedReplacementPartitionIds, ['00000000-0000-4000-8000-000000000002']);
    assert.deepStrictEqual(changes[0].unavailableCanonicalRoots, []);
  });

  test('recovery rejects established and invalid destinations without mutation', async () => {
    const { state, store, detachedId } = await recoveryStore('established');
    const before = JSON.stringify(store.getView());
    const writes = state.updateCallCount;

    await assert.rejects(store.previewRecovery(detachedId, destination, 'salvage', recoveryFilesystem([])), RecoveryConflictError);
    await assert.rejects(
      store.previewRecovery(
        detachedId,
        { id: 'not-current', label: 'Elsewhere', uri: vscode.Uri.parse('file:///elsewhere') },
        'reattach-only',
        recoveryFilesystem([])
      ),
      RecoveryConflictError
    );

    assert.strictEqual(JSON.stringify(store.getView()), before);
    assert.strictEqual(state.updateCallCount, writes);
  });

  test('recovery rejects an invalid canonical destination and a stale preview without mutation', async () => {
    const { state, store, detachedId } = await recoveryStore();
    await assert.rejects(
      store.previewRecovery(
        detachedId,
        { id: destination.id, label: destination.label, uri: vscode.Uri.parse('file:///new/repo?query=bad') },
        'reattach-only',
        recoveryFilesystem([])
      ),
      RecoveryConflictError
    );
    await assert.rejects(
      store.previewRecovery(
        detachedId,
        { id: destination.id, label: destination.label, uri: vscode.Uri.parse('file:///new/repo#fragment') },
        'reattach-only',
        recoveryFilesystem([])
      ),
      RecoveryConflictError
    );
    const preview = await store.previewRecovery(detachedId, destination, 'reattach-only', recoveryFilesystem([]));
    await store.reconcileRoots([destination, { id: 'other', label: 'Other', uri: vscode.Uri.parse('file:///other') }]);
    const beforeCommit = JSON.stringify(store.getView());
    const writes = state.updateCallCount;

    await assert.rejects(store.commitRecovery(preview.token), StaleRecoveryPreviewError);

    assert.strictEqual(JSON.stringify(store.getView()), beforeCommit);
    assert.strictEqual(state.updateCallCount, writes);
  });

  test('a content mutation in another attached partition makes a recovery preview stale', async () => {
    const otherRoot: RootCandidate = { id: 'other-root', label: 'Other', uri: vscode.Uri.parse('file:///other') };
    const snapshot = recoverySnapshot();
    snapshot.partitions.push({
      id: '00000000-0000-4000-8000-000000000003',
      attachment: { rootUri: otherRoot.uri.toString(), canonicalRootUri: otherRoot.uri.toString() },
      lastKnownRootUri: otherRoot.uri.toString(), canonicalLastKnownRootUri: otherRoot.uri.toString(),
      replacementEligible: true, data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
    });
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
    const store = await WorkspaceBookmarkStore.create({ state, roots: [destination, otherRoot], output: new FakeOutput(), createId: ids() });
    const preview = await store.previewRecovery(
      '00000000-0000-4000-8000-000000000001', destination, 'reattach-only', recoveryFilesystem([])
    );

    await store.addItem(
      { kind: 'partition', partitionId: '00000000-0000-4000-8000-000000000003' },
      { type: 'file', uri: 'file:///other/changed.ts' }
    );

    await assert.rejects(store.commitRecovery(preview.token), StaleRecoveryPreviewError);
  });

  test('an in-flight salvage preview cannot become valid after a persisted mutation', async () => {
    const otherRoot: RootCandidate = { id: 'other-root', label: 'Other', uri: vscode.Uri.parse('file:///other') };
    const snapshot = recoverySnapshot();
    snapshot.partitions.push({
      id: '00000000-0000-4000-8000-000000000003',
      attachment: { rootUri: otherRoot.uri.toString(), canonicalRootUri: otherRoot.uri.toString() },
      lastKnownRootUri: otherRoot.uri.toString(), canonicalLastKnownRootUri: otherRoot.uri.toString(),
      replacementEligible: true, data: { version: 2, items: [], collections: [] }, mirror: { dirty: false }
    });
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
    const store = await WorkspaceBookmarkStore.create({ state, roots: [destination, otherRoot], output: new FakeOutput(), createId: ids() });
    const fs = new DeferredRecoveryFileSystem();
    const previewPromise = store.previewRecovery(
      '00000000-0000-4000-8000-000000000001', destination, 'salvage', fs
    );
    await fs.statStarted;
    await store.addItem(
      { kind: 'partition', partitionId: '00000000-0000-4000-8000-000000000003' },
      { type: 'file', uri: 'file:///other/changed.ts' }
    );
    fs.release();
    const outcome = await previewPromise.then(
      (preview) => ({ preview }),
      (error: unknown) => ({ error })
    );
    if ('preview' in outcome) {
      await assert.rejects(store.commitRecovery(outcome.preview.token), StaleRecoveryPreviewError);
    } else {
      assert.ok(outcome.error instanceof StaleRecoveryPreviewError);
    }

    assert.strictEqual(store.getView().detached[0].partitionId, '00000000-0000-4000-8000-000000000001');
    assert.strictEqual(state.updateCallCount, 1);
  });

  test('disposing during deferred salvage rejects without issuing a recovery token', async () => {
    const { store, detachedId } = await recoveryStore();
    const fs = new DeferredRecoveryFileSystem();
    const preview = store.previewRecovery(detachedId, destination, 'salvage', fs);
    await fs.statStarted;

    store.dispose();
    fs.release();

    await assert.rejects(preview, WorkspaceDataUnavailableError);
    const pendingRecoveries = (store as unknown as { pendingRecoveries: ReadonlyMap<string, unknown> }).pendingRecoveries;
    assert.strictEqual(pendingRecoveries.size, 0);
  });

  test('salvage marks recovered mirror state dirty while preserving collections, Unassigned data, and URI query fragments', async () => {
    const snapshot = recoverySnapshot();
    const detached = snapshot.partitions[0];
    const sourceUri = vscode.Uri.parse('file:///old/repo/src/a.ts?view=full#anchor');
    const rebasedUri = vscode.Uri.parse('file:///new/repo/src/a.ts?view=full#anchor');
    detached.data.collections.push({ id: '00000000-0000-4000-8000-000000000021', name: 'Keep', order: 0 });
    detached.data.items[0].collectionId = '00000000-0000-4000-8000-000000000021';
    detached.data.items[0].uri = sourceUri.toString();
    detached.mirror = { dirty: false, lastSuccessfulHash: 'a'.repeat(64) };
    snapshot.unassigned.items.push({
      id: '00000000-0000-4000-8000-000000000031', type: 'file', uri: 'file:///unassigned/keep.ts', collectionId: null, order: 0
    });
    const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
    const store = await WorkspaceBookmarkStore.create({ state, roots: [destination], output: new FakeOutput(), createId: ids() });
    const preview = await store.previewRecovery(
      detached.id,
      destination,
      'salvage',
      recoveryFilesystem([rebasedUri.toString()])
    );

    await store.commitRecovery(preview.token);

    const persisted = state.get<WorkspacePartitionSnapshot>(WORKSPACE_PARTITION_STORAGE_KEY)!;
    const recovered = persisted.partitions.find((partition) => partition.id === detached.id)!;
    assert.strictEqual(recovered.mirror.dirty, true);
    assert.strictEqual(recovered.mirror.lastSuccessfulHash, 'a'.repeat(64));
    assert.strictEqual(recovered.data.collections[0].name, 'Keep');
    const rewrittenUri = vscode.Uri.parse(recovered.data.items[0].uri);
    assert.strictEqual(rewrittenUri.path, rebasedUri.path);
    assert.strictEqual(rewrittenUri.query, sourceUri.query);
    assert.strictEqual(rewrittenUri.fragment, sourceUri.fragment);
    assert.deepStrictEqual(persisted.unassigned, snapshot.unassigned);
  });

  test('failed recovery persistence rolls back and leaves the current preview retryable', async () => {
    const { state, store, detachedId } = await recoveryStore();
    const preview = await store.previewRecovery(detachedId, destination, 'reattach-only', recoveryFilesystem([]));
    state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;

    await assert.rejects(store.commitRecovery(preview.token));
    assert.strictEqual(store.getView().detached[0].partitionId, detachedId);

    await store.commitRecovery(preview.token);
    assert.strictEqual(store.getView().attached[0].partitionId, detachedId);
  });
});
