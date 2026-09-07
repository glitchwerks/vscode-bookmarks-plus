import * as vscode from 'vscode';
import { canonicalizeRootUri } from './rootUri';
import { RootCandidate } from './rootUri';
import {
  BookmarkData,
  emptyBookmarkData,
  isStrictBookmarkData
} from './types';

export const WORKSPACE_PARTITION_STORAGE_KEY = 'bookmarks.workspacePartitions';
export const WORKSPACE_PARTITION_SCHEMA_VERSION = 1;

export type WorkspaceOwnerRef =
  | { readonly kind: 'partition'; readonly partitionId: string }
  | { readonly kind: 'unassigned' };

export interface WorkspacePartitionSnapshot {
  version: 1;
  partitions: WorkspacePartition[];
  unassigned: BookmarkData;
}

export interface WorkspacePartition {
  id: string;
  attachment: {
    rootUri: string;
    canonicalRootUri: string;
  } | null;
  lastKnownRootUri: string;
  canonicalLastKnownRootUri: string;
  replacementEligible: boolean;
  data: BookmarkData;
  mirror: {
    lastSuccessfulHash?: string;
    dirty: boolean;
  };
}

export interface SnapshotValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Summarizes attachment changes made while reconciling the current workspace roots. */
export interface RootReconcileResult {
  readonly attachedPartitionIds: readonly string[];
  readonly detachedPartitionIds: readonly string[];
  readonly unavailableCanonicalRoots: readonly string[];
}

/** Adds the current root ordering and labels to a reconciliation result. */
export interface PartitionLifecycleChange extends RootReconcileResult {
  readonly currentRoots: readonly RootCandidate[];
}

/** Selects whether recovery only reattaches or also salvages resolvable bookmark paths. */
export type RecoveryMode = 'reattach-only' | 'salvage';

/** Presents a stable, tokenized recovery decision before it can be committed. */
export interface RecoveryPreview {
  readonly token: string;
  readonly detachedPartitionId: string;
  readonly destinationRootUri: string;
  readonly mode: RecoveryMode;
  readonly resolving: number;
  readonly missing: number;
  readonly incompatible: number;
}

/** Limits recovery's filesystem dependency to resolution checks for rebased targets. */
export interface RecoveryFileSystem {
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Creates a valid, empty snapshot for the current workspace partition schema. */
export function emptyWorkspacePartitionSnapshot(): WorkspacePartitionSnapshot {
  return {
    version: WORKSPACE_PARTITION_SCHEMA_VERSION,
    partitions: [],
    unassigned: emptyBookmarkData()
  };
}

/** Validates persisted partition state without exposing bookmark content in failure reasons. */
export function validateWorkspacePartitionSnapshot(value: unknown): SnapshotValidationResult {
  if (!isRecord(value)) {
    return invalid('snapshot shape is malformed');
  }
  if (value.version !== WORKSPACE_PARTITION_SCHEMA_VERSION) {
    return invalid('snapshot version is unsupported');
  }
  if (!Array.isArray(value.partitions)) {
    return invalid('partition list is malformed');
  }

  const allIds = new Set<string>();
  for (const partition of value.partitions) {
    const reason = validatePartition(partition, allIds);
    if (reason) {
      return invalid(reason);
    }
  }

  const ownerReason = validateOwnerData(value.unassigned, allIds);
  return ownerReason ? invalid(ownerReason) : { ok: true };
}

/** Returns an independent copy that callers may mutate without changing the stored snapshot. */
export function cloneWorkspacePartitionSnapshot(
  value: WorkspacePartitionSnapshot
): WorkspacePartitionSnapshot {
  return {
    version: value.version,
    partitions: value.partitions.map((partition) => ({
      ...partition,
      attachment: partition.attachment === null ? null : { ...partition.attachment },
      data: cloneBookmarkData(partition.data),
      mirror: { ...partition.mirror }
    })),
    unassigned: cloneBookmarkData(value.unassigned)
  };
}

/** Returns a stable key for maps indexed by a partition or the Unassigned owner. */
export function ownerKey(owner: WorkspaceOwnerRef): string {
  return owner.kind === 'partition' ? `partition:${owner.partitionId}` : 'unassigned';
}

function invalid(reason: string): SnapshotValidationResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function validatePartition(value: unknown, allIds: Set<string>): string | undefined {
  if (!isRecord(value)) {
    return 'partition shape is malformed';
  }
  if (!isUuid(value.id)) {
    return 'partition identifier is malformed';
  }
  if (allIds.has(value.id)) {
    return 'identifier is duplicated across owners';
  }
  allIds.add(value.id);

  if (!isCanonicalUriMetadata(value.lastKnownRootUri, value.canonicalLastKnownRootUri)) {
    return 'last-known root metadata is malformed';
  }
  if (!isValidAttachment(value.attachment)) {
    return 'attachment metadata is malformed';
  }
  if (typeof value.replacementEligible !== 'boolean') {
    return 'replacement eligibility is malformed';
  }
  if (!isRecord(value.mirror)
    || typeof value.mirror.dirty !== 'boolean'
    || (value.mirror.lastSuccessfulHash !== undefined && !isSha256Hash(value.mirror.lastSuccessfulHash))) {
    return 'mirror metadata is malformed';
  }

  return validateOwnerData(value.data, allIds);
}

function isValidAttachment(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return isRecord(value) && isCanonicalUriMetadata(value.rootUri, value.canonicalRootUri);
}

function isCanonicalUriMetadata(rootUri: unknown, canonicalRootUri: unknown): boolean {
  if (typeof rootUri !== 'string' || typeof canonicalRootUri !== 'string') {
    return false;
  }
  try {
    return canonicalizeRootUri(vscode.Uri.parse(rootUri)) === canonicalRootUri;
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HASH_PATTERN.test(value);
}

function validateOwnerData(data: unknown, allIds: Set<string>): string | undefined {
  if (!isStrictBookmarkData(data)) {
    return 'owner content is malformed';
  }
  const collectionIds = new Set<string>();
  for (const collection of data.collections) {
    if (!isUuid(collection.id)) {
      return 'collection identifier is malformed';
    }
    if (allIds.has(collection.id)) {
      return 'identifier is duplicated across owners';
    }
    allIds.add(collection.id);
    collectionIds.add(collection.id);
  }
  for (const item of data.items) {
    if (!isUuid(item.id)) {
      return 'item identifier is malformed';
    }
    if (allIds.has(item.id)) {
      return 'identifier is duplicated across owners';
    }
    allIds.add(item.id);
    if (item.collectionId !== null && !collectionIds.has(item.collectionId)) {
      return 'item references a collection outside its owner';
    }
  }
  return undefined;
}

function cloneBookmarkData(data: BookmarkData): BookmarkData {
  return {
    version: data.version,
    collections: data.collections.map((collection) => ({ ...collection })),
    items: data.items.map((item) => ({ ...item }))
  };
}
