import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  AddItemInput,
  BookmarkContentReader,
  DuplicateBookmarkError,
  OutputSink
} from './bookmarkStore';
import { RootCandidate, canonicalizeRootUri, findDeepestRoot, rebaseUri } from './rootUri';
import {
  BookmarkCollection,
  BookmarkData,
  BookmarkItem,
  emptyBookmarkData,
  normalizeDescription
} from './types';
import {
  WORKSPACE_PARTITION_STORAGE_KEY,
  WorkspaceOwnerRef,
  WorkspacePartition,
  WorkspacePartitionSnapshot,
  PartitionLifecycleChange,
  RecoveryFileSystem,
  RecoveryMode,
  RecoveryPreview,
  RootReconcileResult,
  cloneWorkspacePartitionSnapshot,
  validateWorkspacePartitionSnapshot
} from './workspacePartitionTypes';
import { loadOrMigrateWorkspaceSnapshot } from './workspacePartitionMigration';
import { hashContent, serializeBookmarkData } from './bookmarkMirror';

export type {
  PartitionLifecycleChange,
  RecoveryFileSystem,
  RecoveryMode,
  RecoveryPreview,
  RootReconcileResult
} from './workspacePartitionTypes';

/** Rejects a mutation that would escape an attached partition's root boundary. */
export class PartitionBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartitionBoundaryError';
  }
}

/** Rejects a mutation whose draft would violate persisted workspace invariants. */
export class WorkspaceSnapshotInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSnapshotInvariantError';
  }
}

/** Rejects workspace mutations while the persisted snapshot is not safe to consume. */
export class WorkspaceDataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceDataUnavailableError';
  }
}

/** Rejects recovery when its destination or selected detached partition is no longer eligible. */
export class RecoveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryConflictError';
  }
}

/** Rejects a recovery preview after any persisted workspace snapshot revision. */
export class StaleRecoveryPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleRecoveryPreviewError';
  }
}

export interface WorkspaceBookmarkStoreOptions {
  readonly state: vscode.Memento;
  readonly roots: readonly RootCandidate[];
  readonly output: OutputSink;
  readonly createId?: () => string;
}

export interface AttachedPartitionView {
  readonly partitionId: string;
  readonly label: string;
  readonly rootUri: string;
  readonly canonicalRootUri: string;
  readonly replacementEligible: boolean;
  readonly data: BookmarkData;
}

export interface DetachedPartitionView {
  readonly partitionId: string;
  readonly lastKnownRootUri: string;
  readonly canonicalLastKnownRootUri: string;
  readonly replacementEligible: boolean;
  readonly data: BookmarkData;
}

export interface WorkspaceStoreView {
  readonly kind: 'ready' | 'unavailable';
  readonly attached: readonly AttachedPartitionView[];
  readonly detached: readonly DetachedPartitionView[];
  readonly unassigned: BookmarkData;
  readonly unavailableRoots: readonly string[];
  readonly reason?: string;
}

interface MutationResult<T> {
  readonly value: T;
  readonly changed: boolean;
  readonly afterCommit?: () => void;
  readonly silent?: boolean;
}

interface PendingRecovery {
  readonly revision: number;
  readonly partitionId: string;
  readonly destination: RootCandidate;
  readonly replacementPartitionId?: string;
  readonly rewrites: ReadonlyMap<string, string>;
}

const noopOutput: OutputSink = { appendLine: () => {} };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Owns the complete workspace-partition snapshot and commits every content change atomically.
 * Global bookmarks continue to use BookmarkStore; this store never persists aggregate read views.
 */
export class WorkspaceBookmarkStore implements BookmarkContentReader, vscode.Disposable {
  private snapshot: WorkspacePartitionSnapshot | undefined;
  private unavailableReason: string | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly _onBookmarksChanged = new vscode.EventEmitter<void>();
  readonly onBookmarksChanged: vscode.Event<void> = this._onBookmarksChanged.event;
  private readonly _onDidChangePartitions = new vscode.EventEmitter<PartitionLifecycleChange>();
  readonly onDidChangePartitions: vscode.Event<PartitionLifecycleChange> = this._onDidChangePartitions.event;
  private readonly pendingRecoveries = new Map<string, PendingRecovery>();
  private unavailableCanonicalRoots: readonly string[] = [];
  private revision = 0;

  private constructor(
    private readonly state: vscode.Memento,
    private roots: readonly RootCandidate[],
    private readonly output: OutputSink,
    private readonly createId: () => string
  ) {}

