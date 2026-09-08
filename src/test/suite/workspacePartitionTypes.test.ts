import * as assert from 'assert';
import * as vscode from 'vscode';
import { WorkspaceBookmarkStore, WorkspaceDataUnavailableError } from '../../workspaceBookmarkStore';
import { WorkspaceMirrorCoordinator } from '../../workspaceMirrorCoordinator';
import { FakeMemento, FakeOutput, FakePartitionMirrorResources } from './fixtures';
import { BookmarkData } from '../../types';
import {
  WorkspacePartition,
  WorkspacePartitionSnapshot,
  WORKSPACE_PARTITION_STORAGE_KEY,
  cloneWorkspacePartitionSnapshot,
  emptyWorkspacePartitionSnapshot,
  ownerKey,
  validateWorkspacePartitionSnapshot
} from '../../workspacePartitionTypes';

const PARTITION_ID = '10000000-0000-4000-8000-000000000001';
const PARTITION_COLLECTION_ID = '20000000-0000-4000-8000-000000000001';
const PARTITION_ITEM_ID = '30000000-0000-4000-8000-000000000001';
const UNASSIGNED_COLLECTION_ID = '20000000-0000-4000-8000-000000000002';
const UNASSIGNED_ITEM_ID = '30000000-0000-4000-8000-000000000002';

interface MutableSnapshot {
  version: number;
  partitions: WorkspacePartition[];
  unassigned: BookmarkData;
}

function seededSnapshot(): WorkspacePartitionSnapshot {
  return {
    version: 1,
    partitions: [{
      id: PARTITION_ID,
      attachment: {
        rootUri: 'file:///workspace/project',
        canonicalRootUri: 'file:///workspace/project'
      },
      lastKnownRootUri: 'file:///workspace/project',
      canonicalLastKnownRootUri: 'file:///workspace/project',
      replacementEligible: true,
      data: {
        version: 2,
        collections: [{ id: PARTITION_COLLECTION_ID, name: 'Project', order: 0 }],
        items: [{
          id: PARTITION_ITEM_ID,
          type: 'file',
          uri: 'file:///workspace/project/src/index.ts',
          collectionId: PARTITION_COLLECTION_ID,
          order: 0
        }]
      },
      mirror: { dirty: false }
    }],
    unassigned: {
      version: 2,
      collections: [{ id: UNASSIGNED_COLLECTION_ID, name: 'Unassigned', order: 0 }],
      items: [{
        id: UNASSIGNED_ITEM_ID,
        type: 'file',
        uri: 'file:///outside/file.ts',
        collectionId: UNASSIGNED_COLLECTION_ID,
        order: 0
      }]
    }
  };
}

