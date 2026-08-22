---
touches: ["src/**"] # from-scratch project — this is the entire future source tree, deliberately unscoped
---

# VSCode Bookmarks Plus — Design Spec

- **Status:** Approved — incorporates project-reviewer architectural review, 2026-07-22
- **Tracking issue:** #1 ("Write and commit initial design spec")
- **Milestone:** v1.0

## 1. Overview

VSCode Bookmarks Plus is a VS Code extension that bookmarks **files and folders**, not just lines. Every existing "Bookmarks"-style extension the author has tried stops at line-level bookmarking inside a single file — this extension fills that gap by treating whole files and whole folders as first-class bookmarkable items.

Key scoping decisions:

- **Per-workspace scope, extended with a global scope (issue #55).** Workspace bookmarks are still stored per workspace and work for both single-root and multi-root workspaces — this original decision and its rationale are unchanged. A second, workspace-independent scope was added alongside it, not in place of it, so a bookmark can be "always available" rather than tied to one workspace. See [§2 Architecture](#2-architecture) for the storage detail and [§3 Data model](#3-data-model) for how a scope is recorded.
- **Language/tooling:** TypeScript, scaffolded with `yo code`, bundled with esbuild.
- **Target:** publish to the VS Code Marketplace. This requires a publisher id, a 128x128 `icon.png`, a README with a screenshot, a `CHANGELOG.md`, a `LICENSE`, and semantic versioning in `package.json` (see [§8 Packaging / publishing](#8-packaging--publishing)).

## 2. Architecture

Three core pieces make up the extension:

- **`BookmarkStore`** — wraps a `vscode.Memento`. It is the single source of truth for whichever store owns it, and is the *only* thing that touches that Memento; no other component reads or writes it directly. **Revised by issue #55 (2026-08-15).** Two instances of the same class now exist side by side: the original wraps `context.workspaceState` exactly as before, and a second wraps `context.globalState`. See "Global scope" below.
- **`BookmarksTreeDataProvider`** — implements `vscode.TreeDataProvider` and `TreeDragAndDropController`. Drag-and-drop supports reordering within a parent and reassigning an item to a different collection. Collections render as parent nodes; ungrouped items render at the root.
- **Commands** — registered via `contributes.commands` / `contributes.menus`, exposed through the Explorer context menu and the command palette.

Supporting UI surface:

- A new Activity Bar container with one view, `bookmarksView`. **Unchanged by issue #55** — global bookmarks render inside this same view as a pinned root row rather than a second view (see [§4](#4-ui--tree-view)). A second view was considered and rejected because it does not conform to issue #55's acceptance criteria (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).

### Global scope (issue #55)

A bookmark now belongs to one of two scopes, `'workspace'` or `'global'` (see [§3 Data model](#3-data-model) for the `BookmarkScope` type and where it is recorded). The two scopes are backed by two independent `BookmarkStore` instances rather than a second class or a scope field on the stored data:

- **Workspace store** — unchanged: wraps `context.workspaceState`, one instance per workspace, mirrored to `.vscode/bookmarks.json` when exactly one workspace folder is open.
- **Global store** — new: wraps `context.globalState`, one instance per VS Code installation, shared across every workspace the user opens. It has **no mirror file** — there is no unambiguous single-workspace location for one — so the MCP server, which reads only the mirror file, has no path to global bookmarks and stays unaffected by this change by construction, not by an explicit exclusion it has to implement (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).
- **No Settings Sync.** `setKeysForSync` is never called on the global store's `Memento`. Cross-machine synchronization of global bookmarks is out of scope for v1 — a user's global bookmarks stay on the machine they were added on.

Command handlers resolve which of the two stores to write to from the scope carried on the tree node being acted on, via an injected `ScopedStores { workspace: BookmarkStore; global: BookmarkStore }`, rather than a duplicated command ID per scope. See [§5 Commands](#5-commands).

### Event ownership and mutation path

`BookmarkStore` exposes exactly one domain event, `onBookmarksChanged: vscode.Event<void>`, which fires once per mutating method call. `BookmarksTreeDataProvider` subscribes to `onBookmarksChanged` in its constructor and re-fires its own `onDidChangeTreeData` in response. This is a single hop — `BookmarkStore` never touches `onDidChangeTreeData` directly, and the tree provider never emits `onBookmarksChanged` — so there is exactly one event path from mutation to redraw, not two independently-firing emitters that could drift out of sync.

**All mutations, without exception, go through named `BookmarkStore` methods** — not just command handlers. The store's public surface is:

- `addItem(item)`
- `removeItem(id)`
- `moveItem(id, newCollectionId, newIndex)` — covers both drag-and-drop reassignment to a different collection and same-collection reordering; there is no separate "reorder" method
- `addCollection(name)`
- `renameCollection(id, name)`
- `deleteCollection(id)` — ungroups its items rather than deleting them (see [§3](#3-data-model) for the atomicity guarantee)
- `getAll()` — read-only, does not fire the event

`TreeDragAndDropController.handleDrop()` calls `BookmarkStore.moveItem()` directly — the exact same path every command handler uses. There is no special-case write path for drag-and-drop.

### In-memory cache for filesystem and git lookups

Resolving a bookmark's broken/valid state (`fs.stat`) and its repo badge (git lookup, see [§3](#3-data-model)) on every tree render would scale the I/O cost with tree size on every redraw, which is unbounded as the bookmark count grows. To avoid this, `BookmarksTreeDataProvider` keeps an in-memory cache, `Map<uri, { stat, repoName }>`, populated lazily as rows render. The cache is invalidated in exactly two cases:

1. Whenever `onBookmarksChanged` fires (the underlying data changed, so any cached stat/repo info may be stale).
2. Whenever the user runs the new `bookmarks.refresh` command (see [§5](#5-commands)), for cases where the filesystem or git state changed independently of the bookmark data itself (e.g. a bookmarked file was deleted outside VS Code).

There is no TTL — cache-until-invalidated is sufficient for v1, since nothing else can change stat/repo state silently.

Data flow is one-way: a command handler (or `TreeDragAndDropController.handleDrop()`) calls a `BookmarkStore` mutation method, which fires `onBookmarksChanged`, which the tree provider translates into `onDidChangeTreeData`, which causes the tree to redraw. There is no file watcher — this is deliberate and consistent with the "no auto-fix on move" decision in [§5](#5-commands).

> **Amended by issue #51 (2026-08-04).** A `FileSystemWatcher` was added for exactly one path —
> `.vscode/bookmarks.json`, the external-interop mirror file — and for that path only. The
> original decision still holds for everything else: bookmark *targets* are never watched, and a
> moved or renamed target still shows as broken with no auto-fix. See issue #51.

## 3. Data model

```ts
interface BookmarkItem {
  id: string;          // uuid
  type: 'file' | 'folder';
  uri: string;          // vscode.Uri.toString() — always the full absolute URI (file scheme), never workspace-relative
  collectionId: string | null;  // null = root/ungrouped
  order: number;        // zero-based, unique within its parent (collection or root); see ordering rules below
}

interface BookmarkCollection {
  id: string;
  name: string;
  order: number;        // zero-based, unique among collections; same renumbering rule as items
}

interface BookmarkData {
  version: number;      // schema version, for future migration
  items: BookmarkItem[];
  collections: BookmarkCollection[];
}
```

`BookmarkData` is stored as a single JSON blob under one `workspaceState` key, `bookmarks.data`. The `version` field exists to support future schema migrations.

**`uri` is always absolute.** `BookmarkItem.uri` stores the full `vscode.Uri.toString()` — an absolute, file-scheme URI — regardless of workspace layout. There is no workspace-relative form and no relative-path resolution logic anywhere in the extension. This removes the ambiguity of trying to resolve a relative path against a multi-root workspace's several roots.

**Ordering scheme.** `order` is a zero-based integer index, unique within its parent (a collection, or the root for ungrouped items/collections). On every insert, move, or delete within a parent, all siblings in that parent are renumbered in-memory to stay contiguous (`0..n-1`). This is inexpensive specifically because storage is a single JSON blob per workspace: renumbering is an in-memory array operation followed by exactly one `workspaceState.update()` call, not N separate per-sibling writes.

**Collection delete is a single atomic write.** `deleteCollection(id)` sets `collectionId: null` on every item that belonged to that collection, removes the collection itself, and performs this as one `workspaceState.update()` call for the whole `BookmarkData` blob — followed by exactly one `onBookmarksChanged` firing. There are no separate per-item writes or per-item events; this falls out of the single-blob storage model, and is called out explicitly here because the per-mutation framing in [§2](#2-architecture) could otherwise be misread as implying N writes for an N-item collection delete.

**Malformed stored data never crashes activation.** On load, the stored value is validated against the expected shape (`version` present, `items` an array, `collections` an array). If the value is missing, `null`, or fails this shape check, `BookmarkStore` initializes a fresh `{ version: CURRENT_SCHEMA_VERSION, items: [], collections: [] }` (schema version 2 as of issue #51), logs a warning to the extension's output channel, and continues normally — activation never throws on bad stored data. See also [§6 Error handling](#6-error-handling).

**Known limitation — no cross-window conflict detection.** `workspaceState` has no built-in mechanism for detecting concurrent edits from two VS Code windows on the same workspace; two windows editing bookmarks at once use last-write-wins semantics on `workspaceState.update()`. This is out of scope for v1.

**Scope is not part of the persisted schema (issue #55).** `BookmarkItem` and `BookmarkCollection` above are deliberately unchanged — there is no `scope` field on either, and no new `BookmarkData` schema version or migration rung was introduced for it. A bookmark's scope is a property of *which `BookmarkStore` instance holds the record*, not of the record itself; see [§2 Architecture](#2-architecture) for the two-store layout. The type

```ts
export type BookmarkScope = 'workspace' | 'global';
```

is carried on the transient tree-rendering node (`BookmarkNode`, defined alongside `BookmarksTreeDataProvider`, not in this section's storage types), and is a **required** field on that node's `'item'` and `'collection'` members — not optional. Requiring it, rather than defaulting an absent field to `'workspace'`, means a node with a forgotten scope tag fails to compile instead of silently routing a write into the wrong store at runtime (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).

**Duplicate URIs across scopes are intentionally allowed.** Duplicate-bookmark detection stays scoped to one store's own data and never checks the other store. The same URI may therefore be bookmarked once in the workspace store and once in the global store with no error — a global bookmark of a folder ("always available") and a workspace bookmark of the same folder ("part of this project") record different things, and a cross-store check would require one store to know about the other, breaking the single-owner invariant in [§2](#2-architecture) (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).

Git-repo information is deliberately **not** stored on `BookmarkItem`. It is resolved at render time via the `vscode.git` extension API (`repository.rootUri`) — `vscode.git` ships bundled with VS Code by default but can be disabled by the user, so it is treated as a soft dependency (see [§4](#4-ui--tree-view) and [§6](#6-error-handling)). Resolving at render time rather than storing it means a repo rename or move can't leave a stale badge in stored data.

## 4. UI / tree view

Each row renders as: icon (file or folder) + name + repo name as a dim description-text suffix. The repo name is resolved via the `vscode.git` API — bundled with VS Code by default, can be disabled by the user — so if that extension isn't active, or the item isn't inside a repo, the badge is silently omitted; its absence produces no error.

**Git extension startup race.** On extension activation, `vscode.git`'s own activation may not have completed yet, which would otherwise mean badges never appear until the next unrelated redraw. To avoid this, on activation the extension gets the `vscode.git` extension, calls `.activate()`, and then either calls `getAPI(1)` if the returned API reports it's already ready, or subscribes to the API's `onDidChangeState` if it isn't. The first time the git API becomes ready, the extension fires `onBookmarksChanged` once to force a single re-render that picks up repo badges. No polling, and no more than one forced re-render per activation.

A broken bookmark (target path missing, checked on-demand via `fs.stat` at render time — no watcher) renders with a warning icon overlay and greyed text. There is no auto-fix; the user can only remove the entry.

The view title bar has three buttons:

- `bookmarks.toggleGroupByRepo` — flips the render mode:
  - **Default:** collection → item
  - **Grouped by repo:** repo-root node → collection → item
- `bookmarks.refresh` — manually invalidates the in-memory stat/repo cache described in [§2](#2-architecture) and forces a redraw (see also [§5](#5-commands)).
- `bookmarks.newCollection` — prompts for a name and adds a new top-level collection (see [§5](#5-commands)). Workspace-scoped only; a global collection is created from the Global row's own inline button (see "Global row" below).

**Drag-and-drop is disabled in group-by-repo mode.** Reordering and re-grouping (both are `BookmarkStore.moveItem()` calls) are only available in the default (collection → item) mode. The `bookmarks.toggleGroupByRepo` button's tooltip notes this — grouped-by-repo is a read-oriented view; switch back to default mode to reorder or move items between collections.

**Broken items in group-by-repo mode.** An item whose `fs.stat` lookup fails has no resolvable repo root, so it cannot be placed under a real repo-root group. Broken items render under a synthetic top-level "Unknown" group in group-by-repo mode, alongside the real repo-root groups.

### Global row (issue #55)

`bookmarksView` gains a single pinned **"Global"** root row — always rendered first among the view's root children, even when both stores are empty — rather than a second view. Its children are the global store's collections and ungrouped items, rendered with the same default (collection → item) logic already used for the workspace section. This conforms to issue #55's acceptance criteria, which call for `bookmarksView` to render "a pinned Global section … alongside the existing workspace-scoped groups/collections" (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)); a second view was considered and rejected for the same reason (see [§2](#2-architecture)).

**Global bookmarks do not participate in group-by-repo mode.** The Global row stays pinned and always renders its own subtree in the default (collection → item) layout, regardless of which mode the workspace section is in. Only the workspace section's shape changes when `bookmarks.toggleGroupByRepo` is flipped; the existing group-by-repo logic for workspace bookmarks (see "Broken items in group-by-repo mode" above) is unaffected. Folding global items into the same repo groups as workspace items was considered and rejected — it would break the "pinned, always visible" property, since a global bookmark outside any repo would otherwise vanish into the "Unknown" bucket alongside broken workspace items (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).

**Cross-scope drag-and-drop is refused.** The drag payload carries its scope (`{ scope, ids }` rather than a bare list of ids), and a drop is rejected whenever the payload's scope differs from the drop target's scope. A drop with no target (empty space) defaults to the workspace root, as before, and refuses a global-scoped payload there; dropping a global-scoped payload onto the Global row itself (ungrouping within global) is allowed. Allowing a cross-scope move as an implicit copy was considered and rejected for v1 — it would need its own duplicate policy, and there is no cross-scope transaction to build it on (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).

Context menus:

- **Right-click item:** Remove, Reveal in Explorer, Move to Collection
- **Right-click collection header:** Rename, Delete (deleting a collection ungroups its items rather than deleting them, and prompts a confirm dialog first)

**Empty state:** placeholder text reads "No bookmarks yet — right-click a file or folder to add one."

## 5. Commands

| Command | Trigger | Notes |
|---|---|---|
| `bookmarks.addFile` | Explorer context menu on a file | Command-palette registration is cut from v1 scope — see note below |
| `bookmarks.addFolder` | Explorer context menu on a folder | Gated by the `explorerResourceIsFolder` when-clause; command-palette registration is cut from v1 scope — see note below |
| `bookmarks.remove` | Tree item context menu + command palette | |
| `bookmarks.reveal` | Folder-bookmark tree item click; "Reveal in Explorer" context menu (file or folder) + command palette | Calls `revealInExplorer`. File-bookmark clicks bypass this command — they open directly via `vscode.open` (see [§9 point 3](#9-implementation-notes-resolved-ambiguities)) |
| `bookmarks.newCollection` | View title button + tree context menu + command palette | Prompts for a name; workspace-scoped only — a global collection is created from `bookmarks.newGlobalCollection` on the Global row's inline button instead (issue #55) |
| `bookmarks.renameCollection` | Collection context menu + command palette | Prompts for a new name |
| `bookmarks.deleteCollection` | Collection context menu + command palette | Confirm dialog; ungroups items, does not delete them |
| `bookmarks.toggleGroupByRepo` | View title button + command palette | Flips render mode (see [§4](#4-ui--tree-view)); disabled effect while in group-by-repo mode is DnD, not the toggle itself |
| `bookmarks.refresh` | View title button + command palette | Invalidates the in-memory stat/repo cache and forces a redraw (see [§2](#2-architecture), [§4](#4-ui--tree-view)) |
| `bookmarks.addFileGlobal` | Explorer context menu on a file | Issue #55, global scope; command-palette registration is cut from v1 scope — see note below |
| `bookmarks.addFolderGlobal` | Explorer context menu on a folder | Issue #55, global scope; gated by the `explorerResourceIsFolder` when-clause; command-palette registration is cut from v1 scope — see note below |
| `bookmarks.newGlobalCollection` | Inline button on the Global row + tree context menu | Issue #55; prompts for a name; writes to the global store only (see [§4](#4-ui--tree-view)) |
| `bookmarks.addToWorkspace` | Context menu on a global, folder-type bookmark whose target is outside the current workspace | Issue #56; see note below |

**Command-palette scope cut for `addFile`/`addFolder`.** These two commands are Explorer-context-menu only in v1 — deliberately not registered on the command palette. Invoking either from the palette has no unambiguous URI source (there's no "current file" concept in the palette the way there is a right-clicked Explorer node), and resolving that ambiguity is not worth the complexity for v1. This is consistent with the doc's overall simplicity stance. Every other command remains palette-accessible because it operates on an already-selected tree item (a bookmark, collection, or the view itself), not an ambiguous target.

**The same cut extends to the global-add commands (issue #55, amends AC 5).** `bookmarks.addFileGlobal` and `bookmarks.addFolderGlobal` have the identical ambiguous-URI problem as their workspace counterparts, for the same reason, so they are Explorer-context-menu only and `when: false` in `commandPalette`. Issue #55's acceptance criterion asking for these commands on "context menu + command palette" is amended accordingly — palette registration is **not** implemented, consistent with the decision already shipped for `addFile`/`addFolder` (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).

**Command handlers resolve their store from the node's scope (issue #55).** Every node-taking command handler is injected with `ScopedStores { workspace: BookmarkStore; global: BookmarkStore }` instead of a single bare store, and resolves which one to read or write via `stores[node.scope]` (see [§3](#3-data-model) for the `scope` field). This keeps one command ID and one registration per command. The alternative — duplicating each command ID per scope (e.g. a separate `bookmarks.removeGlobal`) — was considered and rejected: it doubles the contribution surface permanently and lets the two scopes drift when a fix lands on one command ID and not its twin (issue #55, comment [issuecomment-5305131447](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55#issuecomment-5305131447)).

**`bookmarks.addToWorkspace` (issue #56).** Available on a global, folder-type bookmark whose target is not already inside the current workspace. Whether a URI is "inside" the workspace is decided by a pure predicate, `isInsideWorkspace(uri, folders)` (new `src/workspaceFolders.ts`), rather than calling `vscode.workspace.getWorkspaceFolder` directly at each call site — call sites pass `vscode.workspace.workspaceFolders` in. A pure, parameterized predicate was chosen over calling the VS Code API directly because the API needs live `vscode.workspace` state, which is awkward to unit-test. Its documented semantics match `getWorkspaceFolder`'s own: a URI that *is* a workspace folder counts as inside; comparison is on path-segment boundaries, so `file:///a/foobar` is **not** inside `file:///a/foo`; Windows drive-letter casing and path case-insensitivity are handled; and for non-`file` schemes, scheme and authority are compared before path, with a mismatch treated as outside (issue #56, comment [issuecomment-5305131813](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/56#issuecomment-5305131813)).

**Folder click behavior — no expand/collapse ambiguity.** Folder bookmark tree items are always leaf nodes (`collapsibleState: None`); the tree never expands them inline, per the "reveal in Explorer, not expand inline" decision below. Since there's no twisty/chevron on a folder bookmark row, a click has only one possible target: `TreeItem.command` always fires and triggers `bookmarks.reveal`.

Click behavior: bookmarked files open in the editor; bookmarked folders reveal in the Explorer (they do not expand inline in the tree view).

Two deliberate simplicity choices:

- **No custom bookmark labels.** The tree always displays the real filename or folder name, kept simple on purpose.
- **No auto-follow on rename/move.** If a bookmarked file or folder moves, the bookmark shows as broken and the user fixes it manually. This trades away file-watcher complexity in exchange for a simpler, more predictable extension.

## 6. Error handling

Four cases are handled, and each degrades without surfacing an error dialog:

1. **Broken path** — warning icon overlay, greyed text, no auto-fix; the user removes the entry manually.
2. **Git API unavailable** — the repo-name badge is silently omitted; no error is shown, since `vscode.git` (bundled with VS Code by default, can be disabled by the user) is a soft dependency.
3. **Empty state** — placeholder text guides the user to right-click a file or folder to add the first bookmark.
4. **Corrupt or unparseable stored data** — on activation, `BookmarkStore` validates the shape of the stored `bookmarks.data` value (see [§3](#3-data-model)). If it's missing, `null`, or malformed, the store initializes a fresh empty `BookmarkData`, logs a warning to the output channel, and activation proceeds normally — it never throws.

## 7. Testing

- Scaffold: `@vscode/test-electron` + Mocha (the standard `yo code` default).
- **Unit tests:** exercise `BookmarkStore` (add / remove / move / reorder, including the renumbering behavior in [§3](#3-data-model) and the malformed-data fallback in [§6](#6-error-handling)) against a mocked `Memento`.
  - Multi-root URI resolution: a `BookmarkItem` added from a file under any workspace root stores the full absolute `vscode.Uri.toString()` ([§3](#3-data-model)), and retrieval returns that same absolute URI regardless of which root folder the file lives under — no relative-path resolution is attempted.
  - Drag-and-drop reorder within a parent: `moveItem()` moved within the same collection (or root) renumbers all siblings in that parent to `0..n-1` ([§3](#3-data-model)).
  - Drag-and-drop move across collections: `moveItem()` moved into a different collection updates `collectionId` and renumbers siblings to `0..n-1` in both the source and destination parents.
  - Collection deletion semantics: `deleteCollection(id)` sets `collectionId: null` on every item that belonged to the deleted collection, removes the collection, performs it as a single `workspaceState.update()` call, and does not delete the items themselves ([§3](#3-data-model)).
- **Integration tests:** verify `BookmarksTreeDataProvider` renders the expected nodes from fixture data, including the group-by-repo "Unknown" bucket for broken items and the single re-render on git-API-ready ([§4](#4-ui--tree-view)).
  - Grouped-by-repo rendering with no active Git repository: when `vscode.git` is unavailable or no item resolves to a repo root, the view degrades to an ungrouped (or all-"Unknown") render without throwing.
  - Broken-path rendering: an item whose `fs.stat` lookup fails renders with the warning icon overlay and greyed text, and does not throw.
  - Click/reveal behavior: clicking a file bookmark opens it in the editor; clicking a folder bookmark triggers `bookmarks.reveal` (reveal in Explorer) and never attempts an inline expand, consistent with folder items always being leaf nodes ([§5](#5-commands)).
- **Global scope (issue #55):**
  - Unit tests exercise the global-scoped `BookmarkStore` instance constructed over `context.globalState` ([§2](#2-architecture)): it never reads or writes the mirror-bookkeeping keys and never calls `setKeysForSync`, so global bookmarks stay unsynced and un-mirrored by construction, not by an explicit exclusion the tests have to special-case.
  - Integration tests cover `BookmarksTreeDataProvider`'s rendering of the pinned Global row ([§4](#4-ui--tree-view)): it is present and first among root children even when both stores are empty, its children come from the global store's own collections and ungrouped items, and global nodes never leak into the workspace section's children or vice versa.
  - Tests for the scope-routed command handlers ([§5](#5-commands)) assert that each handler mutates only the store matching the scope carried on the node it acted on, leaving the other store untouched — including the "move to collection" flow, which offers only same-scope collections.
  - Tests for the drag-and-drop scope guard ([§4](#4-ui--tree-view)) cover same-scope moves (allowed, unchanged from v1.0), cross-scope moves refused in both directions (a workspace payload dropped on the Global row, and a global payload dropped on a workspace collection), and dropping a global payload onto the Global row itself, which ungroups within the global scope and is allowed.

## 8. Packaging / publishing

- Publisher id registered via `vsce`.
- `icon.png` at 128x128.
- README with a screenshot or gif.
- `CHANGELOG.md`.
- `LICENSE`.
- Semantic version in `package.json`.

CI (GitHub Actions running tests plus `vsce package` on tag push) is noted as a fast-follow — not a blocker for the v1.0 milestone (tracked in #3).

## 9. Implementation notes (resolved ambiguities)

Extracted from the (now-deleted) implementation plan before removal, since these three points diverge from or sharpen this spec's wording and were not otherwise recorded. All are shipped in v1.0.

1. **View-title button count is three, not two.** §4 above still says "the view title bar has two buttons" (`toggleGroupByRepo`, `refresh`), but §5's command trigger for `bookmarks.newCollection` lists "View title button + tree context menu + command palette." Resolved as **three** title-bar buttons — the §5 table is the more granular, per-command source of truth. Implemented in `package.json`'s `view/title` menu contributions.
2. **Git-ready re-render mechanism.** §4 says the extension "fires `onBookmarksChanged` once" when the git API first becomes ready. But `BookmarkStore`'s public surface (`addItem`/`removeItem`/`moveItem`/`addCollection`/`renameCollection`/`deleteCollection`/`getAll`) has no force-fire method, and firing the store's event without a real mutation would misrepresent what the event means. Resolved by calling `BookmarksTreeDataProvider.refresh()` instead — it produces the identical externally observable effect (one cache invalidation, one redraw) via the mechanism §4 already specifies for the manual `bookmarks.refresh` command.
3. **`bookmarks.reveal` vs. click-to-open.** §5 says `bookmarks.reveal` "Calls `revealInExplorer`" with trigger "Tree item click or context menu." §4's prose says file bookmarks *open in the editor* on click, only folder bookmarks *reveal* on click. Resolved: a **file** bookmark's `TreeItem.command` opens it directly (`vscode.open`), bypassing `bookmarks.reveal`; a **folder** bookmark's click goes through `bookmarks.reveal` (its only possible click target, per §5's "Folder click behavior" note); the **context-menu** "Reveal in Explorer" action (available on both types per §4) always goes through `bookmarks.reveal` → `revealInExplorer`.
