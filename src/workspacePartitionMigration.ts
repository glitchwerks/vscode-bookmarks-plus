import * as vscode from 'vscode';
import { OutputSink } from './bookmarkStore';
import { UnsupportedSchemaVersionError, migrateBookmarkData } from './migrations';
import { normalizeBookmarkData } from './normalize';
import {
  RootCandidate,
  canonicalizeRootUri,
  findCanonicalRootCollisions,
  findDeepestRoot
} from './rootUri';
import {
  BookmarkData,
  BookmarkItem,
  emptyBookmarkData,
  isStrictBookmarkData
} from './types';
import {
  WORKSPACE_PARTITION_STORAGE_KEY,
  WorkspacePartition,
  WorkspacePartitionSnapshot,
  cloneWorkspacePartitionSnapshot,
  validateWorkspacePartitionSnapshot
} from './workspacePartitionTypes';

const LEGACY_STORAGE_KEY = 'bookmarks.data';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ID_ATTEMPTS = 10_000;

export interface PartitionMigrationDiagnostics {
  readonly sourceItems: number;
  readonly sourceCollections: number;
  readonly partitions: number;
  readonly splitCollections: number;
  readonly unassignedItems: number;
  readonly unassignedCollections: number;
}

export interface LoadedWorkspaceSnapshot {
  readonly kind: 'ready';
  readonly snapshot: WorkspacePartitionSnapshot;
  readonly diagnostics?: PartitionMigrationDiagnostics;
}

export interface UnavailableWorkspaceSnapshot {
  readonly kind: 'unavailable';
  readonly reason: string;
}

interface OwnerData {
  readonly data: BookmarkData;
}

interface PartitionOwner extends OwnerData {
  readonly canonicalRootUri: string;
  readonly partition: WorkspacePartition;
}

interface AssignedItem {
  readonly owner: OwnerData;
  readonly sourceCollectionId: string | null;
  readonly sourceIndex: number;
  readonly item: BookmarkItem;
}

/**
 * Splits flat legacy workspace data into root-owned partitions and an Unassigned bucket.
 * The transformation is pure and leaves its input unchanged.
 */
export function partitionLegacyData(
  data: BookmarkData,
  roots: readonly RootCandidate[],
  createId: () => string
): { snapshot: WorkspacePartitionSnapshot; diagnostics: PartitionMigrationDiagnostics } {
  const migrated = migrateBookmarkData(data);
  if (!isStrictBookmarkData(migrated)) {
    throw new Error('Legacy bookmark data is malformed.');
  }

  const usedIds = new Set<string>();
  const collisions = new Set(findCanonicalRootCollisions(roots).keys());
  const partitionOwners: PartitionOwner[] = [];
  const ownersByCanonicalUri = new Map<string, PartitionOwner>();

  for (const root of roots) {
    const canonicalRootUri = canonicalizeRootUri(root.uri);
    if (collisions.has(canonicalRootUri)) {
      continue;
    }

    const rootUri = root.uri.toString();
    const partition: WorkspacePartition = {
      id: allocateId(createId, usedIds),
      attachment: { rootUri, canonicalRootUri },
      lastKnownRootUri: rootUri,
      canonicalLastKnownRootUri: canonicalRootUri,
      replacementEligible: true,
      data: emptyBookmarkData(),
      mirror: { dirty: false }
    };
    const owner: PartitionOwner = { canonicalRootUri, partition, data: partition.data };
    partitionOwners.push(owner);
    ownersByCanonicalUri.set(canonicalRootUri, owner);
  }

  const unassigned: OwnerData = { data: emptyBookmarkData() };
  const activeRoots = roots.filter((root) => !collisions.has(canonicalizeRootUri(root.uri)));
  const assignedItems: AssignedItem[] = migrated.items.map((sourceItem, sourceIndex) => {
    const root = findDeepestRoot(vscode.Uri.parse(sourceItem.uri), activeRoots);
    const owner = root === undefined ? unassigned : ownersByCanonicalUri.get(root.canonicalUri) ?? unassigned;
    const item: BookmarkItem = {
      ...sourceItem,
      id: allocateId(createId, usedIds, sourceItem.id),
      collectionId: null
    };
    owner.data.items.push(item);
    return { owner, sourceCollectionId: sourceItem.collectionId, sourceIndex, item };
  });

  const sourceCollections = new Map<string, number>();
  migrated.collections.forEach((collection, index) => {
    if (!sourceCollections.has(collection.id)) {
      sourceCollections.set(collection.id, index);
    }
  });
  const membersByCollection = new Map<number, AssignedItem[]>();
  for (const assigned of assignedItems) {
    if (assigned.sourceCollectionId === null) {
      continue;
    }
    const collectionIndex = sourceCollections.get(assigned.sourceCollectionId);
    if (collectionIndex === undefined) {
      continue;
    }
    const members = membersByCollection.get(collectionIndex) ?? [];
    members.push(assigned);
    membersByCollection.set(collectionIndex, members);
  }

  let splitCollections = 0;
  for (const [collectionIndex, sourceCollection] of migrated.collections.entries()) {
    const members = [...(membersByCollection.get(collectionIndex) ?? [])]
      .sort((left, right) => left.item.order - right.item.order || left.sourceIndex - right.sourceIndex);
    const byOwner = new Map<OwnerData, AssignedItem[]>();
    for (const member of members) {
      const group = byOwner.get(member.owner) ?? [];
      group.push(member);
      byOwner.set(member.owner, group);
    }

    if (byOwner.size === 0) {
      addCollection(unassigned, sourceCollection, allocateId(createId, usedIds, sourceCollection.id));
      continue;
    }

    const isSplit = byOwner.size > 1;
    if (isSplit) {
      splitCollections++;
    }
    for (const [owner, group] of byOwner) {
      const collectionId = allocateId(createId, usedIds, sourceCollection.id, isSplit);
      addCollection(owner, sourceCollection, collectionId);
      for (const member of group) {
        member.item.collectionId = collectionId;
      }
    }
  }

  const partitions = partitionOwners.map(({ partition }) => ({
    ...partition,
    data: normalizeBookmarkData(partition.data).data
  }));
  const normalizedUnassigned = normalizeBookmarkData(unassigned.data).data;
  const snapshot: WorkspacePartitionSnapshot = {
    version: 1,
    partitions,
    unassigned: normalizedUnassigned
  };
  const validation = validateWorkspacePartitionSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`Partition migration produced invalid state: ${validation.reason ?? 'unknown reason'}.`);
  }

  return {
    snapshot,
    diagnostics: {
      sourceItems: migrated.items.length,
      sourceCollections: migrated.collections.length,
      partitions: partitions.length,
      splitCollections,
      unassignedItems: normalizedUnassigned.items.length,
      unassignedCollections: normalizedUnassigned.collections.length
    }
  };
}

