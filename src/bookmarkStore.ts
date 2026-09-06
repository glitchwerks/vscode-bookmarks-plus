import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  BookmarkCollection,
  BookmarkData,
  BookmarkItem,
  CURRENT_SCHEMA_VERSION,
  emptyBookmarkData,
  isStrictBookmarkData,
  isValidBookmarkData,
  normalizeDescription
} from './types';
import { migrateBookmarkData } from './migrations';
import { MirrorPort, hashContent, serializeBookmarkData, MIRROR_RELATIVE_PATH } from './bookmarkMirror';
import { Delayer } from './delayer';
import { normalizeBookmarkData } from './normalize';

const STORAGE_KEY = 'bookmarks.data';
const MIRROR_HASH_KEY = 'bookmarks.mirrorHash';
const MIRROR_DIRTY_KEY = 'bookmarks.mirrorDirty';
const DEFAULT_MIRROR_WRITE_DELAY_MS = 250;

export interface OutputSink {
  appendLine(value: string): void;
}

export interface BookmarkStoreOptions {
  /** Omit for a non-mirrored store; use null for a workspace whose mirror is disabled. */
  mirror?: MirrorPort | null;
  /** Debounce window for mirror writes. Defaults to 250 ms; tests use a short value. */
  writeDelayMs?: number;
}

