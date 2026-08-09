export interface BookmarkItem {
  id: string;
  type: 'file' | 'folder';
  uri: string;
  collectionId: string | null;
  order: number;
  description?: string;
}

export interface BookmarkCollection {
  id: string;
  name: string;
  order: number;
  description?: string;
}

export interface BookmarkData {
  version: number;
  items: BookmarkItem[];
  collections: BookmarkCollection[];
}

export const MAX_SUPPORTED_VERSION = 2;

export type ParseResult =
  | { kind: 'empty' }
  | { kind: 'ok'; data: BookmarkData }
  | { kind: 'error'; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBookmarkItem(value: unknown): value is BookmarkItem {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.type === 'file' || value.type === 'folder') &&
    typeof value.uri === 'string' &&
    (value.collectionId === null || typeof value.collectionId === 'string') &&
    typeof value.order === 'number' &&
    (value.description === undefined || typeof value.description === 'string')
  );
}

function isBookmarkCollection(value: unknown): value is BookmarkCollection {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.order === 'number' &&
    (value.description === undefined || typeof value.description === 'string')
  );
}

export function parseMirror(raw: string | undefined): ParseResult {
  if (raw === undefined) {
    return { kind: 'empty' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Invalid JSON: ${detail}` };
  }

  if (!isPlainObject(parsed)) {
    return { kind: 'error', message: 'Mirror data must be a plain object.' };
  }

  if (!Number.isInteger(parsed.version) || (parsed.version as number) < 1) {
    return { kind: 'error', message: 'Mirror schema version must be an integer of at least 1.' };
  }

  if ((parsed.version as number) > MAX_SUPPORTED_VERSION) {
    return {
      kind: 'error',
      message:
        `This mirror file was written by a newer version of the extension ` +
        `(schema version ${String(parsed.version)}). Upgrade the MCP server to read it.`,
    };
  }

  if (!Array.isArray(parsed.items)) {
    return { kind: 'error', message: 'Mirror data items must be an array.' };
  }

  if (!Array.isArray(parsed.collections)) {
    return { kind: 'error', message: 'Mirror data collections must be an array.' };
  }

  if (!parsed.items.every(isBookmarkItem)) {
    return { kind: 'error', message: 'Mirror data contains an invalid bookmark item.' };
  }

  if (!parsed.collections.every(isBookmarkCollection)) {
    return { kind: 'error', message: 'Mirror data contains an invalid bookmark collection.' };
  }

  return { kind: 'ok', data: parsed as unknown as BookmarkData };
}

export function toCanonicalV2(data: BookmarkData): BookmarkData {
  return { ...data, version: MAX_SUPPORTED_VERSION };
}

export function serialize(data: BookmarkData): string {
  return JSON.stringify(data, null, 2) + '\n';
}