suite('workspacePartitionTypes', () => {
  for (const field of ['attachment', 'lastKnownRootUri'] as const) {
    test(`rejects scheme-qualified relative persisted ${field} metadata`, () => {
      const snapshot = seededSnapshot();
      const partition = snapshot.partitions[0];
      if (field === 'attachment') {
        partition.attachment = { rootUri: 'custom:relative/repo', canonicalRootUri: 'custom://relative/repo' };
      } else {
        partition.lastKnownRootUri = 'custom:relative/repo';
        partition.canonicalLastKnownRootUri = 'custom://relative/repo';
      }
      assert.strictEqual(validateWorkspacePartitionSnapshot(snapshot).ok, false);
    });
  }

  test('rejects distinct partitions attached to the same canonical root', () => {
    const snapshot = seededSnapshot();
    snapshot.partitions.push({
      ...snapshot.partitions[0], id: '10000000-0000-4000-8000-000000000002',
      attachment: { rootUri: 'FILE:///workspace/project/', canonicalRootUri: 'file:///workspace/project' },
      data: { version: 2, items: [], collections: [] }
    });
    assert.strictEqual(validateWorkspacePartitionSnapshot(snapshot).ok, false);
  });

  test('allows shared last-known identities when only one partition is attached', () => {
    const snapshot = seededSnapshot();
    snapshot.partitions.push({
      ...snapshot.partitions[0], id: '10000000-0000-4000-8000-000000000002', attachment: null,
      data: { version: 2, items: [], collections: [] }
    });
    assert.deepStrictEqual(validateWorkspacePartitionSnapshot(snapshot), { ok: true });
    snapshot.partitions[0].attachment = null;
    assert.deepStrictEqual(validateWorkspacePartitionSnapshot(snapshot), { ok: true });
  });

  for (const malformed of ['duplicate attached roots', 'relative attachment', 'relative last-known root']) {
    test(`preserves ${malformed} snapshot as unavailable without publishing mirrors`, async () => {
      const snapshot = seededSnapshot();
      if (malformed === 'duplicate attached roots') {
        snapshot.partitions.push({ ...snapshot.partitions[0], id: '10000000-0000-4000-8000-000000000002',
          data: { version: 2, items: [], collections: [] } });
      } else if (malformed === 'relative attachment') {
        snapshot.partitions[0].attachment = { rootUri: 'custom:relative/repo', canonicalRootUri: 'custom://relative/repo' };
      } else {
        snapshot.partitions[0].lastKnownRootUri = 'custom:relative/repo';
        snapshot.partitions[0].canonicalLastKnownRootUri = 'custom://relative/repo';
      }
      const before = JSON.stringify(snapshot);
      const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
      const output = new FakeOutput();
      const roots = [{ id: 'project', label: 'Project', uri: vscode.Uri.parse('file:///workspace/project') }];
      const store = await WorkspaceBookmarkStore.create({ state, roots, output });
      const resources: FakePartitionMirrorResources[] = [];
      const coordinator = new WorkspaceMirrorCoordinator({ store, output, createResources: () => {
        const resource = new FakePartitionMirrorResources(); resources.push(resource); return resource;
      } });
      try {
        assert.strictEqual(store.getView().kind, 'unavailable');
        assert.deepStrictEqual(store.getView().attached, []);
        await coordinator.reconcileBindings();
        assert.strictEqual(resources.length, 0);
        await assert.rejects(store.reconcileRoots(roots), WorkspaceDataUnavailableError);
        assert.strictEqual(state.updateCallCount, 0);
        assert.strictEqual(JSON.stringify(state.get(WORKSPACE_PARTITION_STORAGE_KEY)), before);
      } finally { coordinator.dispose(); store.dispose(); }
    });
  }

  for (const version of [3, 999, 1.5, 0, -1, NaN, Infinity]) {
    for (const owner of ['attached', 'detached', 'unassigned']) {
      test(`rejects unsupported ${owner} content version ${version}`, () => {
        const snapshot = seededSnapshot();
        if (owner === 'detached') snapshot.partitions[0].attachment = null;
        (owner === 'unassigned' ? snapshot.unassigned : snapshot.partitions[0].data).version = version;
        assert.strictEqual(validateWorkspacePartitionSnapshot(snapshot).ok, false);
      });
    }
  }

  test('accepts the empty current snapshot', () => {
    assert.deepStrictEqual(validateWorkspacePartitionSnapshot(emptyWorkspacePartitionSnapshot()), { ok: true });
  });

  for (const [name, mutate] of [
    ['future outer version', (value: MutableSnapshot) => { value.version = 2; }],
    ['duplicate partition id', (value: MutableSnapshot) => { value.partitions.push(value.partitions[0]); }],
    ['duplicate item id across owners', (value: MutableSnapshot) => {
      value.unassigned.items.push({ ...value.partitions[0].data.items[0] });
    }],
    ['cross-owner collection reference', (value: MutableSnapshot) => {
      value.partitions[0].data.items[0].collectionId = value.unassigned.collections[0].id;
    }]
  ] as const) {
    test(`rejects ${name}`, () => {
      const value: MutableSnapshot = seededSnapshot();
      mutate(value);
      assert.strictEqual(validateWorkspacePartitionSnapshot(value).ok, false);
    });
  }

  test('accepts the lowercase SHA-256 mirror hash produced by the mirror writer', () => {
    const value: MutableSnapshot = seededSnapshot();
    value.partitions[0].mirror.lastSuccessfulHash = 'a'.repeat(64);
    assert.deepStrictEqual(validateWorkspacePartitionSnapshot(value), { ok: true });
  });

  for (const hash of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
    test(`rejects malformed mirror hash ${JSON.stringify(hash)}`, () => {
      const value: MutableSnapshot = seededSnapshot();
      value.partitions[0].mirror.lastSuccessfulHash = hash;
      assert.strictEqual(validateWorkspacePartitionSnapshot(value).ok, false);
    });
  }

  for (const [name, mutate] of [
    ['malformed owner content', (value: MutableSnapshot) => {
      value.unassigned.items[0] = { type: 'invalid' } as unknown as BookmarkData['items'][number];
    }],
    ['an invalid UUID', (value: MutableSnapshot) => { value.partitions[0].id = 'not-a-uuid'; }],
    ['an identifier collision across item and partition kinds', (value: MutableSnapshot) => {
      value.unassigned.collections[0].id = PARTITION_ID;
    }],
    ['inconsistent attachment canonical metadata', (value: MutableSnapshot) => {
      value.partitions[0].attachment!.canonicalRootUri = 'file:///workspace/other';
    }],
    ['inconsistent last-known root canonical metadata', (value: MutableSnapshot) => {
      value.partitions[0].canonicalLastKnownRootUri = 'file:///workspace/other';
    }],
    ['a non-boolean mirror dirty value', (value: MutableSnapshot) => {
      value.partitions[0].mirror.dirty = 'true' as unknown as boolean;
    }],
    ['a non-string mirror hash value', (value: MutableSnapshot) => {
      value.partitions[0].mirror.lastSuccessfulHash = 1 as unknown as string;
    }]
  ] as const) {
    test(`rejects ${name}`, () => {
      const value: MutableSnapshot = seededSnapshot();
      mutate(value);
      assert.strictEqual(validateWorkspacePartitionSnapshot(value).ok, false);
    });
  }

  test('clones nested snapshot data without sharing mutable records', () => {
    const source = seededSnapshot();
    const clone = cloneWorkspacePartitionSnapshot(source);
    clone.partitions[0].attachment!.rootUri = 'file:///workspace/replacement';
    clone.partitions[0].data.items[0].description = 'changed';
    clone.partitions[0].mirror.dirty = true;
    clone.unassigned.collections[0].name = 'Changed';

    assert.strictEqual(source.partitions[0].attachment!.rootUri, 'file:///workspace/project');
    assert.strictEqual(source.partitions[0].data.items[0].description, undefined);
    assert.strictEqual(source.partitions[0].mirror.dirty, false);
    assert.strictEqual(source.unassigned.collections[0].name, 'Unassigned');
  });

  test('returns stable keys for each workspace owner kind', () => {
    assert.strictEqual(ownerKey({ kind: 'partition', partitionId: PARTITION_ID }), `partition:${PARTITION_ID}`);
    assert.strictEqual(ownerKey({ kind: 'unassigned' }), 'unassigned');
  });
});