  /** Loads the persisted partition snapshot, preserving unavailable state rather than replacing it. */
  static async create(options: WorkspaceBookmarkStoreOptions): Promise<WorkspaceBookmarkStore> {
    const store = new WorkspaceBookmarkStore(
      options.state,
      options.roots,
      options.output ?? noopOutput,
      options.createId ?? randomUUID
    );
    const loaded = await loadOrMigrateWorkspaceSnapshot(
      options.state,
      options.roots,
      store.createId,
      options.output ?? noopOutput
    );
    if (loaded.kind === 'ready') {
      store.snapshot = cloneWorkspacePartitionSnapshot(loaded.snapshot);
    } else {
      store.unavailableReason = loaded.reason;
    }
    return store;
  }

  /** Returns an independent aggregate of every attached, detached, and Unassigned owner. */
  getAll(): BookmarkData {
    if (!this.snapshot) {
      return emptyBookmarkData();
    }
    const aggregate = emptyBookmarkData();
    for (const partition of this.snapshot.partitions) {
      aggregate.collections.push(...partition.data.collections.map((collection) => ({ ...collection })));
      aggregate.items.push(...partition.data.items.map((item) => ({ ...item })));
    }
    aggregate.collections.push(...this.snapshot.unassigned.collections.map((collection) => ({ ...collection })));
    aggregate.items.push(...this.snapshot.unassigned.items.map((item) => ({ ...item })));
    return aggregate;
  }

  /** Returns a defensive partition-aware view of the current workspace content. */
  getView(): WorkspaceStoreView {
    if (!this.snapshot) {
      return {
        kind: 'unavailable',
        attached: [],
        detached: [],
        unassigned: emptyBookmarkData(),
        unavailableRoots: this.roots.map((root) => root.uri.toString()),
        reason: this.unavailableReason
      };
    }

    const attached: AttachedPartitionView[] = [];
    const detached: DetachedPartitionView[] = [];
    for (const partition of this.snapshot.partitions) {
      if (partition.attachment) {
        const root = this.roots.find(
          (candidate) => canonicalizeRootUri(candidate.uri) === partition.attachment!.canonicalRootUri
        );
        attached.push({
          partitionId: partition.id,
          label: root?.label ?? partition.attachment.rootUri,
          rootUri: partition.attachment.rootUri,
          canonicalRootUri: partition.attachment.canonicalRootUri,
          replacementEligible: partition.replacementEligible,
          data: cloneData(partition.data)
        });
      } else {
        detached.push({
          partitionId: partition.id,
          lastKnownRootUri: partition.lastKnownRootUri,
          canonicalLastKnownRootUri: partition.canonicalLastKnownRootUri,
          replacementEligible: partition.replacementEligible,
          data: cloneData(partition.data)
        });
      }
    }
    attached.sort((left, right) => this.rootOrder(left.canonicalRootUri) - this.rootOrder(right.canonicalRootUri));
    return {
      kind: 'ready',
      attached,
      detached,
      unassigned: cloneData(this.snapshot.unassigned),
      unavailableRoots: this.unavailableCanonicalRoots
    };
  }

  /** Returns a defensive copy of one owner's content, or undefined for an unknown owner. */
  getOwnerData(owner: WorkspaceOwnerRef): BookmarkData | undefined {
    if (!this.snapshot) {
      return undefined;
    }
    return this.ownerData(this.snapshot, owner) ? cloneData(this.ownerData(this.snapshot, owner)!) : undefined;
  }

  /** Returns a defensive snapshot of one partition's mirror content and precedence metadata. */
  getMirrorState(partitionId: string): { data: BookmarkData; hash?: string; dirty: boolean } | undefined {
    const partition = this.snapshot?.partitions.find((entry) => entry.id === partitionId);
    return partition ? {
      data: cloneData(partition.data), hash: partition.mirror.lastSuccessfulHash, dirty: partition.mirror.dirty
    } : undefined;
  }

