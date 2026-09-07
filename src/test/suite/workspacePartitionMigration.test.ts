import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkData } from '../../types';
import { RootCandidate } from '../../rootUri';
import {
  WORKSPACE_PARTITION_STORAGE_KEY,
  WorkspacePartitionSnapshot,
  validateWorkspacePartitionSnapshot
} from '../../workspacePartitionTypes';
import {
  loadOrMigrateWorkspaceSnapshot,
  partitionLegacyData
} from '../../workspacePartitionMigration';
import { FakeMemento, FakeOutput } from './fixtures';

const LEGACY_STORAGE_KEY = 'bookmarks.data';

function deterministicIds(): () => string {
  let next = 1;
  return () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, '0')}`;
}

function roots(): readonly RootCandidate[] {
  return [
    { id: 'root-a', label: 'A', uri: vscode.Uri.parse('file:///workspace/a') },
    { id: 'root-b', label: 'B', uri: vscode.Uri.parse('file:///workspace/b') }
  ];
}

function mixedLegacyData(): BookmarkData {
  return {
    version: 2,
    collections: [
      { id: 'mixed', name: 'Mixed', description: 'split me', order: 0 },
      { id: 'empty', name: 'Empty', order: 1 }
    ],
    items: [
      { id: 'mixed-a', type: 'file', uri: 'file:///workspace/a/one.ts', collectionId: 'mixed', order: 2 },
      { id: 'mixed-b', type: 'file', uri: 'file:///workspace/b/two.ts', collectionId: 'mixed', order: 1 },
      { id: 'mixed-out', type: 'file', uri: 'file:///outside/three.ts', collectionId: 'mixed', order: 0 }
    ]
  };
}

function legacyData(): BookmarkData {
  return {
    version: 2,
    collections: [
      { id: 'root-only', name: 'Root only', order: 0 },
      { id: 'unmatched-only', name: 'Unmatched only', order: 1 },
      { id: 'empty', name: 'Empty', order: 2 }
    ],
    items: [
      { id: 'a-in-collection', type: 'file', uri: 'file:///workspace/a/grouped.ts', collectionId: 'root-only', order: 0 },
      { id: 'out-in-collection', type: 'file', uri: 'file:///outside/grouped.ts', collectionId: 'unmatched-only', order: 0 },
      { id: 'a-ungrouped', type: 'file', uri: 'file:///workspace/a/ungrouped.ts', collectionId: null, order: 1 }
    ]
  };
}

function allIds(snapshot: WorkspacePartitionSnapshot): string[] {
  return [
    ...snapshot.partitions.flatMap((partition) => [
      partition.id,
      ...partition.data.collections.map((collection) => collection.id),
      ...partition.data.items.map((item) => item.id)
    ]),
    ...snapshot.unassigned.collections.map((collection) => collection.id),
    ...snapshot.unassigned.items.map((item) => item.id)
  ];
}

suite('workspacePartitionMigration', () => {
  test('splits a mixed collection and preserves unmatched data', () => {
    const result = partitionLegacyData(mixedLegacyData(), roots(), deterministicIds());

    assert.deepStrictEqual(result.snapshot.partitions.map((partition) => partition.data.items.length), [1, 1]);
    assert.strictEqual(result.snapshot.unassigned.items.length, 1);
    assert.strictEqual(result.snapshot.unassigned.collections.length, 2);
    assert.strictEqual(result.diagnostics.splitCollections, 1);
    assert.strictEqual(new Set(allIds(result.snapshot)).size, allIds(result.snapshot).length);
    assert.deepStrictEqual(validateWorkspacePartitionSnapshot(result.snapshot), { ok: true });
  });

  test('keeps empty collections, unmatched collections, and ungrouped items with their inferred owner', () => {
    const result = partitionLegacyData(legacyData(), roots(), deterministicIds());
    const rootA = result.snapshot.partitions[0];

    assert.deepStrictEqual(rootA.data.items.map((item) => item.collectionId === null), [false, true]);
    assert.strictEqual(result.snapshot.unassigned.items.length, 1);
    assert.deepStrictEqual(
      result.snapshot.unassigned.collections.map((collection) => collection.name),
      ['Unmatched only', 'Empty']
    );
    assert.strictEqual(result.diagnostics.unassignedItems, 1);
    assert.strictEqual(result.diagnostics.unassignedCollections, 2);
  });

  test('assigns a nested item to the deepest root rather than root order', () => {
    const nestedRoots: readonly RootCandidate[] = [
      { id: 'parent', label: 'Parent', uri: vscode.Uri.parse('file:///workspace') },
      { id: 'child', label: 'Child', uri: vscode.Uri.parse('file:///workspace/a') }
    ];
    const result = partitionLegacyData({
      version: 2,
      collections: [],
      items: [{ id: 'item', type: 'file', uri: 'file:///workspace/a/child.ts', collectionId: null, order: 0 }]
    }, nestedRoots, deterministicIds());

    assert.deepStrictEqual(result.snapshot.partitions.map((partition) => partition.data.items.length), [0, 1]);
  });

  test('replaces invalid or colliding identifiers and rebinds item collection references', () => {
    const validId = '10000000-0000-4000-8000-000000000001';
    const result = partitionLegacyData({
      version: 2,
      collections: [{ id: validId, name: 'One', order: 0 }],
      items: [
        { id: validId, type: 'file', uri: 'file:///workspace/a/one.ts', collectionId: validId, order: 0 },
        { id: validId, type: 'file', uri: 'file:///workspace/a/two.ts', collectionId: validId, order: 1 }
      ]
    }, roots(), deterministicIds());
    const partition = result.snapshot.partitions[0];

    assert.deepStrictEqual(validateWorkspacePartitionSnapshot(result.snapshot), { ok: true });
    assert.strictEqual(new Set(allIds(result.snapshot)).size, allIds(result.snapshot).length);
    assert.ok(partition.data.items.every((item) => item.collectionId === partition.data.collections[0].id));
  });

  test('does not delete legacy state when the new snapshot write fails', async () => {
    const state = new FakeMemento({ [LEGACY_STORAGE_KEY]: legacyData() });
    state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;

    await assert.rejects(loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), new FakeOutput()));

    assert.deepStrictEqual(state.get(LEGACY_STORAGE_KEY), legacyData());
    assert.strictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), undefined);
  });

  test('uses the new snapshot after legacy cleanup failure', async () => {
    const state = new FakeMemento({ [LEGACY_STORAGE_KEY]: legacyData() });
    state.failUpdateForKey = LEGACY_STORAGE_KEY;
    const output = new FakeOutput();

    await assert.rejects(loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), output));
    const persisted = state.get(WORKSPACE_PARTITION_STORAGE_KEY);
    const retried = await loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), new FakeOutput());

    assert.strictEqual(retried.kind, 'ready');
    assert.deepStrictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), persisted);
    assert.deepStrictEqual(output.lines, [
      'Workspace partition migration: legacy cleanup failed after snapshot commit.'
    ]);
  });

  test('prefers an existing valid snapshot without inspecting or rewriting legacy data', async () => {
    const snapshot = partitionLegacyData(legacyData(), roots(), deterministicIds()).snapshot;
    const state = new FakeMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot,
      [LEGACY_STORAGE_KEY]: { version: 99, items: [], collections: [] }
    });

    const result = await loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), new FakeOutput());

    assert.strictEqual(result.kind, 'ready');
    assert.strictEqual(state.updateCallCount, 0);
    assert.deepStrictEqual(state.get(LEGACY_STORAGE_KEY), { version: 99, items: [], collections: [] });
  });

  test('leaves malformed or future persisted values unavailable without logging bookmark content', async () => {
    const secret = 'file:///secret/project/very-private.ts';
    const state = new FakeMemento({
      [WORKSPACE_PARTITION_STORAGE_KEY]: { version: 2, partitions: [], unassigned: { secret } },
      [LEGACY_STORAGE_KEY]: { version: 99, items: [], collections: [] }
    });
    const output = new FakeOutput();

    const result = await loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), output);

    assert.deepStrictEqual(result, { kind: 'unavailable', reason: 'snapshot version is unsupported' });
    assert.strictEqual(state.updateCallCount, 0);
    assert.ok(output.lines.every((line) => !line.includes(secret)));
  });

  test('rejects malformed or future legacy data without publishing a snapshot or leaking descriptors', async () => {
    const secret = 'file:///secret/project/very-private.ts';
    const state = new FakeMemento({
      [LEGACY_STORAGE_KEY]: { version: 99, items: [{ uri: secret }], collections: [] }
    });
    const output = new FakeOutput();

    const result = await loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), output);

    assert.strictEqual(result.kind, 'unavailable');
    assert.strictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), undefined);
    assert.deepStrictEqual(state.get(LEGACY_STORAGE_KEY), { version: 99, items: [{ uri: secret }], collections: [] });
    assert.ok(output.lines.every((line) => !line.includes(secret)));
  });
});
