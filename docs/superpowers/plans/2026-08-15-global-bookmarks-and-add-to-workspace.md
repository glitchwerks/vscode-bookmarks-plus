---
title: "Global Bookmarks (#55) + Add to Workspace (#56)"
touches:
  - src/types.ts
  - src/bookmarkStore.ts
  - src/bookmarksTreeDataProvider.ts
  - src/commands.ts
  - src/extension.ts
  - src/workspaceFolders.ts # new file (#56 predicate)
  - src/test/suite/bookmarkStore.test.ts
  - src/test/suite/bookmarksTreeDataProvider.test.ts
  - src/test/suite/commands.test.ts
  - src/test/suite/extension.test.ts
  - src/test/suite/workspaceFolders.test.ts # new file
  - src/test/suite/fixtures.ts
  - package.json
  - README.md
  - CHANGELOG.md
  - docs/superpowers/specs/2026-07-22-vscode-bookmarks-plus-design.md
skills_relevant:
  - test-driven-development
  - simplicity-first
---

# Global Bookmarks (#55) + Add to Workspace (#56) — implementation plan

**Status: NOT READY FOR IMPLEMENTATION — blocked on the § 3 decision gate.**
Decisions **D1** (view structure) and **D2** (command→store routing) change the task list in
§ 6. Do not start Phase 1 until the user has answered at least D1–D3.

**Issues**