  /**
   * Atomically adopts a validated mirror while local content is clean and its binding is allowed.
   * The guard runs when queued work begins; an already-started persistence completes normally.
   */
  adoptMirrorData(
    partitionId: string, data: BookmarkData, hash: string, rewriteRequired: boolean,
    allow: () => boolean = () => true
  ): Promise<void> {
    const incoming = cloneData(data);
    return this.enqueue((draft) => {
      if (!allow()) { return unchanged(); }
      const partition = this.requireAttachedCreateOwner(draft, { kind: 'partition', partitionId });
      if (partition.mirror.dirty) { return unchanged(); }
      for (const item of incoming.items) {
        if (partition.data.items.some((existing) => existing.id === item.id && existing.uri === item.uri)) { continue; }
        const owner = this.resolveAttachedOwnerIn(draft, vscode.Uri.parse(item.uri));
        if (owner?.kind !== 'partition' || owner.partitionId !== partitionId) {
          throw new PartitionBoundaryError('External bookmark URI is outside the selected workspace partition.');
        }
      }
      partition.data = cloneData(incoming);
      // Another partition may have adopted the same external IDs while this mutation was queued.
      // Repair against the draft inside the atomic transaction, never against an earlier read view.
      const used = new Set([
        ...draft.partitions.map((entry) => entry.id),
        ...draft.partitions.filter((entry) => entry.id !== partitionId)
          .flatMap((entry) => [...entry.data.collections, ...entry.data.items].map((record) => record.id)),
        ...[...draft.unassigned.collections, ...draft.unassigned.items].map((entry) => entry.id)
      ]);
      const collectionIds = new Map<string, string>();
      let repaired = false;
      for (const collection of partition.data.collections) {
        const originalId = collection.id;
        if (used.has(originalId)) { collection.id = this.allocateId(draft); repaired = true; }
        used.add(collection.id);
        collectionIds.set(originalId, collection.id);
      }
      for (const item of partition.data.items) {
        if (used.has(item.id)) { item.id = this.allocateId(draft); repaired = true; }
        used.add(item.id);
        if (item.collectionId !== null) { item.collectionId = collectionIds.get(item.collectionId) ?? item.collectionId; }
      }
      partition.replacementEligible = false;
      partition.mirror = { lastSuccessfulHash: hash, dirty: rewriteRequired || repaired };
      return changed();
    });
  }

  /** Records a successful write if its binding is still allowed when this queued mutation begins. */
  recordMirrorWrite(partitionId: string, hash: string, allow: () => boolean = () => true): Promise<void> {
    return this.enqueue((draft) => {
      if (!allow()) { return unchanged(); }
      const partition = draft.partitions.find((entry) => entry.id === partitionId);
      if (!partition) { return unchanged(); }
      const dirty = hashContent(serializeBookmarkData(partition.data)) !== hash;
      if (partition.mirror.lastSuccessfulHash === hash && partition.mirror.dirty === dirty) { return unchanged(); }
      partition.mirror = { lastSuccessfulHash: hash, dirty };
      return { ...changed(), silent: true };
    });
  }

  /** Persists failed-write precedence if its binding is still allowed when queued work begins. */
  recordMirrorDirty(partitionId: string, allow: () => boolean = () => true): Promise<void> {
    return this.enqueue((draft) => {
      if (!allow()) { return unchanged(); }
      const partition = draft.partitions.find((entry) => entry.id === partitionId);
      if (!partition || partition.mirror.dirty) { return unchanged(); }
      partition.mirror.dirty = true;
      return { ...changed(), silent: true };
    });
  }

  /** Finds exact stored URI matches without exposing the mutable snapshot records. */
  findItemsByUri(uri: vscode.Uri): readonly { owner: WorkspaceOwnerRef; item: BookmarkItem }[] {
    if (!this.snapshot) {
      return [];
    }
    const target = uri.toString();
    const matches: { owner: WorkspaceOwnerRef; item: BookmarkItem }[] = [];
    for (const partition of this.snapshot.partitions) {
      for (const item of partition.data.items) {
        if (item.uri === target) {
          matches.push({ owner: { kind: 'partition', partitionId: partition.id }, item: { ...item } });
        }
      }
    }
    for (const item of this.snapshot.unassigned.items) {
      if (item.uri === target) {
        matches.push({ owner: { kind: 'unassigned' }, item: { ...item } });
      }
    }
    return matches;
  }

  /** Resolves a URI to the currently attached owner of its deepest unambiguous root. */
  resolveAttachedOwner(uri: vscode.Uri): WorkspaceOwnerRef | undefined {
    if (!this.snapshot) {
      return undefined;
    }
    const root = findDeepestRoot(uri, this.roots);
    if (!root) {
      return undefined;
    }
    const partition = this.snapshot.partitions.find(
      (candidate) => candidate.attachment?.canonicalRootUri === root.canonicalUri
    );
    return partition ? { kind: 'partition', partitionId: partition.id } : undefined;
  }

