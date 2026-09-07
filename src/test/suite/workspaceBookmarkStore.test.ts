import * as assert from 'assert';
import * as vscode from 'vscode';
import { DuplicateBookmarkError } from '../../bookmarkStore';
import { BookmarkItem } from '../../types';
import {
  PartitionBoundaryError,
  WorkspaceBookmarkStore,
  WorkspaceDataUnavailableError
} from '../../workspaceBookmarkStore';
import { RootCandidate } from '../../rootUri';
import {
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
