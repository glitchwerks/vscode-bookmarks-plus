import { randomUUID } from 'node:crypto';

import {
  BackendError,
  type AddBookmarkInput,
  type BookmarkBackend,
  type MirrorAddBookmarkResult,
  type MirrorListResult,
  type ScopedBookmarkCollection,
} from './backend.js';
import type { Config } from './config.js';
import {
  MAX_SUPPORTED_VERSION,
  parseMirror,
  serialize,
  toCanonicalV2,
  type BookmarkCollection,
  type BookmarkData,
  type BookmarkItem,
} from './contract.js';
import { readMirror, writeMirrorAtomic } from './mirrorFile.js';

interface MirrorBackendDependencies {
  readMirror: typeof readMirror;
  writeMirrorAtomic: typeof writeMirrorAtomic;
  sleep: (ms: number) => Promise<void>;
  uuid: () => string;
}

const defaultDependencies: MirrorBackendDependencies = {
  readMirror,
  writeMirrorAtomic,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  uuid: randomUUID,
};

/** Uses the existing workspace mirror as a workspace-only bookmark backend. */
export class MirrorBookmarkBackend implements BookmarkBackend {
  readonly mode = 'mirror' as const;
  private readonly deps: MirrorBackendDependencies;

  constructor(
    private readonly config: Config,
    dependencies: Partial<MirrorBackendDependencies> = {},
  ) {
    this.deps = { ...defaultDependencies, ...dependencies };
  }

  /** Reads the mirror without changing its version or contents. */
  async list(): Promise<MirrorListResult> {
    let raw: string | undefined;
    try {
      raw = await this.deps.readMirror(this.config.mirrorPath);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BackendError('store-unavailable', `Failed to read the bookmarks mirror file: ${detail}`);
    }
    const parsed = parseMirror(raw);
    if (parsed.kind === 'error') {
      throw new BackendError('internal-error', parsed.message);
    }
    const data = parsed.kind === 'empty' ? undefined : parsed.data;
    return {
      workspacePath: this.config.workspacePath,
      mirrorPath: this.config.mirrorPath,
      ...(data === undefined ? {} : { version: data.version }),
      collections: (data?.collections ?? []).map((collection) => ({
        id: collection.id,
        name: collection.name,
        order: collection.order,
        description: collection.description,
        scope: 'workspace',
      })),
      items: (data?.items ?? []).map((item) => ({
        id: item.id,
        type: item.type,
        uri: item.uri,
        collectionId: item.collectionId,
        order: item.order,
        description: item.description,
        scope: 'workspace',
      })),
    };
  }

  /** Adds one workspace bookmark, preserving the historical mirror write and retry behavior. */
  async add(input: AddBookmarkInput): Promise<MirrorAddBookmarkResult> {
    if (input.scope === 'global') {
      throw new BackendError('scope-unavailable', 'Global bookmark scope is unavailable in mirror mode.');
    }

    const first = await this.addOnce(input);
    if (first instanceof BackendError) {
      throw first;
    }
    let successful = first;
    if (!first.survived) {
      const second = await this.addOnce(input);
      if (second instanceof BackendError) {
        let retry: BookmarkData;
        try {
          retry = await this.readData();
        } catch (error: unknown) {
          if (error instanceof BackendError && error.code === 'internal-error') {
            throw second;
          }
          throw error;
        }
        if (retry.items.some((item) => item.id === first.item.id)) {
          successful = { ...first, survived: true };
        } else {
          throw second;
        }
      } else {
        successful = second;
      }
    }
    if (!successful.survived) {
      throw new BackendError('store-unavailable', 'the bookmark was written but did not survive — VS Code is probably running and overwrote the file. Retry, or add it from the Bookmarks view.');
    }
    return {
      id: successful.item.id,
      mirrorPath: this.config.mirrorPath,
      scope: 'workspace',
      collection: successful.collection === null ? null : this.scopedCollection(successful.collection),
    };
  }

  /** Releases mirror resources; the filesystem backend owns no persistent handles. */
  async close(): Promise<void> {}

  private async addOnce(input: AddBookmarkInput): Promise<{ item: BookmarkItem; collection: BookmarkCollection | null; survived: boolean } | BackendError> {
    let data: BookmarkData;
    try {
      data = await this.readData();
    } catch (error: unknown) {
      if (error instanceof BackendError && error.code === 'internal-error') {
        return error;
      }
      throw error;
    }
    const collection = this.resolveCollection(input, data.collections);
    if (collection instanceof BackendError) {
      return collection;
    }
    const collectionId = collection?.id ?? null;
    if (data.items.some((item) => item.uri === input.uri && item.collectionId === collectionId)) {
      return new BackendError('duplicate-bookmark', `A bookmark for "${input.uri}" already exists in the resolved collection.`);
    }
    const description = input.description?.trim();
    const siblingOrders = data.items.filter((item) => item.collectionId === collectionId).map((item) => item.order);
    const item: BookmarkItem = {
      id: this.deps.uuid(), type: input.type, uri: input.uri, collectionId,
      order: siblingOrders.length === 0 ? 0 : Math.max(...siblingOrders) + 1,
      ...(description === undefined || description.length === 0 ? {} : { description }),
    };
    data.items.push(item);
    await this.deps.writeMirrorAtomic(this.config.mirrorPath, serialize(toCanonicalV2(data)));
    if (this.config.verifyDelayMs === 0) {
      return { item, collection, survived: true };
    }
    await this.deps.sleep(this.config.verifyDelayMs);
    try {
      const verification = await this.readData();
      return { item, collection, survived: verification.items.some((candidate) => candidate.id === item.id) };
    } catch (error: unknown) {
      if (error instanceof BackendError && error.code === 'internal-error') {
        return { item, collection, survived: false };
      }
      throw error;
    }
  }

  private async readData(): Promise<BookmarkData> {
    let raw: string | undefined;
    try {
      raw = await this.deps.readMirror(this.config.mirrorPath);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BackendError('store-unavailable', `Failed to read the bookmarks mirror file: ${detail}`);
    }
    const parsed = parseMirror(raw);
    if (parsed.kind === 'error') {
      throw new BackendError('internal-error', parsed.message);
    }
    return parsed.kind === 'empty' ? { version: MAX_SUPPORTED_VERSION, items: [], collections: [] } : parsed.data;
  }

  private resolveCollection(input: AddBookmarkInput, collections: BookmarkCollection[]): BookmarkCollection | null | BackendError {
    const candidate = input.collectionId === undefined
      ? input.collectionName === undefined ? undefined : collections.find((collection) => collection.name === input.collectionName)
      : collections.find((collection) => collection.id === input.collectionId);
    if (input.collectionId !== undefined && candidate === undefined) {
      return new BackendError('collection-not-found', `Unknown collectionId "${input.collectionId}". ${this.validCollectionsMessage(collections)}`);
    }
    if (input.collectionName !== undefined && candidate === undefined) {
      return new BackendError('collection-not-found', `Unknown collectionName "${input.collectionName}". ${this.validCollectionsMessage(collections)}`);
    }
    return candidate ?? null;
  }

  private validCollectionsMessage(collections: BookmarkCollection[]): string {
    return collections.length === 0 ? 'There are no valid collections in the mirror file.' : `Valid collections: ${collections.map((collection) => `${collection.id} (${collection.name})`).join(', ')}.`;
  }

  private scopedCollection(collection: BookmarkCollection): ScopedBookmarkCollection {
    return { ...collection, scope: 'workspace' };
  }
}