  /** Adds an item only when its explicit attached owner is the URI's deepest current root. */
  addItem(owner: WorkspaceOwnerRef, input: AddItemInput): Promise<BookmarkItem> {
    return this.enqueue((draft) => {
      const partition = this.requireAttachedCreateOwner(draft, owner);
      const resolved = this.resolveAttachedOwnerIn(draft, vscode.Uri.parse(input.uri));
      if (!resolved || resolved.kind !== 'partition' || resolved.partitionId !== partition.id) {
        throw new PartitionBoundaryError('Bookmark URI is outside the selected workspace partition.');
      }
      const data = partition.data;
      const collectionId = input.collectionId ?? null;
      if (collectionId !== null && !data.collections.some((collection) => collection.id === collectionId)) {
        throw new WorkspaceSnapshotInvariantError('Bookmark collection is not owned by the selected partition.');
      }
      if (hasDuplicateBookmark(data, input.uri, collectionId)) {
        throw new DuplicateBookmarkError(input.uri, collectionId);
      }
      const item: BookmarkItem = {
        id: this.allocateId(draft),
        type: input.type,
        uri: input.uri,
        collectionId,
        order: data.items.filter((candidate) => candidate.collectionId === collectionId).length
      };
      data.items.push(item);
      markContentMutation(partition);
      return { value: { ...item }, changed: true };
    });
  }

  /** Removes an item from only the selected owner; unknown owner-local identifiers are no-ops. */
  removeItem(owner: WorkspaceOwnerRef, id: string): Promise<void> {
    return this.enqueue((draft) => {
      const data = this.ownerData(draft, owner);
      const target = data?.items.find((item) => item.id === id);
      if (!data || !target) {
        return unchanged();
      }
      data.items = data.items.filter((item) => item.id !== id);
      renumber(data.items.filter((item) => item.collectionId === target.collectionId));
      this.markOwnerMutation(draft, owner);
      return changed();
    });
  }

  /** Adds a collection only to an explicit attached partition. */
  addCollection(owner: WorkspaceOwnerRef, name: string): Promise<BookmarkCollection> {
    return this.enqueue((draft) => {
      const partition = this.requireAttachedCreateOwner(draft, owner);
      const collection: BookmarkCollection = {
        id: this.allocateId(draft),
        name,
        order: partition.data.collections.length
      };
      partition.data.collections.push(collection);
      markContentMutation(partition);
      return { value: { ...collection }, changed: true };
    });
  }

