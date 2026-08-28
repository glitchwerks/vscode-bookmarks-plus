import * as vscode from 'vscode';

/**
 * Issue #95 — suggested bookmarks from recently opened items.
 *
 * Deliberately a new module with its own `workspaceState` key, separate from `BookmarkData` /
 * `bookmarks.data` (plan §3, C1): a per-user browsing history must never be folded into the
 * versioned, mirrored bookmark schema.
 */

/** New `workspaceState` key for the recently-opened-items list (C1/D4). */
export const RECENT_STORAGE_KEY = 'bookmarks.recentlyOpened';

/**
 * A preview open only promotes an entry into a real suggestion once this many preview opens of
 * the same uri have been recorded (D2, RESOLVED). A non-preview open always promotes immediately,
 * regardless of `previewCount`.
 */
export const PREVIEW_PROMOTION_THRESHOLD = 3;

export interface RecentItem {
  uri: string;
  /**
   * The timestamp (`Date.now()`-shaped) of the open that made this entry a suggestion — either
   * the promoting preview open or a non-preview open. Used for the D6 "most-recent-first-seen
   * first" sort; re-opening an already-promoted entry does not update it, so clicking a
   * suggestion does not reorder the list out from under the user (D6/R1).
   */
  firstSeen: number;
  /** Count of preview opens recorded before promotion. No longer meaningful once `promoted`. */
  previewCount: number;
  /** Whether this entry has crossed the preview threshold (or was opened non-preview) and is
   *  eligible to surface as a suggestion. */
  promoted: boolean;
}

function isValidRecentItem(value: unknown): value is RecentItem {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.uri === 'string' &&
    v.uri.length > 0 &&
    typeof v.firstSeen === 'number' &&
    Number.isFinite(v.firstSeen) &&
    typeof v.previewCount === 'number' &&
    Number.isFinite(v.previewCount) &&
    typeof v.promoted === 'boolean'
  );
}

/**
 * Evicts promoted entries beyond `cap`, oldest-`firstSeen`-first (D3/D6). Sub-threshold preview
 * entries are never evicted here — they don't compete for the cap's slots (D2 cap interaction,
 * required for R2's mitigation to hold).
 */
function enforceCap(list: RecentItem[], cap: number): RecentItem[] {
  const promotedByAge = list.filter((i) => i.promoted).sort((a, b) => a.firstSeen - b.firstSeen);
  const overflow = promotedByAge.length - cap;
  if (overflow <= 0) {
    return list;
  }
  const evictUris = new Set(promotedByAge.slice(0, overflow).map((i) => i.uri));
  return list.filter((i) => !evictUris.has(i.uri));
}

/**
 * Pure list-update function (C2): records a single open of `entry.uri`, applying the D2
 * count-based preview-promotion rule, then enforces `cap` on the promoted subset (D3/D6).
 *
 * @param cap the configured `bookmarksPlus.suggestions.maxItems` value.
 * @param now the timestamp of this open (injected rather than read from `Date.now()` so the
 *   function stays pure and unit-testable).
 */
export function recordOpen(
  list: RecentItem[],
  entry: { uri: string; isPreview: boolean },
  cap: number,
  now: number
): RecentItem[] {
  const existingIndex = list.findIndex((i) => i.uri === entry.uri);
  const existing = existingIndex >= 0 ? list[existingIndex] : undefined;

  let updated: RecentItem;
  if (existing?.promoted) {
    // Already a real suggestion — re-opening it (preview or not) must not shift firstSeen (D6)
    // or un-promote it.
    updated = existing;
  } else if (!entry.isPreview) {
    // A non-preview open promotes immediately, independent of previewCount (D2).
    updated = {
      uri: entry.uri,
      firstSeen: now,
      previewCount: existing?.previewCount ?? 0,
      promoted: true
    };
  } else {
    const previewCount = (existing?.previewCount ?? 0) + 1;
    const promoted = previewCount >= PREVIEW_PROMOTION_THRESHOLD;
    updated = {
      uri: entry.uri,
      // firstSeen only advances to "now" on the open that crosses the threshold — the promoting
      // open — not the first preview (D2 firstSeen interaction).
      firstSeen: promoted ? now : existing?.firstSeen ?? now,
      previewCount,
      promoted
    };
  }

  const withoutExisting =
    existingIndex >= 0 ? [...list.slice(0, existingIndex), ...list.slice(existingIndex + 1)] : list;
  return enforceCap([...withoutExisting, updated], cap);
}

/**
 * Loads the persisted recent-items list, discarding malformed state defensively — mirrors
 * `isValidBookmarkData`'s discard-on-invalid posture (`src/types.ts`, `isValidBookmarkData`).
 */
export function loadRecentItems(memento: vscode.Memento): RecentItem[] {
  const raw = memento.get<unknown>(RECENT_STORAGE_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isValidRecentItem);
}

export function saveRecentItems(memento: vscode.Memento, list: RecentItem[]): Thenable<void> {
  return memento.update(RECENT_STORAGE_KEY, list);
}

/**
 * Tab-adapter (C2/T3): the only place `instanceof vscode.TabInput*` narrowing happens. `Tab.input`
 * bottoms out in `unknown` with no discriminator field, so this is necessarily runtime-class-based
 * rather than type-driven. Accepts `TabInputText` / `TabInputCustom` / `TabInputNotebook`; rejects
 * `TabInputTextDiff` (no single uri, D1: skipped entirely in v1), terminals, webviews, and any
 * non-`file`-scheme uri (C6).
 */
export function extractTabUri(input: unknown): vscode.Uri | undefined {
  let uri: vscode.Uri | undefined;
  if (input instanceof vscode.TabInputText) {
    uri = input.uri;
  } else if (input instanceof vscode.TabInputCustom) {
    uri = input.uri;
  } else if (input instanceof vscode.TabInputNotebook) {
    uri = input.uri;
  } else {
    return undefined;
  }
  return uri.scheme === 'file' ? uri : undefined;
}
