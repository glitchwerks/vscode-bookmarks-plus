import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  BookmarkCollection,
  BookmarkData,
  BookmarkItem,
  CURRENT_SCHEMA_VERSION,
  emptyBookmarkData,
  isValidBookmarkCollection,
  isValidBookmarkData,
  isValidBookmarkItem,
  normalizeDescription
} from './types';
import { migrateBookmarkData } from './migrations';

const STORAGE_KEY = 'bookmarks.data';

export interface OutputSink {
  appendLine(value: string): void;
}

/** The read/change contract shared by global and partitioned bookmark content stores. */
export interface BookmarkContentReader {
  readonly onBookmarksChanged: vscode.Event<void>;
  getAll(): BookmarkData;
}


export interface AddItemInput {
  type: 'file' | 'folder';
  uri: string;
  collectionId?: string | null;
  description?: string;
}

export class DuplicateBookmarkError extends Error {
  constructor(
    readonly uri: string,
    readonly collectionId: string | null
  ) {
    super('Bookmark already exists in this collection.');
    this.name = 'DuplicateBookmarkError';
  }
}

/** Raised when a queued mutation targets a collection that no longer exists in its scope. */
export class CollectionNotFoundError extends Error {
  constructor(readonly collectionId: string) {
    super('Bookmark collection was not found.');
    this.name = 'CollectionNotFoundError';
  }
}

const noopOutput: OutputSink = { appendLine: () => {} };

/** Rejects global mutations after admission is fenced or the store is disposed. */
export class GlobalStoreUnavailableError extends Error {
  constructor() {
    super('Global bookmark store is disposed.');
    this.name = 'GlobalStoreUnavailableError';
  }
}


export class BookmarkStore implements BookmarkContentReader {
  private data: BookmarkData;
  private operationTail: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;
  private acceptingMutations = true;
  private disposed = false;
  private readonly _onBookmarksChanged = new vscode.EventEmitter<void>();
  readonly onBookmarksChanged: vscode.Event<void> = this._onBookmarksChanged.event;
  constructor(
    private readonly state: vscode.Memento,
    private readonly output: OutputSink = noopOutput
  ) {
    this.data = this.load();
  }

  private load(): BookmarkData {
    const stored = this.state.get<unknown>(STORAGE_KEY);
    if (stored === undefined || stored === null || !isValidBookmarkData(stored)) {
      this.output.appendLine(
        'BookmarkStore: stored bookmarks.data is missing or malformed — starting from an empty state.'
      );
      return emptyBookmarkData();
    }
    if (stored.version === CURRENT_SCHEMA_VERSION) {
      return stored;
    }
    try {
      const migrated = migrateBookmarkData(stored);
      this.output.appendLine(
        `BookmarkStore: migrated stored bookmarks.data from schema version ${stored.version} to ${CURRENT_SCHEMA_VERSION}.`
      );
      return migrated;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(
        `BookmarkStore: cannot read stored bookmarks.data (${message}) — starting from an empty state.`
      );
      return emptyBookmarkData();
    }
  }

  private renumber(list: { order: number }[]): void {
    list.sort((a, b) => a.order - b.order);
    list.forEach((entry, index) => {
      entry.order = index;
    });
  }

  private hasDuplicateBookmark(
    data: BookmarkData,
    uri: string,
    collectionId: string | null,
    excludedItemId?: string
  ): boolean {
    return data.items.some(
      (item) =>
        item.id !== excludedItemId &&
        item.uri === uri &&
        item.collectionId === collectionId
    );
  }

  getAll(): BookmarkData {
    return cloneData(this.data);
  }

  addItem(input: AddItemInput): Promise<BookmarkItem> {
    return this.enqueue((draft) => {
      const collectionId = input.collectionId ?? null;
      if (collectionId !== null && !draft.collections.some((collection) => collection.id === collectionId)) {
        throw new CollectionNotFoundError(collectionId);
      }
      if (this.hasDuplicateBookmark(draft, input.uri, collectionId)) {
        throw new DuplicateBookmarkError(input.uri, collectionId);
      }
      const description = normalizeDescription(input.description);
      const item: BookmarkItem = {
        id: randomUUID(),
        type: input.type,
        uri: input.uri,
        collectionId,
        order: draft.items.filter((candidate) => candidate.collectionId === collectionId).length,
        ...(description === undefined ? {} : { description })
      };
      draft.items.push(item);
      return { value: item, changed: true };
    });
  }

  removeItem(id: string): Promise<void> {
    return this.enqueue((draft) => {
      const target = draft.items.find((item) => item.id === id);
      if (!target) {
        return { value: undefined, changed: false };
      }
      draft.items = draft.items.filter((item) => item.id !== id);
      this.renumber(draft.items.filter((item) => item.collectionId === target.collectionId));
      return { value: undefined, changed: true };
    });
  }

  addCollection(name: string): Promise<BookmarkCollection> {
    return this.enqueue((draft) => {
      const collection: BookmarkCollection = {
        id: randomUUID(),
        name,
        order: draft.collections.length
      };
      draft.collections.push(collection);
      return { value: collection, changed: true };
    });
  }