  /** Moves an owner-local item while preserving duplicate prevention and sibling order semantics. */
  moveItem(owner: WorkspaceOwnerRef, id: string, collectionId: string | null, index: number): Promise<void> {
    return this.enqueue((draft) => {
      const data = this.ownerData(draft, owner);
      const item = data?.items.find((candidate) => candidate.id === id);
      if (!data || !item) {
        return unchanged();
      }
      if (collectionId !== null && !data.collections.some((collection) => collection.id === collectionId)) {
        throw new WorkspaceSnapshotInvariantError('Destination collection is not owned by the selected partition.');
      }
      if (hasDuplicateBookmark(data, item.uri, collectionId, item.id)) {
        throw new DuplicateBookmarkError(item.uri, collectionId);
      }
      const oldCollectionId = item.collectionId;
      renumber(data.items.filter((candidate) => candidate.collectionId === oldCollectionId && candidate.id !== item.id));
      item.collectionId = collectionId;
      const siblings = data.items
        .filter((candidate) => candidate.collectionId === collectionId && candidate.id !== item.id)
        .sort((left, right) => left.order - right.order);
      siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, item);
      renumber(siblings);
      this.markOwnerMutation(draft, owner);
      return changed();
    });
  }

  /** Renames an owner-local collection; missing identifiers are no-ops. */
  renameCollection(owner: WorkspaceOwnerRef, id: string, name: string): Promise<void> {
    return this.enqueue((draft) => {
      const data = this.ownerData(draft, owner);
      const collection = data?.collections.find((candidate) => candidate.id === id);
      if (!data || !collection) {
        return unchanged();
      }
      collection.name = name;
      this.markOwnerMutation(draft, owner);
      return changed();
    });
  }

  /** Sets or clears an owner-local item description using the global store's normalization. */
  setItemDescription(owner: WorkspaceOwnerRef, id: string, description: string | undefined): Promise<void> {
    return this.enqueue((draft) => {
      const data = this.ownerData(draft, owner);
      const item = data?.items.find((candidate) => candidate.id === id);
      const next = normalizeDescription(description);
      if (!data || !item || item.description === next) {
        return unchanged();
      }
      if (next === undefined) {
        delete item.description;
      } else {
        item.description = next;
      }
      this.markOwnerMutation(draft, owner);
      return changed();
    });
  }

  /** Sets or clears an owner-local collection description using the global store's normalization. */
  setCollectionDescription(owner: WorkspaceOwnerRef, id: string, description: string | undefined): Promise<void> {
    return this.enqueue((draft) => {
      const data = this.ownerData(draft, owner);
      const collection = data?.collections.find((candidate) => candidate.id === id);
      const next = normalizeDescription(description);
      if (!data || !collection || collection.description === next) {
        return unchanged();
      }
      if (next === undefined) {
        delete collection.description;
      } else {
        collection.description = next;
      }
      this.markOwnerMutation(draft, owner);
      return changed();
    });
  }

  /** Deletes one owner-local collection and ungroups its non-colliding items in one transition. */
  deleteCollection(owner: WorkspaceOwnerRef, id: string): Promise<void> {
    return this.enqueue((draft) => {
      const data = this.ownerData(draft, owner);
      if (!data || !data.collections.some((collection) => collection.id === id)) {
        return unchanged();
      }
      const orphanedItems = data.items
        .filter((item) => item.collectionId === id)
        .sort((left, right) => left.order - right.order);
      const acceptedUris = new Set<string>();
      const discarded = new Set(orphanedItems.filter((item) => {
        if (hasDuplicateBookmark(data, item.uri, null) || acceptedUris.has(item.uri)) {
          return true;
        }
        acceptedUris.add(item.uri);
        return false;
      }).map((item) => item.id));
      data.collections = data.collections.filter((collection) => collection.id !== id);
      renumber(data.collections);
      data.items = data.items.filter((item) => !discarded.has(item.id));
      const rootCount = data.items.filter((item) => item.collectionId === null).length;
      orphanedItems.filter((item) => !discarded.has(item.id)).forEach((item, index) => {
        item.collectionId = null;
        item.order = rootCount + index;
      });
      this.markOwnerMutation(draft, owner);
      return changed();
    });
  }

  /**
   * Reconciles roots atomically. The synchronous beforeCommit hook may fence mirror disposal
   * against the last committed content; it must never await operations on this store's queue.
   */
  reconcileRoots(roots: readonly RootCandidate[], beforeCommit?: () => void): Promise<RootReconcileResult> {
    const run = this.operationTail.then(async () => {
      this.assertReady();
      const draft = cloneWorkspacePartitionSnapshot(this.snapshot!);
      const reconciliation = this.reconcileDraft(draft, roots);
      if (reconciliation.changed) {
        const validation = validateWorkspacePartitionSnapshot(draft);
        if (!validation.ok) {
          throw new WorkspaceSnapshotInvariantError(validation.reason ?? 'Workspace snapshot is invalid.');
        }
        beforeCommit?.();
        await this.state.update(WORKSPACE_PARTITION_STORAGE_KEY, draft);
        this.snapshot = draft;
        this.roots = roots.slice();
        this.unavailableCanonicalRoots = reconciliation.result.unavailableCanonicalRoots;
        this.revision++;
        this._onBookmarksChanged.fire();
      } else {
        beforeCommit?.();
        this.roots = roots.slice();
        this.unavailableCanonicalRoots = reconciliation.result.unavailableCanonicalRoots;
      }
      this._onDidChangePartitions.fire({
        ...reconciliation.result,
        currentRoots: this.roots.slice(),
        removedReplacementPartitionIds: []
      });
      return reconciliation.result;
    });
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Previews a detached-partition recovery against the current snapshot without mutating it. */
  async previewRecovery(
    partitionId: string,
    destination: RootCandidate,
    mode: RecoveryMode,
    fs: RecoveryFileSystem
  ): Promise<RecoveryPreview> {
    await this.operationTail;
    this.assertReady();
    const previewRevision = this.revision;
    const recovery = this.prepareRecovery(this.snapshot!, partitionId, destination);
    const rewrites = new Map<string, string>();
    let resolving = 0;
    let missing = 0;
    let incompatible = 0;
    if (mode === 'salvage') {
      const oldRoot = vscode.Uri.parse(recovery.partition.lastKnownRootUri);
      for (const item of recovery.partition.data.items) {
        const rebased = rebaseUri(vscode.Uri.parse(item.uri), oldRoot, recovery.destination.uri);
        if (rebased.kind !== 'rebased' || !rebased.uri) {
          incompatible++;
          continue;
        }
        try {
          await fs.stat(rebased.uri);
          resolving++;
          rewrites.set(item.id, rebased.uri.toString());
        } catch {
          missing++;
        }
      }
    }
    if (previewRevision !== this.revision) {
      throw new StaleRecoveryPreviewError('Recovery preview is stale.');
    }
    this.assertReady();
    const token = randomUUID();
    this.pendingRecoveries.set(token, {
      revision: previewRevision,
      partitionId,
      destination: recovery.destination,
      replacementPartitionId: recovery.replacementPartitionId,
      rewrites
    });
    return {
      token,
      detachedPartitionId: partitionId,
      destinationRootUri: recovery.destination.uri.toString(),
      mode,
      resolving,
      missing,
      incompatible
    };
  }

  /** Commits an unchanged recovery preview as one attachment and optional URI-rewrite mutation. */
  commitRecovery(token: string): Promise<void> {
    return this.enqueue((draft) => {
      const pending = this.pendingRecoveries.get(token);
      if (!pending) {
        throw new RecoveryConflictError('Recovery preview token is unknown.');
      }
      if (pending.revision !== this.revision) {
        this.pendingRecoveries.delete(token);
        throw new StaleRecoveryPreviewError('Recovery preview is stale.');
      }
      const recovery = this.prepareRecovery(draft, pending.partitionId, pending.destination);
      if (recovery.replacementPartitionId !== pending.replacementPartitionId) {
        throw new RecoveryConflictError('Recovery destination eligibility changed.');
      }
      if (pending.replacementPartitionId) {
        draft.partitions = draft.partitions.filter((partition) => partition.id !== pending.replacementPartitionId);
      }
      const partition = draft.partitions.find((candidate) => candidate.id === pending.partitionId);
      if (!partition) {
        throw new RecoveryConflictError('Detached partition is no longer available.');
      }
      const canonicalRootUri = canonicalizeRootUri(recovery.destination.uri);
      partition.attachment = { rootUri: recovery.destination.uri.toString(), canonicalRootUri };
      partition.lastKnownRootUri = recovery.destination.uri.toString();
      partition.canonicalLastKnownRootUri = canonicalRootUri;
      for (const item of partition.data.items) {
        const rewrittenUri = pending.rewrites.get(item.id);
        if (rewrittenUri) {
          item.uri = rewrittenUri;
        }
      }
      if (pending.rewrites.size > 0) {
        markContentMutation(partition);
      }
      return {
        value: undefined,
        changed: true,
        afterCommit: () => {
          this.pendingRecoveries.delete(token);
          this.unavailableCanonicalRoots = this.unavailableRootsFor(this.snapshot!, this.roots);
          this._onDidChangePartitions.fire({
            attachedPartitionIds: [partition.id],
            detachedPartitionIds: [],
            unavailableCanonicalRoots: this.unavailableCanonicalRoots,
            currentRoots: this.roots.slice(),
            removedReplacementPartitionIds: pending.replacementPartitionId ? [pending.replacementPartitionId] : []
          });
        }
      };
    });
  }

  /** Disposes the change event emitter; workspace state itself remains untouched. */
  dispose(): void {
    this.disposed = true;
    this._onBookmarksChanged.dispose();
    this._onDidChangePartitions.dispose();
    this.pendingRecoveries.clear();
  }

  private reconcileDraft(
    draft: WorkspacePartitionSnapshot,
    roots: readonly RootCandidate[]
  ): { readonly result: RootReconcileResult; readonly changed: boolean } {
    const rootsByCanonical = new Map<string, RootCandidate[]>();
    for (const root of roots) {
      const canonical = canonicalizeRootUri(root.uri);
      const group = rootsByCanonical.get(canonical);
      if (group) {
        group.push(root);
      } else {
        rootsByCanonical.set(canonical, [root]);
      }
    }
    const unavailableCanonicalRoots = [...rootsByCanonical]
      .filter(([, candidates]) => candidates.length > 1)
      .map(([canonical]) => canonical);
    const currentCanonicalRoots = new Set(rootsByCanonical.keys());
    const detachedPartitionIds: string[] = [];
    const attachedPartitionIds: string[] = [];
    let changed = false;

    for (const partition of draft.partitions) {
      if (!partition.attachment || currentCanonicalRoots.has(partition.attachment.canonicalRootUri)) {
        continue;
      }
      partition.lastKnownRootUri = partition.attachment.rootUri;
      partition.canonicalLastKnownRootUri = partition.attachment.canonicalRootUri;
      partition.attachment = null;
      detachedPartitionIds.push(partition.id);
      changed = true;
    }

    for (const [canonical, candidates] of rootsByCanonical) {
      if (candidates.length !== 1) {
        continue;
      }
      if (draft.partitions.some((partition) => partition.attachment?.canonicalRootUri === canonical)) {
        continue;
      }
      const matches = draft.partitions.filter(
        (partition) => !partition.attachment && partition.canonicalLastKnownRootUri === canonical
      );
      if (matches.length === 1) {
        const partition = matches[0];
        const root = candidates[0];
        partition.attachment = { rootUri: root.uri.toString(), canonicalRootUri: canonical };
        partition.lastKnownRootUri = root.uri.toString();
        partition.canonicalLastKnownRootUri = canonical;
        attachedPartitionIds.push(partition.id);
        changed = true;
      } else if (matches.length === 0) {
        const root = candidates[0];
        const partition: WorkspacePartition = {
          id: this.allocateId(draft),
          attachment: { rootUri: root.uri.toString(), canonicalRootUri: canonical },
          lastKnownRootUri: root.uri.toString(),
          canonicalLastKnownRootUri: canonical,
          replacementEligible: true,
          data: emptyBookmarkData(),
          mirror: { dirty: false }
        };
        draft.partitions.push(partition);
        attachedPartitionIds.push(partition.id);
        changed = true;
      } else {
        unavailableCanonicalRoots.push(canonical);
      }
    }
    return {
      changed,
      result: { attachedPartitionIds, detachedPartitionIds, unavailableCanonicalRoots }
    };
  }

  private prepareRecovery(
    snapshot: WorkspacePartitionSnapshot,
    partitionId: string,
    requestedDestination: RootCandidate
  ): { readonly partition: WorkspacePartition; readonly destination: RootCandidate; readonly replacementPartitionId?: string } {
    const partition = snapshot.partitions.find((candidate) => candidate.id === partitionId);
    if (!partition || partition.attachment) {
      throw new RecoveryConflictError('Recovery requires a detached partition.');
    }
    let destinationCanonical: string;
    try {
      destinationCanonical = canonicalizeRootUri(requestedDestination.uri);
    } catch {
      throw new RecoveryConflictError('Recovery destination is not a current workspace root.');
    }
    // Candidate IDs include folder indices and may change after preview. Only a unique
    // canonical URI establishes continuity; collisions must still reject recovery.
    const matchingRoots = this.roots.filter((root) => canonicalizeRootUri(root.uri) === destinationCanonical);
    if (matchingRoots.length !== 1) {
      throw new RecoveryConflictError('Recovery destination is unavailable.');
    }
    const destination = matchingRoots[0];
    const existing = snapshot.partitions.find(
      (candidate) => candidate.attachment?.canonicalRootUri === destinationCanonical
    );
    if (!existing) {
      return { partition, destination };
    }
    if (!existing.replacementEligible || existing.data.items.length !== 0 || existing.data.collections.length !== 0) {
      throw new RecoveryConflictError('Recovery destination is an established partition.');
    }
    return { partition, destination, replacementPartitionId: existing.id };
  }

  /** Computes recovery-visible unavailable roots from the committed attachment snapshot. */
  private unavailableRootsFor(
    snapshot: WorkspacePartitionSnapshot,
    roots: readonly RootCandidate[]
  ): readonly string[] {
    const rootsByCanonical = new Map<string, RootCandidate[]>();
    for (const root of roots) {
      const canonical = canonicalizeRootUri(root.uri);
      const group = rootsByCanonical.get(canonical);
      if (group) {
        group.push(root);
      } else {
        rootsByCanonical.set(canonical, [root]);
      }
    }
    const unavailableCanonicalRoots: string[] = [];
    for (const [canonical, candidates] of rootsByCanonical) {
      if (candidates.length > 1) {
        unavailableCanonicalRoots.push(canonical);
        continue;
      }
      if (!snapshot.partitions.some((partition) => partition.attachment?.canonicalRootUri === canonical)) {
        unavailableCanonicalRoots.push(canonical);
      }
    }
    return unavailableCanonicalRoots;
  }

  private rootOrder(canonicalRootUri: string): number {
    const index = this.roots.findIndex((root) => canonicalizeRootUri(root.uri) === canonicalRootUri);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }

  private enqueue<T>(operation: (draft: WorkspacePartitionSnapshot) => MutationResult<T>): Promise<T> {
    const run = this.operationTail.then(async () => {
      this.assertReady();
      const draft = cloneWorkspacePartitionSnapshot(this.snapshot!);
      const outcome = operation(draft);
      if (!outcome.changed) {
        return outcome.value;
      }
      const validation = validateWorkspacePartitionSnapshot(draft);
      if (!validation.ok) {
        throw new WorkspaceSnapshotInvariantError(validation.reason ?? 'Workspace snapshot is invalid.');
      }
      await this.state.update(WORKSPACE_PARTITION_STORAGE_KEY, draft);
      this.snapshot = draft;
      this.revision++;
      outcome.afterCommit?.();
      if (!outcome.silent) { this._onBookmarksChanged.fire(); }
      return outcome.value;
    });
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertReady(): void {
    if (this.disposed) {
      throw new WorkspaceDataUnavailableError('Workspace bookmark store is disposed.');
    }
    if (!this.snapshot) {
      throw new WorkspaceDataUnavailableError(this.unavailableReason ?? 'Workspace data is unavailable.');
    }
  }

  private ownerData(snapshot: WorkspacePartitionSnapshot, owner: WorkspaceOwnerRef): BookmarkData | undefined {
    if (owner.kind === 'unassigned') {
      return snapshot.unassigned;
    }
    return snapshot.partitions.find((partition) => partition.id === owner.partitionId)?.data;
  }

  private requireAttachedCreateOwner(snapshot: WorkspacePartitionSnapshot, owner: WorkspaceOwnerRef): WorkspacePartition {
    if (owner.kind !== 'partition') {
      throw new PartitionBoundaryError('Unassigned bookmarks cannot receive newly created content.');
    }
    const partition = snapshot.partitions.find((candidate) => candidate.id === owner.partitionId);
    if (!partition || !partition.attachment) {
      throw new PartitionBoundaryError('Detached partitions cannot receive newly created content.');
    }
    return partition;
  }

  private resolveAttachedOwnerIn(
    snapshot: WorkspacePartitionSnapshot,
    uri: vscode.Uri
  ): WorkspaceOwnerRef | undefined {
    const root = findDeepestRoot(uri, this.roots);
    if (!root) {
      return undefined;
    }
    const partition = snapshot.partitions.find(
      (candidate) => candidate.attachment?.canonicalRootUri === root.canonicalUri
    );
    return partition ? { kind: 'partition', partitionId: partition.id } : undefined;
  }

  private markOwnerMutation(snapshot: WorkspacePartitionSnapshot, owner: WorkspaceOwnerRef): void {
    if (owner.kind !== 'partition') {
      return;
    }
    const partition = snapshot.partitions.find((candidate) => candidate.id === owner.partitionId);
    if (partition) {
      markContentMutation(partition);
    }
  }

  private allocateId(snapshot: WorkspacePartitionSnapshot): string {
    const used = new Set<string>([
      ...snapshot.partitions.flatMap((partition) => [
        partition.id,
        ...partition.data.collections.map((collection) => collection.id),
        ...partition.data.items.map((item) => item.id)
      ]),
      ...snapshot.unassigned.collections.map((collection) => collection.id),
      ...snapshot.unassigned.items.map((item) => item.id)
    ]);
    for (let attempts = 0; attempts < 10_000; attempts++) {
      const id = this.createId();
      if (UUID_PATTERN.test(id) && !used.has(id)) {
        return id;
      }
    }
    throw new WorkspaceSnapshotInvariantError('Unable to allocate a unique workspace identifier.');
  }
}

function cloneData(data: BookmarkData): BookmarkData {
  return {
    version: data.version,
    collections: data.collections.map((collection) => ({ ...collection })),
    items: data.items.map((item) => ({ ...item }))
  };
}

function changed(): MutationResult<void> {
  return { value: undefined, changed: true };
}

function unchanged(): MutationResult<void> {
  return { value: undefined, changed: false };
}

function markContentMutation(partition: WorkspacePartition): void {
  partition.replacementEligible = false;
  partition.mirror.dirty = true;
}

function hasDuplicateBookmark(
  data: BookmarkData,
  uri: string,
  collectionId: string | null,
  excludedItemId?: string
): boolean {
  return data.items.some((item) =>
    item.id !== excludedItemId && item.uri === uri && item.collectionId === collectionId
  );
}

function renumber(entries: { order: number }[]): void {
  entries.sort((left, right) => left.order - right.order).forEach((entry, index) => {
    entry.order = index;
  });
}
