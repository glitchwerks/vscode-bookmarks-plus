import * as vscode from 'vscode';
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
 * ∪ global). Unlike `decorationUriKey` (the #109 star-badge normalization), this key is compared
 * by VS Code itself — via `resourcePath in <key>` — against its own live `resourcePath`
 * when-clause value, which is never lower-cased beyond `Uri.fsPath`'s own built-in drive-letter
 * normalization. So a `file:` scheme uri is keyed by plain, unmodified `uri.fsPath` — never
 * platform-gated, never additionally lower-cased — to stay byte-for-byte comparable with
 * `resourcePath` (issue #119). Any other scheme falls back to `uri.toString()`, matching
 * `decorationUriKey`'s own non-`file` fallback. A malformed or relative stored `uri` is skipped
 * for that entry only — never throws — mirroring `buildDecoratedUriKeys`'s C2 contract in
 * `bookmarkDecorationProvider.ts`.
 */
export function buildBookmarkedResourceKeys(itemGroups: BookmarkItem[][]): string[] {
  const keys = new Set<string>();
  for (const items of itemGroups) {
    for (const item of items) {
      try {
        const uri = vscode.Uri.parse(item.uri, true);
        keys.add(uri.scheme === 'file' ? uri.fsPath : uri.toString());
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
 * in `vscode`'s `src/vs/workbench/common/contextkeys.ts`), so `buildBookmarkedResourceKeys` keys
 * `file:` uris by plain, unmodified `uri.fsPath` — never platform-gated, never additionally
 * lower-cased — to stay byte-for-byte comparable with `resourcePath` on every platform (issue
 * #119). This intentionally diverges from `decorationUriKey`, which additionally lower-cases the
 * whole `fsPath` on win32 to normalize drive-letter-case/escaping differences between an
 * Explorer-constructed Uri and an externally-authored stored uri string for the #109 star-badge
 * map — a normalization that only needs to hold between two values the decoration provider itself
 * controls, not between this array and VS Code's own unmodified `resourcePath` value.
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
