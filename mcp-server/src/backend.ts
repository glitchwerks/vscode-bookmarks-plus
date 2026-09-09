import type { BookmarkCollection, BookmarkItem } from './contract.js';
import type { BookmarkScope, BridgeOperationCode } from './liveBridgeProtocol.js';

export type { BookmarkScope };

export type ScopedBookmarkItem = BookmarkItem & { scope: BookmarkScope };
export type ScopedBookmarkCollection = BookmarkCollection & { scope: BookmarkScope };

export interface MirrorListResult {
  workspacePath: string;
  mirrorPath: string;
  version?: number;
  collections: ScopedBookmarkCollection[];
  items: ScopedBookmarkItem[];
}

export interface LiveListResult {
  version: number;
  workspaceFolderUri: string;
  grantedScopes: BookmarkScope[];
  collections: ScopedBookmarkCollection[];
  items: ScopedBookmarkItem[];
}

export type ScopedBookmarkResult = MirrorListResult | LiveListResult;

export interface AddBookmarkInput {
  uri: string;
  type: 'file' | 'folder';
  scope?: BookmarkScope;
  collectionId?: string;
  collectionName?: string;
  description?: string;
}

export interface AddBookmarkResult {
  id: string;
  scope: BookmarkScope;
  collection: ScopedBookmarkCollection | null;
}

export interface MirrorAddBookmarkResult extends AddBookmarkResult {
  mirrorPath: string;
}

export interface BookmarkBackend {
  readonly mode: 'mirror' | 'live';
  list(): Promise<ScopedBookmarkResult>;
  add(input: AddBookmarkInput): Promise<AddBookmarkResult>;
  close(): Promise<void>;
}

/** Represents an expected backend failure that is safe to expose to MCP clients. */
export class BackendError extends Error {
  constructor(readonly code: BridgeOperationCode, message: string) {
    super(message);
    this.name = 'BackendError';
  }
}
