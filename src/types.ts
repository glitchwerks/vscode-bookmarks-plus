export type BookmarkScope = 'workspace' | 'global';

export interface BookmarkItem {
  id: string;                    // uuid
  type: 'file' | 'folder';
  uri: string;                   // vscode.Uri.toString() — always absolute, never workspace-relative
  collectionId: string | null;   // null = root/ungrouped
  order: number;                 // zero-based, unique within its parent
  description?: string;          // optional free-text note; undefined = none (schema v2)
}

export interface BookmarkCollection {
  id: string;
  name: string;
  order: number;                 // zero-based, unique among collections
  description?: string;          // optional free-text note; undefined = none (schema v2)
}

export interface BookmarkData {
  version: number;               // schema version — see src/migrations.ts
  items: BookmarkItem[];
  collections: BookmarkCollection[];
}

export const CURRENT_SCHEMA_VERSION = 2;

export function emptyBookmarkData(): BookmarkData {
  return { version: CURRENT_SCHEMA_VERSION, items: [], collections: [] };
}

/**
 * Loose, shallow shape check. Used for the workspaceState load path, where anything
 * that fails is discarded in favour of an empty state (spec §3/§6).
 */
export function isValidBookmarkData(value: unknown): value is BookmarkData {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.version === 'number' && Array.isArray(v.items) && Array.isArray(v.collections);
}

export function isValidBookmarkItem(value: unknown): value is BookmarkItem {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    (v.type === 'file' || v.type === 'folder') &&
    typeof v.uri === 'string' &&
    v.uri.length > 0 &&
    (v.collectionId === null || typeof v.collectionId === 'string') &&
    typeof v.order === 'number' &&
    Number.isFinite(v.order) &&
    (v.description === undefined || typeof v.description === 'string')
  );
}

export function isValidBookmarkCollection(value: unknown): value is BookmarkCollection {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.order === 'number' &&
    Number.isFinite(v.order) &&
    (v.description === undefined || typeof v.description === 'string')
  );
}

/**
 * Deep shape check. Used for the mirror-file load path, where the author may be an
 * external process that does not know this schema — a single malformed entry must
 * reject the whole payload rather than silently dropping the user's data.
 */
export function isStrictBookmarkData(value: unknown): value is BookmarkData {
  if (!isValidBookmarkData(value)) {
    return false;
  }
  return value.items.every(isValidBookmarkItem) && value.collections.every(isValidBookmarkCollection);
}

/** Trims a description and collapses empty/whitespace-only values to undefined (= no description). */
export function normalizeDescription(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