export interface AddItemInput {
  type: 'file' | 'folder';
  uri: string;
  collectionId?: string | null;
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

const noopOutput: OutputSink = { appendLine: () => {} };

interface MirrorBinding {
  readonly generation: number;
  readonly port: MirrorPort;
}

export class BookmarkStore {
  private data: BookmarkData;
  private dataRevision = 0;
  private readonly _onBookmarksChanged = new vscode.EventEmitter<void>();
  readonly onBookmarksChanged: vscode.Event<void> = this._onBookmarksChanged.event;
  private mirrorBinding?: MirrorBinding;
  private nextMirrorGeneration = 1;
  private readonly mirrorDelayer: Delayer;
  private mirrorTemporarilyDetached: boolean;
  private mirrorOperationTail: Promise<void> = Promise.resolve();
  private mirrorWriteTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: vscode.Memento,
    private readonly output: OutputSink = noopOutput,
    options: BookmarkStoreOptions = {}
  ) {
    this.mirrorBinding = options.mirror
      ? { generation: this.nextMirrorGeneration++, port: options.mirror }
      : undefined;
    this.mirrorTemporarilyDetached = options.mirror === null;
    this.mirrorDelayer = new Delayer(options.writeDelayMs ?? DEFAULT_MIRROR_WRITE_DELAY_MS);
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

  private async persist(): Promise<void> {
    this.dataRevision++;
    await this.state.update(STORAGE_KEY, this.data);
    if (this.mirrorTemporarilyDetached) {
      await this.state.update(MIRROR_DIRTY_KEY, true);
    }
    this._onBookmarksChanged.fire();
    this.scheduleMirrorWrite();
  }

  private renumber(list: { order: number }[]): void {
    list.sort((a, b) => a.order - b.order);
    list.forEach((entry, index) => {
      entry.order = index;
    });
  }

  private hasDuplicateBookmark(
    uri: string,
    collectionId: string | null,
    excludedItemId?: string
  ): boolean {
    return this.data.items.some(
      (item) =>
        item.id !== excludedItemId &&
        item.uri === uri &&
        item.collectionId === collectionId
    );
  }

  getAll(): BookmarkData {
    return this.data;
  }

  async addItem(input: AddItemInput): Promise<BookmarkItem> {
    const collectionId = input.collectionId ?? null;
    if (this.hasDuplicateBookmark(input.uri, collectionId)) {
      throw new DuplicateBookmarkError(input.uri, collectionId);
    }
    const siblingCount = this.data.items.filter((i) => i.collectionId === collectionId).length;
    const item: BookmarkItem = {
      id: randomUUID(),
      type: input.type,
      uri: input.uri,
      collectionId,
      order: siblingCount
    };
    this.data.items.push(item);
    await this.persist();
    return item;
  }

  async removeItem(id: string): Promise<void> {
    const target = this.data.items.find((i) => i.id === id);
    if (!target) {
      return;
    }
    this.data.items = this.data.items.filter((i) => i.id !== id);
    const siblings = this.data.items.filter((i) => i.collectionId === target.collectionId);
    this.renumber(siblings);
    await this.persist();
  }

  async addCollection(name: string): Promise<BookmarkCollection> {
    const collection: BookmarkCollection = {
      id: randomUUID(),
      name,
      order: this.data.collections.length
    };
    this.data.collections.push(collection);
    await this.persist();
    return collection;
  }

  async moveItem(id: string, newCollectionId: string | null, newIndex: number): Promise<void> {
    const item = this.data.items.find((i) => i.id === id);
    if (!item) {
      return;
    }
    if (this.hasDuplicateBookmark(item.uri, newCollectionId, item.id)) {
      throw new DuplicateBookmarkError(item.uri, newCollectionId);
    }
    const oldCollectionId = item.collectionId;

    const oldSiblings = this.data.items.filter((i) => i.collectionId === oldCollectionId && i.id !== id);
    this.renumber(oldSiblings);

    item.collectionId = newCollectionId;
    const newSiblings = this.data.items
      .filter((i) => i.collectionId === newCollectionId && i.id !== id)
      .sort((a, b) => a.order - b.order);
    const clampedIndex = Math.max(0, Math.min(newIndex, newSiblings.length));
    newSiblings.splice(clampedIndex, 0, item);
    newSiblings.forEach((entry, index) => {
      entry.order = index;
    });

    await this.persist();
  }

  async renameCollection(id: string, name: string): Promise<void> {
    const collection = this.data.collections.find((c) => c.id === id);
    if (!collection) {
      return;
    }
    collection.name = name;
    await this.persist();
  }

  async setItemDescription(id: string, description: string | undefined): Promise<void> {
    const item = this.data.items.find((i) => i.id === id);
    if (!item) {
      return;
    }
    const next = normalizeDescription(description);
    if (item.description === next) {
      return;
    }
    if (next === undefined) {
      delete item.description;
    } else {
      item.description = next;
    }
    await this.persist();
  }

  async setCollectionDescription(id: string, description: string | undefined): Promise<void> {
    const collection = this.data.collections.find((c) => c.id === id);
    if (!collection) {
      return;
    }
    const next = normalizeDescription(description);
    if (collection.description === next) {
      return;
    }
    if (next === undefined) {
      delete collection.description;
    } else {
      collection.description = next;
    }
    await this.persist();
  }

  async deleteCollection(id: string): Promise<void> {
    const exists = this.data.collections.some((c) => c.id === id);
    if (!exists) {
      return;
    }
    const orphanedItems = this.data.items
      .filter((i) => i.collectionId === id)
      .sort((a, b) => a.order - b.order);
    const acceptedOrphanUris = new Set<string>();
    const collidingOrphanIds = new Set(
      orphanedItems
        .filter((item) => {
          if (this.hasDuplicateBookmark(item.uri, null) || acceptedOrphanUris.has(item.uri)) {
            return true;
          }
          acceptedOrphanUris.add(item.uri);
          return false;
        })
        .map((item) => item.id)
    );

    this.data.collections = this.data.collections.filter((c) => c.id !== id);
    this.renumber(this.data.collections);
    this.data.items = this.data.items.filter((item) => !collidingOrphanIds.has(item.id));

    const nextOrder = this.data.items.filter((i) => i.collectionId === null).length;
    orphanedItems
      .filter((item) => !collidingOrphanIds.has(item.id))
      .forEach((item, index) => {
        item.collectionId = null;
        item.order = nextOrder + index;
      });

    await this.persist();
  }

  /** Runs any pending mirror write immediately. Called from deactivate(). */
  async flushMirrorWrites(): Promise<void> {
    await this.mirrorDelayer.flush();
    await this.mirrorWriteTail;
  }

  dispose(): void {
    this.mirrorDelayer.dispose();
  }

  detachMirror(): void {
    this.mirrorBinding = undefined;
    this.mirrorTemporarilyDetached = true;
  }

  async rebindMirror(mirror?: MirrorPort): Promise<void> {
    // Fence off new writes synchronously. Any mutation while the old mirror drains marks
    // workspaceState dirty and is reconciled into the replacement binding.
    this.mirrorTemporarilyDetached = true;
    await this.enqueueMirrorOperation(async () => {
      await this.flushMirrorWrites();
      this.mirrorBinding = mirror
        ? { generation: this.nextMirrorGeneration++, port: mirror }
        : undefined;
      this.mirrorTemporarilyDetached = mirror === undefined;
    });
  }

  /**
   * Activation-time reconcile between workspaceState and the mirror file.
   *
   * A dirty flag makes workspaceState win after a failed write. Otherwise, workspaceState wins
   * unless the file's hash differs from the last successful write, proving an external edit.
   */
  async syncWithMirror(): Promise<void> {
    const binding = this.mirrorBinding;
    if (!binding) {
      return;
    }
    await this.enqueueMirrorOperation(() => this.syncWithMirrorNow(binding));
  }

  private async syncWithMirrorNow(binding: MirrorBinding): Promise<void> {
    const revision = this.dataRevision;
    await this.flushMirrorWrites();
    if (!this.isCurrentMirror(binding) || this.dataRevision !== revision) {
      return;
    }
    if (this.state.get<boolean>(MIRROR_DIRTY_KEY) === true) {
      await this.writeCurrentData(binding);
      return;
    }
    let content: string | undefined;
    try {
      content = await binding.port.read();
    } catch (error: unknown) {
      this.logMirrorFailure('read', error);
      return;
    }
    if (!this.isCurrentMirror(binding) || this.dataRevision !== revision) {
      return;
    }
    if (content === undefined) {
      await this.writeCurrentData(binding);
      return;
    }
    if (this.state.get<string>(MIRROR_HASH_KEY) === hashContent(content)) {
      return;
    }
    await this.adoptMirrorContent(content, binding, revision);
  }

  /** Watcher-driven reload. Ignores events whose content is this process's own last write. */
  async reloadFromMirror(): Promise<void> {
    const binding = this.mirrorBinding;
    if (!binding) {
      return;
    }
    await this.enqueueMirrorOperation(() => this.reloadFromMirrorNow(binding));
  }

  private async reloadFromMirrorNow(binding: MirrorBinding): Promise<void> {
    const revision = this.dataRevision;
    await this.flushMirrorWrites();
    if (!this.isCurrentMirror(binding) || this.dataRevision !== revision) {
      return;
    }
    if (this.state.get<boolean>(MIRROR_DIRTY_KEY) === true) {
      await this.writeCurrentData(binding);
      return;
    }
    let content: string | undefined;
    try {
      content = await binding.port.read();
    } catch (error: unknown) {
      this.logMirrorFailure('read', error);
      return;
    }
    if (!this.isCurrentMirror(binding) || this.dataRevision !== revision) {
      return;
    }
    if (content === undefined) {
      this.output.appendLine(
        `BookmarkStore: ${MIRROR_RELATIVE_PATH} was deleted — keeping the current bookmarks; the file is recreated on the next change.`
      );
      return;
    }
    if (this.state.get<string>(MIRROR_HASH_KEY) === hashContent(content)) {
      return; // Our own write, echoed back by the watcher.
    }
    await this.adoptMirrorContent(content, binding, revision);
  }

  private scheduleMirrorWrite(): void {
    const binding = this.mirrorBinding;
    if (!binding || this.mirrorTemporarilyDetached) {
      return;
    }
    const content = serializeBookmarkData(this.data);
    const revision = this.dataRevision;
    this.mirrorDelayer.trigger(() => this.writeMirrorNow(binding, content, revision));
  }

  private writeCurrentData(binding: MirrorBinding): Promise<void> {
    return this.writeMirrorNow(
      binding,
      serializeBookmarkData(this.data),
      this.dataRevision
    );
  }

  private writeMirrorNow(
    binding: MirrorBinding,
    content: string,
    revision: number
  ): Promise<void> {
    const operation = this.mirrorWriteTail.then(
      () => this.performMirrorWrite(binding, content, revision)
    );
    this.mirrorWriteTail = operation.catch(() => undefined);
    return operation;
  }

  private async performMirrorWrite(
    binding: MirrorBinding,
    content: string,
    revision: number
  ): Promise<void> {
    try {
      await binding.port.write(content);
    } catch (error: unknown) {
      this.logMirrorFailure('write', error);
      // Persist the fact that workspaceState is newer so a fresh activation retries
      // this write instead of adopting the stale mirror file.
      await this.state.update(MIRROR_DIRTY_KEY, true);
      return;
    }
    if (!this.isCurrentMirror(binding) || this.dataRevision !== revision) {
      return;
    }
    // Recorded only after a confirmed successful write — never at schedule time.
    await this.state.update(MIRROR_HASH_KEY, hashContent(content));
    if (!this.isCurrentMirror(binding) || this.dataRevision !== revision) {
      return;
    }
    await this.state.update(MIRROR_DIRTY_KEY, undefined);
  }

  private async adoptMirrorContent(
    content: string,
    binding: MirrorBinding,
    revision: number
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      this.rejectMirrorContent('it is not valid JSON');
      return;
    }
    if (!isStrictBookmarkData(parsed)) {
      this.rejectMirrorContent('its shape does not match the bookmarks schema');
      return;
    }
    let migrated;
    try {
      migrated = migrateBookmarkData(parsed);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.rejectMirrorContent(message);
      return;
    }

    const { data, changed, notes } = normalizeBookmarkData(migrated);
    if (!this.isCurrentMirror(binding) || this.dataRevision !== revision) {
      return;
    }
    this.data = data;
    this.dataRevision++;
    const adoptedRevision = this.dataRevision;
    await this.state.update(STORAGE_KEY, this.data);
    if (!this.isCurrentMirror(binding) || this.dataRevision !== adoptedRevision) {
      return;
    }
    await this.state.update(MIRROR_HASH_KEY, hashContent(content));
    if (!this.isCurrentMirror(binding) || this.dataRevision !== adoptedRevision) {
      return;
    }
    this._onBookmarksChanged.fire();

    if (changed) {
      for (const note of notes) {
        this.output.appendLine(`BookmarkStore: ${note}`);
      }
      // The adopted data differs from what is on disk — converge the file.
      this.scheduleMirrorWrite();
    }
  }

  private enqueueMirrorOperation(operation: () => void | Promise<void>): Promise<void> {
    const result = this.mirrorOperationTail.then(operation);
    this.mirrorOperationTail = result.catch(() => undefined);
    return result;
  }

  private isCurrentMirror(binding: MirrorBinding): boolean {
    return !this.mirrorTemporarilyDetached &&
      this.mirrorBinding?.generation === binding.generation;
  }

  private rejectMirrorContent(reason: string): void {
    this.output.appendLine(
      `BookmarkStore: ignoring ${MIRROR_RELATIVE_PATH} because ${reason} — keeping the last known good bookmarks. The file is overwritten on your next bookmark change.`
    );
  }

  private logMirrorFailure(operation: 'read' | 'write', error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`BookmarkStore: could not ${operation} ${MIRROR_RELATIVE_PATH} — ${message}`);
  }
}