/**
 * Loads an existing valid workspace snapshot, or migrates legacy workspace data exactly once.
 * Snapshot persistence always completes before legacy state is removed.
 */
export async function loadOrMigrateWorkspaceSnapshot(
  state: vscode.Memento,
  roots: readonly RootCandidate[],
  createId: () => string,
  output: OutputSink
): Promise<LoadedWorkspaceSnapshot | UnavailableWorkspaceSnapshot> {
  const storedSnapshot = state.get<unknown>(WORKSPACE_PARTITION_STORAGE_KEY);
  if (storedSnapshot !== undefined) {
    const validation = validateWorkspacePartitionSnapshot(storedSnapshot);
    if (!validation.ok) {
      return unavailable(output, validation.reason ?? 'snapshot is invalid');
    }
    return {
      kind: 'ready',
      snapshot: cloneWorkspacePartitionSnapshot(storedSnapshot as WorkspacePartitionSnapshot)
    };
  }

  const storedLegacy = state.get<unknown>(LEGACY_STORAGE_KEY);
  if (storedLegacy !== undefined && storedLegacy !== null && !isStrictBookmarkData(storedLegacy)) {
    return unavailable(output, 'legacy data is malformed');
  }

  let result: { snapshot: WorkspacePartitionSnapshot; diagnostics: PartitionMigrationDiagnostics };
  try {
    result = partitionLegacyData(
      storedLegacy === undefined || storedLegacy === null ? emptyBookmarkData() : storedLegacy,
      roots,
      createId
    );
  } catch (error: unknown) {
    const reason = error instanceof UnsupportedSchemaVersionError
      ? 'legacy schema version is unsupported'
      : 'legacy migration failed';
    return unavailable(output, reason);
  }

  try {
    await state.update(WORKSPACE_PARTITION_STORAGE_KEY, result.snapshot);
  } catch (error: unknown) {
    output.appendLine('Workspace partition migration: snapshot write failed.');
    throw error;
  }

  if (storedLegacy !== undefined && storedLegacy !== null) {
    try {
      await state.update(LEGACY_STORAGE_KEY, undefined);
    } catch (error: unknown) {
      output.appendLine('Workspace partition migration: legacy cleanup failed after snapshot commit.');
      throw error;
    }
  }

  logDiagnostics(output, result.diagnostics);
  return { kind: 'ready', snapshot: result.snapshot, diagnostics: result.diagnostics };
}

function addCollection(
  owner: OwnerData,
  source: BookmarkData['collections'][number],
  id: string
): void {
  owner.data.collections.push({ ...source, id });
}

function allocateId(
  createId: () => string,
  usedIds: Set<string>,
  existingId?: string,
  forceNew = false
): string {
  if (!forceNew && isUuid(existingId) && !usedIds.has(existingId)) {
    usedIds.add(existingId);
    return existingId;
  }

  for (let attempts = 0; attempts < MAX_ID_ATTEMPTS; attempts++) {
    const id = createId();
    if (isUuid(id) && !usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  throw new Error('Unable to allocate a unique workspace partition identifier.');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function unavailable(output: OutputSink, reason: string): UnavailableWorkspaceSnapshot {
  output.appendLine(`Workspace partition migration: workspace data unavailable (${reason}).`);
  return { kind: 'unavailable', reason };
}

function logDiagnostics(output: OutputSink, diagnostics: PartitionMigrationDiagnostics): void {
  output.appendLine(
    'Workspace partition migration: '
    + `sourceItems=${diagnostics.sourceItems}, sourceCollections=${diagnostics.sourceCollections}, `
    + `partitions=${diagnostics.partitions}, splitCollections=${diagnostics.splitCollections}, `
    + `unassignedItems=${diagnostics.unassignedItems}, unassignedCollections=${diagnostics.unassignedCollections}.`
  );
}