- [#55 — Global Bookmarks](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/55) — state: **open**, label `enhancement`, milestone `v1.0` (fetched 2026-08-15).
- [#56 — Add to Workspace](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/56) — state: **open**, label `enhancement`, milestone `v1.0` (fetched 2026-08-15). Depends on #55.

## 0. Citation ground rules

**Before implementation starts: commit this plan onto the implementation branch.** It currently
exists only as an untracked file in the `main` working tree. The implementer will cut a worktree
off a feature branch where it is absent, and every `src/…:LN` citation below would silently
dangle. This is the same artifact-persistence trap already recorded on #52 — see
`docs/superpowers/specs/2026-08-09-mcp-dynamic-workspace-resolution.md:34`.

- `src/…:LN` line numbers are on `main` at `db0c15c`, read 2026-08-15.
- `node_modules/@types/vscode/index.d.ts:LN` refers to the pinned `@types/vscode ^1.85.0`
  dev dependency (`package.json:91`). It is not committed, but it is reproducible from
  `npm ci` and is the authoritative source for VS Code API contracts quoted below.
- Web citations carry their fetch date; treat them as authoritative for that date only.

---

## 1. What exists today (verified)

| Fact | Evidence |
|---|---|
| `BookmarkStore` takes an injected `vscode.Memento`; the workspace store is the only instance. | `src/bookmarkStore.ts:59-67`; `src/extension.ts:78-80` |
| `context.globalState` is used **nowhere** in the repo, extension or MCP server. | grep for `globalState` across the repo, 2026-08-15 — zero matches |
| `updateWorkspaceFolders` is used nowhere. `bookmarks.addFolder` bookmarks a folder, it does not add a workspace root. | grep, 2026-08-15 — zero matches; `src/commands.ts:59-66` |
| Storage is one JSON blob under `bookmarks.data`, plus two mirror bookkeeping keys. | `src/bookmarkStore.ts:18-20` |
| One mutation path: every write goes through a named method → `persist()` → `_onBookmarksChanged` → mirror write. | `src/bookmarkStore.ts:95-99`; spec `docs/superpowers/specs/2026-07-22-vscode-bookmarks-plus-design.md:35` |
| Duplicate detection is per-store, scoped to `this.data`. | `src/bookmarkStore.ts:108-119` |
| The tree provider holds exactly one store and one cache. | `src/bookmarksTreeDataProvider.ts:31-39` |
| Node union has three kinds; none carries a scope. | `src/bookmarksTreeDataProvider.ts:9-12` |
| `contextValue` drives menu visibility with `viewItem == …` equality clauses. | `src/bookmarksTreeDataProvider.ts:114,121,136`; `package.json:57-65` |
| Every node-taking command handler closes over one injected `store`. | `src/commands.ts:68-202` |
| The `.vscode/bookmarks.json` mirror is workspace-folder-scoped and disabled for 0 or >1 folders. | `src/bookmarkMirror.ts:5,22-44` |
| A workspace-folder change that disables the mirror detaches it and disposes the watcher. | `src/extension.ts:36-51,128-140`; `src/bookmarkStore.ts:279-281` |
| The MCP server reads only the mirror file — it has no other connection to the extension. | `README.md:50-56` |
| Spec §2 pins per-workspace scope as a deliberate v1.0 decision. | spec `:17,:25` |
| Spec §5 deliberately cut command-palette registration for `addFile`/`addFolder`. | spec `:144`; `package.json:66-69` |
| Test suite constructs `new BookmarkStore(...)` at ~99 call sites and `BookmarkNode` object literals throughout. | grep, 2026-08-15; e.g. `src/test/suite/bookmarksTreeDataProvider.test.ts:41,51,214,234,265` |
| `BookmarksTreeDataProvider` is constructed at 7 test call sites. | `src/test/suite/bookmarksTreeDataProvider.test.ts:11,276,288,299,313`; `src/test/suite/commands.test.ts:340,362` |

### VS Code API facts that constrain the design

1. **`globalState` is workspace-independent and not synced unless you opt in.**
   > "A memento object that stores state independent of the current opened workspace."
   > … `setKeysForSync`: "Set the keys whose values should be synchronized across devices…"
   > — `node_modules/@types/vscode/index.d.ts:8441-8453`

   Settings Sync is explicitly out of scope for #55, so **`setKeysForSync` must never be called**.
   Not calling it is the entire implementation of that scope boundary.

2. **`updateWorkspaceFolders` can restart the extension host.**
   > "**Note:** in some cases calling this method may result in the currently executing extensions
   > (including the one that called this method) to be terminated and restarted. For example when
   > the first workspace folder is added, removed or changed… Another case is when transitioning
   > from an empty or single-folder workspace into a multi-folder workspace"
   > — `node_modules/@types/vscode/index.d.ts:13916-13920`

   > "**Note:** it is not valid to call `updateWorkspaceFolders()` multiple times without waiting
   > for the `onDidChangeWorkspaceFolders()` to fire." — `:13943-13944`

   > "@returns true if the operation was successfully started and false otherwise if arguments
   > were used that would result in invalid workspace folder state" — `:13951-13952`

   The return value means *started*, not *finished*. #56's own action is therefore expected to
   restart the extension host in the single-root and empty-window cases.

3. **`getWorkspaceFolder` counts a workspace root as inside itself.**
   > "returns `undefined` when the given uri doesn't match any workspace folder · returns the
   > *input* when the given uri is a workspace folder itself" — `:13887-13895`

4. **Welcome content only shows for a genuinely empty tree.**
   > "Welcome content only applies to empty tree views. A view is considered empty if the tree has
   > no children and no `TreeView.message`."
   > — https://code.visualstudio.com/api/references/contribution-points (fetched 2026-08-15)

5. **`when` clauses support a regex match operator.**
   > "The expression `key =~ regularExpressionLiteral` treats the right-hand side as a regular
   > expression literal to match against the left-hand side."
   > — https://code.visualstudio.com/api/references/when-clause-contexts (fetched 2026-08-15)

6. **Per-tree drag mime types.**
   > "The mime type of a tree is recommended to be of the format
   > `application/vnd.code.tree.<treeidlowercase>`." — `index.d.ts:12064`

---

## 2. Design summary (the AC-conformant shape)

Everything below assumes **D1 = single view** (the shape #55's acceptance criteria prescribe).
§ 3 records the alternative and what changes if the user picks it.

**Storage.** A second `BookmarkStore` instance over `context.globalState`, created with **no
mirror**:

```ts
const globalStore = new BookmarkStore(context.globalState, output); // options omitted ⇒ no mirror
```

No new class, no subclass, no schema change. The global blob lives under the same
`bookmarks.data` key (`bookmarkStore.ts:18`) in a *different* Memento keyspace, so there is no
collision and no migration to write. `MIRROR_HASH_KEY` / `MIRROR_DIRTY_KEY` are simply unused in
that instance, and `syncWithMirror()` / `reloadFromMirror()` return immediately at their
`if (!this.mirror)` guards (`bookmarkStore.ts:290-292,316-318`).

> **Do not add a `scope` field to `BookmarkItem` and do not add a v3 migration rung.** Scope is a
> property of *which store you are in*, not of the data. The migration ladder
> (`src/migrations.ts:21-25`) is untouched by this work.

**Scope tagging.** A new `BookmarkScope = 'workspace' | 'global'` (in `src/types.ts`) is carried
on tree nodes, not on stored data. It is the only thing that tells a command handler which store
a node came from.

**Tree.** `BookmarksTreeDataProvider` gains an optional second store and a fourth node kind:

```ts
export type BookmarkNode =
  | { kind: 'globalRoot' }
  | { kind: 'collection'; scope: BookmarkScope; collection: BookmarkCollection; repoLabel?: string; repoKey?: string }
  | { kind: 'item'; scope: BookmarkScope; item: BookmarkItem }
  | { kind: 'repoGroup'; label: string; repoKey: string };
```

Root children become `[globalRoot?, ...existing workspace children]`. `globalRoot` renders as a
collapsed "Global" row with `contextValue: 'bookmarkGlobalRoot'` and a `$(globe)` icon; its
children are the global store's collections + ungrouped items, computed by the *same*
`getChildrenDefault` logic already used for the workspace store (`bookmarksTreeDataProvider.ts:172-196`).

**Events.** The provider subscribes to `onBookmarksChanged` on *both* stores and re-fires its own
`onDidChangeTreeData` — the same single hop per store that spec §2 already mandates
(spec `:35`). Neither store learns about the other; there is no cross-store event.

**Commands.** One command set, scope-routed (see D2). New commands for the global scope where a
node cannot supply the scope: `bookmarks.addFileGlobal`, `bookmarks.addFolderGlobal` (Explorer
context menu), `bookmarks.newGlobalCollection` (on the Global row).

**#56.** A pure predicate `isInsideWorkspace(uri, folders)` (new `src/workspaceFolders.ts`) drives
a `contextValue` suffix, which drives a menu entry, which invokes `bookmarks.addToWorkspace`.

---

## 3. Decision gate — answer before implementation

### D1 (blocking, structural) — one view with a pinned Global row, or two views?

The router flagged this. It changes the task list.

| | **A. Single `bookmarksView` with a pinned "Global" root row** *(what #55's AC says)* | **B. Second view `bookmarksGlobalView` in the same activity-bar container** |
|---|---|---|
| Conforms to #55 AC 3 as written | Yes | **No** — AC says "`bookmarksView` renders a pinned Global section … alongside the existing workspace-scoped groups/collections" |
| Provider changes | Merge two stores in one provider; new node kind; root-children ordering | None — instantiate the *same* class twice, one store each |
| Test blast radius on the provider | 7 construction sites + new merge tests | ~0 (constructor unchanged) |
| Cross-scope drag | Must be guarded in `handleDrop` (D5) | Structurally impossible: each view gets its own mime type (`index.d.ts:12064`) |
| Welcome content (`package.json:28-33`) | **Regression, and it cannot be patched with a `when` clause** — see risk 5. An always-visible Global row means the tree is never empty, so "No bookmarks yet…" never shows again. The empty-state hint has to move to `TreeView.message` or be dropped | Preserved per view |
| Command→store routing (D2) | Still required | **Still required** — a handler must know which store a node came from either way. Two views does not remove this |
| Title-bar buttons (`package.json:52-56`) | Shared: `newCollection` / `toggleGroupByRepo` / `refresh` become ambiguous across scopes | Natural per view |
| Vertical screen space | One section | Two collapsible sections |

**Recommendation: A (single view), per the issue's stated AC.** B is genuinely simpler in the
provider, but the only objection to A that isn't complexity — the welcome-content regression — is
fixable inside A, and a fixable objection is not grounds for deviating from an explicit acceptance
criterion. Recording B here so the choice is deliberate; if the user prefers B, tasks T3, T6 and
part of T5 in § 6 are replaced by "register a second view + second provider instance", and #56's
menu clauses gate on `view == bookmarksGlobalView` instead of on a contextValue suffix.

### D2 (blocking) — how do command handlers pick the store?

Every node-taking handler currently closes over exactly one store (`commands.ts:68-202`).

- **A. Node carries `scope`; handlers resolve the store from the node.** One command set, one
  registration block. A small `ScopedStores { workspace: BookmarkStore; global: BookmarkStore }`
  object is injected instead of a bare store, and handlers do `stores[node.scope]`.
  Cost: every node construction in the provider and every node literal in the tests gains a field.
- **B. Duplicate command IDs per scope**, gated by scope-bearing `contextValue`
  (`bookmarks.removeGlobal`, `bookmarks.revealGlobal`, …). Cost: ~6 commands double in
  `package.json:34-46` and in the `view/item/context` block, plus a second registration block.

**Recommendation: A.** B doubles the contribution surface permanently to avoid a one-time,
compiler-guided edit, and it makes the two scopes drift-prone (a fix applied to one command ID and
not its twin). A also keeps the palette-visible command list unchanged.

### D3 (blocking) — is `scope` required or optional on `BookmarkNode`?

Making it optional (`scope?: BookmarkScope`, defaulting to `'workspace'`) keeps ~50 existing node
literals in the test suite compiling untouched. Making it required forces a mechanical,
compiler-guided edit of those literals.

**Recommendation: required.** An optional field means a *forgotten* tag on a global node silently
routes a write into `workspaceState` — a data-placement bug with no compile-time or runtime signal.
The churn is mechanical and the compiler finds every site. (Constructor signatures are a different
matter — see § 5, where back-compatible optional parameters *are* recommended.)

### D4 — do global bookmarks participate in group-by-repo? *(#55 AC 4 explicitly defers this)*

- **A. No.** The Global row is pinned in both modes and always renders its own subtree in default
  (collection → item) layout; only the workspace section changes shape when the mode flips.
- **B. Yes.** Global items are folded into the same repo groups as workspace items.

**Recommendation: A.** B breaks the "pinned, always visible" property (a global bookmark outside
any repo would vanish into "Unknown" alongside broken workspace items), and it re-introduces the
cross-scope ambiguity that group-by-repo's DnD ban already avoids (spec `:119`). A also keeps the
existing `getChildrenByRepo` (`:199-261`) untouched, which #55 AC 4 requires ("existing
group-by-repo mode is unaffected for workspace bookmarks").

### D5 — cross-scope drag and drop

`moveItem` operates on one store's `this.data` (`bookmarkStore.ts:165-189`); there is no
cross-store transaction, and building one (remove-then-add with rollback) is out of proportion to
the value.

**Recommendation: refuse cross-scope drops in v1.** Concretely: the drag payload becomes
`{ scope, ids }` instead of a bare `string[]` (`bookmarksTreeDataProvider.ts:52-56`), and
`handleDrop` returns early when the payload scope differs from the target's scope. A drop with
**no target** (empty space) is ambiguous under two scopes — treat it as the *workspace* root
(preserving today's behavior, `:77-79`) and refuse a global-scoped payload there. Dropping onto
the Global row itself is the global equivalent of a root drop (ungroup within global) and is
allowed. Alternative: allow cross-scope moves as a copy — **not recommended for v1**, it needs a
duplicate policy of its own and interacts with D6.

### D6 — are duplicate URIs across scopes allowed? *(router flag (a); #55 asks to confirm)*

`hasDuplicateBookmark` only ever inspects `this.data` (`bookmarkStore.ts:108-119`), so with two
stores the same URI can exist once per scope with no error today.

**Recommendation: yes, intentionally allowed — no cross-store duplicate check.** A global bookmark
and a workspace bookmark of the same folder mean different things ("always available" vs "part of
this project"), and a cross-store check would require the store to know about a store it must not
know about (breaking the single-owner invariant in spec `:25`). Whichever way this goes it must be
written into spec §3, because silence here is what produced the question.

### D7 — command-palette registration for the global add commands *(conflict with a shipped decision)*

#55 AC 5 asks for the new global-add commands on "context menu + command palette". Spec `:144`
deliberately cut palette registration for `addFile`/`addFolder` because the palette has no
unambiguous URI source, and `package.json:66-69` gates them `when: false`. A global-add command has
the identical problem.

- **A. Follow the shipped spec decision** — Explorer context menu only, `when: false` in
  `commandPalette`, and amend #55's AC.
- **B. Honor #55's AC** — register on the palette and define the URI source (active editor?
  `showOpenDialog`? both, with a QuickPick?), which is new behavior the spec explicitly declined.

**Recommendation: A**, with the AC amended on the issue. B is defensible but it is a *new feature*
(palette-driven bookmarking) riding along inside #55, and it would beg the question of why the
workspace-scoped commands still lack it.

### D8 — #56's "inside the workspace" predicate

The issue's technical note says URI prefix comparison. The API method `getWorkspaceFolder`
(`index.d.ts:13887-13895`) is more correct but needs the live `vscode.workspace` state, which is
awkward to unit-test.

**Recommendation: a pure predicate `isInsideWorkspace(uri, folders)` in a new
`src/workspaceFolders.ts`**, taking the folder list as a parameter (call sites pass
`vscode.workspace.workspaceFolders`). Its documented semantics must match `getWorkspaceFolder`:

- a URI that **is** a workspace folder counts as inside (`index.d.ts:13890`);
- comparison is on **path segment boundaries** (`file:///a/foobar` is *not* inside `file:///a/foo`);
- Windows path case-insensitivity and drive-letter casing must be handled (`c:` vs `C:` in
  `Uri.toString()`);
- non-`file` schemes: compare scheme + authority before path, and treat a mismatch as "outside".

---

## 4. Explicitly out of scope

Carried from the two issues, plus consequences this plan discovered:

- Settings Sync / cross-machine sync of global bookmarks (**do not call `setKeysForSync`**).
- MCP exposure of global bookmarks. The MCP server reads only the mirror file (`README.md:50-56`),
  and the global store has no mirror, so global bookmarks are invisible to it **by construction**.
- A mirror file for global bookmarks (there is no unambiguous location for one).
- Removing workspace folders, or persisting workspace-folder membership decisions (#56).
- Cross-scope drag-and-drop moves (D5).
- Any `BookmarkData` schema change or new migration rung.
- Multi-root support for the *mirror* — unchanged and still disabled above one folder
  (`bookmarkMirror.ts:29-34`).
- **`mcp-server/**` is untouched by this work.** Its absence from `touches:` is deliberate, not an
  omission: `BookmarkData` does not change, so `mcp-server/test/schemaDrift.test.ts` and the
  server's contract are unaffected. (`src/bookmarkStore.ts` *is* listed in `touches:` even though
  no task edits it — declared defensively because T2 changes how it is instantiated and disposed.)

---

## 5. Risks and traps

1. **#56's own action silently disables the mirror.** Adding a folder to a single-root workspace
   makes it multi-root, which fires `onDidChangeWorkspaceFolders`, which runs
   `handleWorkspaceFoldersChanged` (`extension.ts:36-51,128-140`) and calls `store.detachMirror()`.
   `.vscode/bookmarks.json` stops updating and the MCP server goes stale. This is pre-existing
   wiring working as designed, but the user experiences it as a side effect of clicking "Add to
   Workspace". **Mitigation:** confirm prompt before a single-root → multi-root transition naming
   both consequences (mirror off; the window/extension host may restart). Document in spec §5 and
   README.
2. **Extension host restart mid-write.** `updateWorkspaceFolders` may terminate the extension host
   (§ 1 fact 2), and mirror writes are debounced 250 ms (`bookmarkStore.ts:21,342-347`).
   **Mitigation:** `await store.flushMirrorWrites()` (`:270-273`) *before* calling
   `updateWorkspaceFolders`. Do not rely on `deactivate()` (`extension.ts:148-154`) running on a
   host restart.
3. **`activeStore` is a single module-level slot** (`extension.ts:28`). `deactivate()` and the
   `dispose` subscription (`:96`) must cover both stores; the global store has no mirror but does
   own a `Delayer` and an `EventEmitter` (`bookmarkStore.ts:54-57,275-277`).
4. **`contextValue` equality clauses are load-bearing.** All current item menus gate on
   `viewItem == bookmarkItem` (`package.json:58-63`). If #56 introduces a new contextValue for
   addable global folders, those rows lose Remove / Reveal / Move to Collection / Set Description
   unless the clauses migrate to the regex form `viewItem =~ /^bookmarkItem\b/` (§ 1 fact 5).
   **This is the single easiest way to ship a silent UI regression in this pair of issues.**
5. **Welcome-content regression under D1-A, with no `when`-clause escape hatch.** An always-visible
   Global row means the tree always has children, and welcome content "only applies to empty tree
   views… empty if the tree has no children **and no `TreeView.message`**" (§ 1 fact 4). A `when`
   clause can only *further restrict* welcome content — it cannot make it appear in a non-empty
   tree — and setting `TreeView.message` does not restore it either. **The only two options are:**
   (a) delete the `viewsWelcome` contribution (`package.json:28-33`) and move the empty-state hint
   to `TreeView.message`, set and cleared by the provider when both stores are empty; or (b) accept
   the loss and drop the contribution. Decide in T3; do not attempt a `when` clause.
6. **`moveToCollection` must stay scope-local.** `commands.ts:175-182` offers
   `store.getAll().collections`; a global item must be offered only global collections, and vice
   versa. Same for `handleDrop` target resolution.
7. **Constructor churn.** ~99 `new BookmarkStore(...)` and 7 `new BookmarksTreeDataProvider(...)`
   call sites exist in tests. Keep both signatures back-compatible by **appending optional
   parameters** (`constructor(store, cache, globalStore?)`), rather than reordering or requiring a
   new first argument. When `globalStore` is absent the provider renders exactly as it does today —
   which also gives every existing test a meaningful "global feature off" baseline.
8. **Clicking an outside-workspace global folder probably does nothing.** `getTreeItem` wires every
   folder bookmark's click to `bookmarks.reveal` → `revealInExplorer`
   (`bookmarksTreeDataProvider.ts:155-158`; `commands.ts:229-234`). The Explorer only shows the
   current workspace's folders, so for a global folder that is *outside* it there is nothing to
   reveal — the default click on the exact bookmark class #56 exists to serve is expected to be a
   silent no-op. Neither issue mentions this. **Verify the actual behavior in the Extension
   Development Host before deciding** — see open question 10.
9. **`updateWorkspaceFolders` returning `false`** means the arguments were invalid (e.g. duplicate
   URI, `index.d.ts:13951-13952`). Surface it as an information message rather than throwing, and
   never call the API twice without waiting for `onDidChangeWorkspaceFolders` (`:13943-13944`).

---

## 6. Task breakdown

TDD per repo convention: write the failing test first, then the implementation. Tasks are ordered;
each should be a self-contained commit. Phase 1 = #55, Phase 2 = #56. **Phase 2 must not start
before Phase 1 is merged** — #56 has no meaning without a global folder bookmark to act on.

### Phase 1 — #55 Global Bookmarks

**T1 — `BookmarkScope` and scope-tagged nodes**
Add `export type BookmarkScope = 'workspace' | 'global'` to `src/types.ts`. Add `scope` to the
`'item'` and `'collection'` members of `BookmarkNode` (`bookmarksTreeDataProvider.ts:9-12`) per D3.
Update existing node constructions in the provider to pass `'workspace'`, and update test literals
mechanically.
*Tests:* the existing suites must compile and pass unchanged in behavior. No new behavior yet.

**T2 — global store lifecycle**
In `extension.ts:70-146`: create `globalStore = new BookmarkStore(context.globalState, output)`
(no mirror). Register its disposal alongside the workspace store (`:96`) and flush/dispose it in
`deactivate()` (`:148-154`) — replace the single `activeStore` slot with a pair or a small array.
**Do not call `setKeysForSync`.**
*Tests (`extension.test.ts`, `bookmarkStore.test.ts`):* a store built over a Memento with no mirror
option never reads or writes `bookmarks.mirrorHash` / `bookmarks.mirrorDirty` and never throws from
`syncWithMirror()` / `reloadFromMirror()`; both stores are disposed on deactivate.

**T3 — pinned Global row in the tree** *(shape depends on D1)*
Optional third constructor parameter `globalStore?: BookmarkStore` (risk 7). Add the `'globalRoot'`
node kind; render it first among root children with `contextValue: 'bookmarkGlobalRoot'`; its
children come from the global store via the existing default-layout logic. Subscribe to the second
store's `onBookmarksChanged`. Apply D4 for group-by-repo. Handle the welcome-content regression
(risk 5) by choosing option (a) `TreeView.message` or option (b) drop it — **not** a `when` clause,
which cannot work here — and say which in the PR body.
*Tests (`bookmarksTreeDataProvider.test.ts`):* no `globalStore` ⇒ root children identical to today;
with one ⇒ Global row present even when both stores are empty; global collections/items render
under it and never leak into workspace root children (and vice versa); in `byRepo` mode the
workspace section groups by repo while the Global row is unchanged (per D4-A).

**T4 — scope-routed command handlers** *(shape depends on D2)*
Introduce `ScopedStores` and change the node-taking handlers in `commands.ts:68-202` to resolve
their store from `node.scope`. Make the `moveToCollection` QuickPick scope-local (risk 6).
*Tests (`commands.test.ts`):* each handler mutates only the store matching the node's scope — assert
the *other* store is untouched; `moveToCollection` offers only same-scope collections;
`deleteCollection` on a global collection ungroups only global items.

**T5 — global add commands and menu contributions**
New commands `bookmarks.addFileGlobal` / `bookmarks.addFolderGlobal` (Explorer context menu,
`explorer/context` group `bookmarksPlus`, alongside the existing entries at `package.json:48-51`)
and `bookmarks.newGlobalCollection` (context menu + inline `$(new-folder)` on the Global row).
Apply D7 for palette registration. **Title-bar buttons stay as they are** (`package.json:52-56`),
closing the D1-A con: `bookmarks.newCollection` remains workspace-scoped (global collections are
created from the Global row's own inline button), and `bookmarks.refresh` /
`bookmarks.toggleGroupByRepo` are scope-neutral under D4-A.
*Tests:* the global add handlers write to the global store only; a duplicate in the *workspace*
store does not block a global add (D6); `bookmarks.newCollection` never writes to the global store.

**T6 — drag-and-drop scope guard** *(per D5)*
Change the transfer payload to `{ scope, ids }` (`bookmarksTreeDataProvider.ts:52-56,67-95`).
*Tests:* a global payload dropped on a workspace collection is a no-op in both stores; a global
payload dropped on the Global row ungroups within global; an untargeted drop of a global payload is
a no-op; existing workspace-only DnD tests still pass (they will need the new payload shape).

**T7 — docs for #55**
Spec `2026-07-22-vscode-bookmarks-plus-design.md`: revise §2 (`:17,:25`) to record that the
per-workspace-only decision is superseded by #55 — with the *original* decision and the reason it
changed both preserved; §3 to record the second storage instance, no schema change, and the D6
duplicate policy; §4 for the Global row and D4; §5 for the new commands and D7; §7 for the new test
coverage. README `:7-14` Features, and qualify `:14` and the mirror section `:24-48` — global
bookmarks are **not** mirrored and therefore not visible to the MCP server. `CHANGELOG.md` entry.

### Phase 2 — #56 Add to Workspace

**T8 — `isInsideWorkspace` predicate** *(per D8)*
New `src/workspaceFolders.ts`, pure, no `vscode.workspace` access.
*Tests (new `workspaceFolders.test.ts`):* uri equal to a folder ⇒ inside; descendant ⇒ inside;
sibling with a shared prefix (`/a/foobar` vs `/a/foo`) ⇒ outside; empty/undefined folder list ⇒
outside; multi-root with a match in the second folder ⇒ inside; Windows drive-letter case variance
⇒ inside; different scheme or authority ⇒ outside.

**T9 — contextValue plumbing and menu entries**
In `getTreeItem` (`bookmarksTreeDataProvider.ts:129-160`), compute the suffix for global
folder-type items that are outside the workspace. **Migrate all `viewItem == bookmarkItem` clauses
to the `=~` regex form first** (risk 4, § 1 fact 5), in the same commit. Add `bookmarks.addToWorkspace`
to `contributes.commands` and to `view/item/context` (inline icon + context menu).
*Tests:* a global folder outside ⇒ contextValue carries the addable marker; a global folder inside,
a global *file*, and a workspace folder ⇒ it does not.

**T10 — `bookmarks.addToWorkspace` handler**
`createAddToWorkspaceHandler(deps)` following the existing factory pattern (`commands.ts:50-66`),
with `updateWorkspaceFolders` and the confirm prompt injected so it is unit-testable. Behavior:
refuse non-global / non-folder / already-inside nodes; `await flushMirrorWrites()` first (risk 2);
confirm before a single-root → multi-root transition, naming the mirror-off and possible-restart
consequences (risk 1); append at index `workspaceFolders?.length ?? 0`; report a `false` return as
an information message (risk 9); never call the API twice in one invocation.
*Tests (`commands.test.ts`):* empty window ⇒ called with `(0, null, {uri})`; single-root ⇒ confirm
prompt shown and the API not called when the user declines; multi-root ⇒ appended without a prompt
(or per the chosen confirm policy); `false` return ⇒ info message, no throw; mirror flush happens
before the API call.

**T11 — refresh the tree on workspace-folder changes**
`extension.ts:128-140` currently handles only the mirror. Also call `provider.refresh()` so the
contextValue recomputes and the action disappears once the folder is inside the workspace (#56 AC
5). In the restart case the AC is satisfied trivially by the reload; this covers the non-restart
case. Nothing more elaborate is needed.
*Tests (`extension.test.ts`):* a folder-change event invokes the provider refresh in addition to the
existing mirror handling.

**T12 — docs for #56**
Spec §5 command table + a caveats note (extension-host restart quoting `index.d.ts:13916-13920`;
mirror disabled on single → multi-root). README: the new action and the same two caveats.
`CHANGELOG.md` entry.

---

## 7. Definition of done

- [ ] Every decision in § 3 answered on the issue thread, and the answer recorded in the spec.
- [ ] `npm run lint` and `npm test` green (`package.json:83-84`).
- [ ] No `setKeysForSync` call anywhere (grep in review).
- [ ] No new `BookmarkData` schema version and no new rung in `src/migrations.ts`.
- [ ] Every pre-existing `viewItem ==` menu clause still resolves for every row it resolved for
      before (risk 4) — verified by hand in the Extension Development Host, not only by tests.
- [ ] README states that global bookmarks are not mirrored and not visible to the MCP server.
- [ ] Manual smoke: empty window, single-root, and multi-root, each with a global folder bookmark
      pointing outside the workspace.
- [ ] Spec §2's superseded per-workspace decision reads as *revised with reasons*, not deleted.

## 8. Open questions for the user

1. **D1** — single view with a pinned Global row (AC-conformant, recommended), or two views?
2. **D2** — scope on the node (recommended) or duplicated per-scope commands?
3. **D3** — `scope` required on `BookmarkNode` (recommended) or optional to spare test churn?
4. **D4** — do global bookmarks participate in group-by-repo? (recommended: no)
5. **D5** — refuse cross-scope drag-and-drop in v1? (recommended: yes)
6. **D6** — confirm that the same URI may exist in both scopes. (recommended: yes, allowed)
7. **D7** — palette registration for the global add commands: follow the shipped spec cut and amend
   #55's AC (recommended), or define a palette URI source?
8. **D8** — pure prefix predicate with documented `getWorkspaceFolder` semantics (recommended), or
   call the API directly?
9. **Confirm policy for #56** — prompt only on the single-root → multi-root transition
   (recommended), always, or never?
10. **Click behavior on an outside-workspace global folder** (risk 8; raised by neither issue).
    Verify first, then choose: leave it a no-op and record it as a known limitation; fall back to
    "Add to Workspace" on click; or fall back to `revealFileInOS`. **Recommendation: verify, then
    record as a known limitation for this pair of issues and open a follow-up** — changing click
    behavior touches spec §5's "Folder click behavior" decision (`:146`) and belongs in its own
    issue, not smuggled into #56.
