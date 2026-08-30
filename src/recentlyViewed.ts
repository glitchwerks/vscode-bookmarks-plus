import * as vscode from 'vscode';

/**
 * Issue #108 — a plain most-recently-viewed (MRU) list backing the "Recent" tree row.
 *
 * Deliberately a separate module from `recentItems.ts` (#95), for the same reason `recentItems.ts`
 * is itself separate from `BookmarkData`/`bookmarks.data`: a per-user browsing-history concern must
 * not be folded into another one, even a closely related one. Where `recentItems.ts` exists to
 * decide which recently-opened items are worth *suggesting as bookmarks* — and so carries a
 * preview-open promotion threshold, `firstSeen`/`previewCount`/`promoted` bookkeeping, and a
 * user-configurable cap — this module answers a much simpler question: "what did the user look at
 * most recently?" That has no threshold, no promotion state, and a fixed cap
 * (`RECENTLY_VIEWED_MAX_ITEMS`), so it is intentionally a bare `string[]` of uris rather than a
 * richer record type, with its own `workspaceState` key independent of `recentItems.ts`'s
 * `RECENT_STORAGE_KEY`.
 */

/** `workspaceState` key for the recently-viewed list — independent of `RECENT_STORAGE_KEY` (#95). */
export const RECENTLY_VIEWED_STORAGE_KEY = 'bookmarks.recentlyViewed';

/** Fixed MRU cap — not user-configurable, unlike `SuggestionsSource.maxItems` (#95/#102). */
export const RECENTLY_VIEWED_MAX_ITEMS = 10;

/**
 * Pure list-update function: moves `uri` to the front of `list` (inserting it if new), then
 * truncates to `cap`, dropping the oldest (tail) entries. There is no preview concept here —
 * unlike `recentItems.ts`'s `recordOpen`, every view moves the uri to the front regardless of how
 * it was opened.
 *
 * A `cap` of 0 or less yields an empty list, mirroring `enforceCap`'s "0 disables it" semantics in
 * `recentItems.ts`.
 */
export function recordView(list: string[], uri: string, cap: number): string[] {
  const withoutUri = list.filter((existing) => existing !== uri);
  const updated = [uri, ...withoutUri];
  const flooredCap = Math.max(0, Math.floor(cap));
  return updated.slice(0, flooredCap);
}

/**
 * Loads the persisted recently-viewed list, discarding malformed state defensively — mirrors
 * `loadRecentItems`'s (`recentItems.ts`) discard-on-invalid posture. Non-string and empty-string
 * entries are filtered out individually rather than discarding the whole list.
 */
export function loadRecentlyViewed(memento: vscode.Memento): string[] {
  const raw = memento.get<unknown>(RECENTLY_VIEWED_STORAGE_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function saveRecentlyViewed(memento: vscode.Memento, list: string[]): Thenable<void> {
  return memento.update(RECENTLY_VIEWED_STORAGE_KEY, list);
}
