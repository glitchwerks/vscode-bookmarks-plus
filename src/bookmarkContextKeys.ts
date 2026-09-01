import * as vscode from 'vscode';
import { decorationUriKey } from './bookmarkDecorationProvider';
import { BookmarkItem } from './types';
import { BookmarkStore } from './bookmarkStore';

/**
 * The `when`-clause context key name (issue #114) that reports which resources are currently
 * bookmarked, in the shape VS Code's `resourceUri in <key>` operator expects — a context value
 * that is itself an array of uri-identity strings, checked for membership against the
 * right-clicked resource's `resourceUri`. Registered against this exact name in package.json.
 */
export const BOOKMARKED_RESOURCE_CONTEXT_KEY = 'bookmarksPlus.bookmarkedResourceUris';

/**
 * Builds the union of bookmarked-resource keys across one or more stores' item lists (workspace
 * ∪ global), keyed identically to `decorationUriKey` (the already-shipped #109 star-badge
 * normalization) so a resource that shows the star badge is exactly the set of resources this
 * reports as bookmarked. A malformed or relative stored `uri` is skipped for that entry only —
 * never throws — mirroring `buildDecoratedUriKeys`'s C2 contract in `bookmarkDecorationProvider.ts`.
 */
export function buildBookmarkedResourceKeys(itemGroups: BookmarkItem[][]): string[] {
  const keys = new Set<string>();
  for (const items of itemGroups) {
    for (const item of items) {
      try {
        keys.add(decorationUriKey(vscode.Uri.parse(item.uri, true)));
      } catch {
        // Skip this item only — the rest of the batch keeps processing.
      }
    }
  }
  return Array.from(keys);
}

export interface BookmarkContextKeyDeps {
  setContext: (key: string, value: string[]) => void | Thenable<unknown>;
}

/**
 * Wires one or more `BookmarkStore`s to `BOOKMARKED_RESOURCE_CONTEXT_KEY` via an injected
 * `setContext` dependency (mirroring the existing `AddToWorkspaceDeps` DI pattern in
 * commands.ts), so the Explorer/editor context menus can show "Remove Bookmark" instead of "Add
 * Bookmark" for an already-bookmarked resource.
 *
 * `wire()` publishes the full, recomputed union on every store change (bulk `reloadFromMirror()`
 * replacement included) — not a diff — since a context-key value has no notion of incremental
 * update, unlike the decoration provider's per-uri fire. An unchanged mirror echo never reaches
 * this class at all: `BookmarkStore.reloadFromMirror()` already suppresses `onBookmarksChanged`
 * for its own last write (see `bookmarkStore.ts`'s mirror-hash check), so no extra de-duplication
 * is needed here.
 *
 * package.json's `when` clauses compare this array against VS Code's built-in `resourcePath`
 * context key, not `resourceUri` — VS Code has no `resourceUri` when-clause key at all (that name
 * only exists as a `TreeItem` property), and its one full-uri key, `resource`, holds
 * `uri.toString()`, which the `in` operator's `ContextKeyInExpr` compares by strict string
 * equality against this array's entries with no fsPath-aware fallback — so keying this array by
 * anything but the exact string VS Code compares against would make the menu item never appear.
 * `resourcePath` is VS Code's own `uri.fsPath` for a `file:` resource (`AbstractResourceContextKey`
 * in `vscode`'s `src/vs/workbench/common/contextkeys.ts`), matching `decorationUriKey`'s
 * non-win32 branch exactly. The one known gap: `decorationUriKey` additionally lowercases on
 * win32 (to normalize drive-letter-case/escaping differences between an Explorer-constructed Uri
 * and an externally-authored stored uri string — the same problem #109's decoration provider
 * solves for the star badge), but `resourcePath`'s live context value is not lowercased and the
 * `in` operator's own Windows fallback only special-cases `file:///`-prefixed strings, not bare
 * fsPaths — so a bookmark stored with different drive-letter casing than the resource VS Code
 * currently reports will not match on Windows. This is a narrow, pre-existing-pattern edge case,
 * not a general break: the common path (bookmark added via the same Explorer/editor Uri later
 * used to remove it) matches exactly.
 */
export class BookmarkContextKeyManager {
  private keys: string[] = [];

  constructor(private readonly deps: BookmarkContextKeyDeps) {}

  getBookmarkedResourceKeys(): string[] {
    return this.keys;
  }

  wire(stores: BookmarkStore[]): void {
    const publish = (): void => {
      this.keys = buildBookmarkedResourceKeys(stores.map((store) => store.getAll().items));
      void this.deps.setContext(BOOKMARKED_RESOURCE_CONTEXT_KEY, this.keys);
    };
    publish();
    for (const store of stores) {
      store.onBookmarksChanged(publish);
    }
  }
}