  moveItem(id: string, newCollectionId: string | null, newIndex: number): Promise<void> {
    return this.enqueue((draft) => {
      const item = draft.items.find((candidate) => candidate.id === id);
      if (!item) {
        return { value: undefined, changed: false };
      }
      if (this.hasDuplicateBookmark(draft, item.uri, newCollectionId, item.id)) {
        throw new DuplicateBookmarkError(item.uri, newCollectionId);
      }
      const oldCollectionId = item.collectionId;
      this.renumber(draft.items.filter((candidate) => candidate.collectionId === oldCollectionId && candidate.id !== id));

      item.collectionId = newCollectionId;
      const newSiblings = draft.items
        .filter((candidate) => candidate.collectionId === newCollectionId && candidate.id !== id)
        .sort((left, right) => left.order - right.order);
      const clampedIndex = Math.max(0, Math.min(newIndex, newSiblings.length));
      newSiblings.splice(clampedIndex, 0, item);
      newSiblings.forEach((entry, index) => {
        entry.order = index;
      });
      return { value: undefined, changed: true };
    });
  }

  renameCollection(id: string, name: string): Promise<void> {
    return this.enqueue((draft) => {
      const collection = draft.collections.find((candidate) => candidate.id === id);
      if (!collection) {
        return { value: undefined, changed: false };
      }
      collection.name = name;
      return { value: undefined, changed: true };
    });
  }

  setItemDescription(id: string, description: string | undefined): Promise<void> {
    return this.enqueue((draft) => {
      const item = draft.items.find((candidate) => candidate.id === id);
      const next = normalizeDescription(description);
      if (!item || item.description === next) {
        return { value: undefined, changed: false };
      }
      if (next === undefined) {
        delete item.description;
      } else {
        item.description = next;
      }
      return { value: undefined, changed: true };
    });
  }

  setCollectionDescription(id: string, description: string | undefined): Promise<void> {
    return this.enqueue((draft) => {
      const collection = draft.collections.find((candidate) => candidate.id === id);
      const next = normalizeDescription(description);
      if (!collection || collection.description === next) {
        return { value: undefined, changed: false };
      }
      if (next === undefined) {
        delete collection.description;
      } else {
        collection.description = next;
      }
      return { value: undefined, changed: true };
    });
  }

  deleteCollection(id: string): Promise<void> {
    return this.enqueue((draft) => {
      if (!draft.collections.some((collection) => collection.id === id)) {
        return { value: undefined, changed: false };
      }
      const orphanedItems = draft.items
        .filter((item) => item.collectionId === id)
        .sort((left, right) => left.order - right.order);
      const acceptedOrphanUris = new Set<string>();
      const collidingOrphanIds = new Set(
        orphanedItems
          .filter((item) => {
            if (this.hasDuplicateBookmark(draft, item.uri, null) || acceptedOrphanUris.has(item.uri)) {
              return true;
            }
            acceptedOrphanUris.add(item.uri);
            return false;
          })
          .map((item) => item.id)
      );

      draft.collections = draft.collections.filter((collection) => collection.id !== id);
      this.renumber(draft.collections);
      draft.items = draft.items.filter((item) => !collidingOrphanIds.has(item.id));
      const nextOrder = draft.items.filter((item) => item.collectionId === null).length;
      orphanedItems
        .filter((item) => !collidingOrphanIds.has(item.id))
        .forEach((item, index) => {
          item.collectionId = null;
          item.order = nextOrder + index;
        });
      return { value: undefined, changed: true };
    });
  }

  /** Fences new work, drains every admitted mutation, then releases store resources. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.acceptingMutations = false;
    const admittedTail = this.operationTail;
    this.shutdownPromise = admittedTail.then(() => this.dispose());
    return this.shutdownPromise;
  }

  /** Immediately retires the store, including mutations still waiting in its queue. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.acceptingMutations = false;
    this.disposed = true;
    this._onBookmarksChanged.dispose();
  }

  private enqueue<T>(operation: (draft: BookmarkData) => { value: T; changed: boolean }): Promise<T> {
    if (!this.acceptingMutations) {
      return Promise.reject(new GlobalStoreUnavailableError());
    }
    const run = this.operationTail.then(async () => {
      this.assertAvailable();
      const draft = cloneData(this.data);
      const outcome = operation(draft);
      if (!outcome.changed) {
        return outcome.value;
      }
      if (!isCompleteBookmarkData(draft)) {
        throw new Error('Global bookmark draft is invalid.');
      }
      await this.state.update(STORAGE_KEY, draft);
      this.data = draft;
      this._onBookmarksChanged.fire();
      return outcome.value;
    });
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new GlobalStoreUnavailableError();
    }
  }
}

function cloneData(data: BookmarkData): BookmarkData {
  return {
    version: data.version,
    collections: data.collections.map((collection) => ({ ...collection })),
    items: data.items.map((item) => ({ ...item }))
  };
}

function isCompleteBookmarkData(value: unknown): value is BookmarkData {
  return isValidBookmarkData(value)
    && value.items.every(isValidBookmarkItem)
    && value.collections.every(isValidBookmarkCollection);
}
