import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  AddItemInput,
  BookmarkContentReader,
  DuplicateBookmarkError,
  OutputSink
} from './bookmarkStore';
import { RootCandidate, findDeepestRoot } from './rootUri';
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
  cloneWorkspacePartitionSnapshot,
  validateWorkspacePartitionSnapshot
} from './workspacePartitionTypes';
import { loadOrMigrateWorkspaceSnapshot } from './workspacePartitionMigration';

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

  private constructor(
    private readonly state: vscode.Memento,
    private readonly roots: readonly RootCandidate[],
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
          (candidate) => candidate.uri.toString() === partition.attachment!.rootUri
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
    return {
      kind: 'ready',
      attached,
      detached,
      unassigned: cloneData(this.snapshot.unassigned),
      unavailableRoots: []
    };
  }

  /** Returns a defensive copy of one owner's content, or undefined for an unknown owner. */
  getOwnerData(owner: WorkspaceOwnerRef): BookmarkData | undefined {
    if (!this.snapshot) {
      return undefined;
    }
    return this.ownerData(this.snapshot, owner) ? cloneData(this.ownerData(this.snapshot, owner)!) : undefined;
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

  /** Disposes the change event emitter; workspace state itself remains untouched. */
  dispose(): void {
    this.disposed = true;
    this._onBookmarksChanged.dispose();
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
      this._onBookmarksChanged.fire();
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
    if (partition?.attachment) {
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
