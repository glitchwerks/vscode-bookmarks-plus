import * as assert from 'assert';
import { BookmarkData } from '../../types';
import {
  WorkspacePartition,
  WorkspacePartitionSnapshot,
  emptyWorkspacePartitionSnapshot,
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
});
