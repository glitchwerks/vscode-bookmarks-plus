---
title: 'Issue #95 — suggested bookmarks from recently opened items'
touches:
  - src/recentItems.ts
  - src/bookmarksTreeDataProvider.ts
  - src/commands.ts
  - src/extension.ts
  - src/test/suite/recentItems.test.ts
  - src/test/suite/bookmarksTreeDataProvider.test.ts
  - src/test/suite/commands.test.ts
  - src/test/suite/extension.test.ts
  - src/test/suite/fixtures.ts
  - package.json
  - README.md
  - CHANGELOG.md
skills_relevant:
  - test-driven-development
  - using-git-worktrees
  - pull-request-workflow
---

# Implementation plan — issue #95: suggested bookmarks from recently opened items

**Issue:** [#95](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/95) — state `open`,
milestone `Bookmark discovery UX` (milestone #4), label `enhancement`. Verified 2026-08-25 via
`WebFetch` of the public issue page.
**Prior art:** `docs/research/2026-08-25-bookmarks-suggested-and-explorer-decoration.md` (§ "Feature
1", `:L30-L77`).
**Sibling feature:** issue #96, planned separately at
`docs/superpowers/plans/2026-08-25-explorer-decoration-for-bookmarked-files.md`.

> **Citation caveat.** This session had **no Bash tool and no `mcp__github__*` tools**. Issue state,
> milestone, and labels above were read from the rendered issue page and are reliable. The issue
> *body* came back from `WebFetch` as a model-written summary with invented headings, not verbatim
> text — so **no requirement below is cited to `#95`'s body**. Requirement statements are attributed
> to the dispatching router brief, which is this plan's authoritative task statement.

---

## 1. What this delivers

A "Suggested" section in the existing `bookmarksView` tree, listing the most recently opened files in
this workspace that are **not yet bookmarked**, each independently clickable to open in an editor,
with a one-click action to promote it into a real bookmark.

Per the router brief, the requirement is: *"Track the last 5-10 most recently opened items
(files/tabs) per workspace and surface them as 'suggested to bookmark' entries in the Bookmarks Plus
panel. Suggested items remain independently clickable to open in an editor tab while they stay in the
recent list."*

This is entirely new plumbing. Grep confirmed there is **no** recent/MRU/history tracking anywhere in
`src/`, and **no** `onDidOpenTextDocument` / `onDidChangeActiveTextEditor` / `tabGroups` listener
(router-brief Explore map; consistent with `src/extension.ts:L86-L182`, whose only workspace listener
is `onDidChangeWorkspaceFolders` at `:L158`).

## 2. Verified API facts the implementation depends on

Citations to the pinned typings. `package.json:L12` declares `"engines": { "vscode": "^1.85.0" }` and
`package.json:L103` pins `"@types/vscode": "^1.85.0"`, so every member below is available at the
minimum supported host version.

1. `window.tabGroups: TabGroups` (`node_modules/@types/vscode/index.d.ts:L11079`), with
   `TabGroups.onDidChangeTabs: Event<TabChangeEvent>` (`:L19430`) and
   `onDidChangeTabGroups` (`:L19425`).
2. `TabChangeEvent` carries three readonly arrays: `opened`, `closed`, `changed` (`:L19339-L19353`).
   `changed` is documented as covering things like a tab's `isActive` state flipping (`:L19349-L19351`).
3. **`Tab.input` is a union that ends in `unknown`** (`:L19312`) — there is **no discriminator
   field**. Narrowing requires runtime `instanceof` against the exported classes:
   `TabInputText` (`:L19168`, has `uri` at `:L19172`), `TabInputCustom` (`:L19204`, `uri` at
   `:L19208`), `TabInputNotebook` (`:L19239`, `uri` at `:L19243`). Note `TabInputTextDiff`
   (`:L19184`) has **`original` and `modified`, no single `uri`** (`:L19188-L19192`) — a diff tab has
   no unambiguous "the file", so it needs an explicit decision, not an accidental cast.
4. `Tab.isPreview` (`:L19333`), `Tab.isPinned` (`:L19328`), `Tab.isActive` (`:L19318`) are all
   available for filtering.
5. **Negative finding — you must own the MRU list.** There is no public VS Code API that enumerates
   recently opened *files*; microsoft/vscode#136878 has requested one since 2021 and remains
   unresolved (research `:L32-L38`). The internal `_workbench.getRecentlyOpened` command returns
   recently opened **workspaces and folders**, not files, and is undocumented/underscore-prefixed
   (research `:L64-L70`). **Do not reach for either.**
6. **Do not copy `wahyd4/vscode-plugin-recent-files`' read path** — it reads
   `activeTextEditor._documentData._uri.path`, a private internal field (research `:L40-L47`). Its
   *cap-and-evict shape* is fine; its accessor is not.

### Repo facts this design keys off

7. `getChildren` already injects a synthetic root — `{kind: 'globalRoot'}` is prepended in both group
   modes (`src/bookmarksTreeDataProvider.ts:L241` and `:L244`). A second synthetic root follows an
   established precedent, not a new one.
8. `BookmarkNode` is a four-arm union (`src/bookmarksTreeDataProvider.ts:L10-L14`); `contextValue` is
   set per arm in `getTreeItem` (`:L164-L226`), and `package.json:L63-L73` keys `view/item/context`
   menus off those values (including the regex form `viewItem =~ /^bookmarkItem\b/`).
9. `addBookmark` (`src/commands.ts:L47-L61`) is the single add path: it calls `store.addItem` and
   swallows `DuplicateBookmarkError` with an info toast. The promote command must reuse it verbatim.
10. `context.workspaceState` is the workspace-scoped `Memento` passed to the workspace store
    (`src/extension.ts:L99-L101`); `STORAGE_KEY = 'bookmarks.data'` (`src/bookmarkStore.ts:L18`) is the
    only real data key in use today.

## 3. Design constraints (settled — not user decisions)

- **C1 — the MRU list must NOT live in `BookmarkData`.** Two independent reasons:
  (i) `BookmarkData` is versioned (`CURRENT_SCHEMA_VERSION = 2`, `src/types.ts:L25`) with migrations
  in `src/migrations.ts`, so folding a new array in forces a version bump and a migration for a
  feature that needs neither; (ii) `BookmarkData` is what gets mirrored to `.vscode/bookmarks.json`
  (`src/bookmarkStore.ts:L271-L413`), a file that is schema-validated for editing
  (`package.json:L83-L85`) and is committed in many repos — a per-user browsing history does not
  belong in a shared, committed file. **New module, new `workspaceState` key (e.g.
  `bookmarks.recentlyOpened`), zero mirror involvement.** This is the one refactor an implementer is
  most likely to "helpfully" propose; it is rejected here on purpose.

- **C2 — the list logic must be a pure function, with `instanceof` narrowing at the event boundary.**
  Because `Tab.input` bottoms out in `unknown` (`:L19312`), narrowing is runtime-class-based and
  cannot be type-driven. Keep `recordOpen(list, entry, cap): RecentItem[]` operating on a plain
  `{ uri: string }` shape so eviction/dedupe rules are unit-testable without fabricating `Tab`
  objects, and confine all `instanceof vscode.TabInput*` checks to a thin adapter.
  **Addendum per D2 (RESOLVED):** the pure-function surface also now owns the preview-count/threshold
  logic (§ 4 D2) — the exact signature (e.g. whether `recordOpen` takes an `isPreview` flag, or a
  separate pure helper tracks `previewCount`) is an implementation-time decision, not specified here.

- **C3 — `viewsWelcome` is already permanently inert; do not re-litigate it.** `activate()`
  unconditionally constructs `globalStore` (`src/extension.ts:L102`), and `getChildren` injects
  `{kind:'globalRoot'}` whenever `globalStore` exists (`src/bookmarksTreeDataProvider.ts:L241`,
  `:L244`), so the tree always has at least one child and the welcome contribution
  (`package.json:L28-L33`) never renders. VS Code's welcome content applies only to trees with no
  children, and a `when` clause can only further restrict it. **A second synthetic root costs nothing
  new here.**

- **C4 — a new node kind is non-draggable by construction.** `handleDrag` filters to
  `n.kind === 'item'` (`src/bookmarksTreeDataProvider.ts:L71-L73`) and `handleDrop` returns early for
  any non-`item`/`collection`/`globalRoot` target (`:L110-L141`). No change is needed — and the filter
  must **not** be widened.

- **C5 — the promote command needs a `commandPalette: { "when": "false" }` entry.** It takes a node
  argument, so palette invocation would pass nothing and fail. Six existing node-argument commands are
  suppressed exactly this way (`package.json:L74-L81`).

- **C6 — filter to `uri.scheme === 'file'`.** Tabs routinely carry `output:`, `git:`,
  `vscode-settings:`, and `untitled:` URIs. `BookmarkStore.addItem` performs no scheme validation
  (`src/bookmarkStore.ts:L125`), so an unfiltered suggestion would let a user create a bookmark
  pointing at a scratch buffer that can never be reopened.

- **C7 — already-bookmarked items must not appear as suggestions.** Which store(s) suppress is D9
  (RESOLVED — either store).

## 4. Open decisions — RESOLVED

All ten decisions below were open when this plan was first written; the user has since resolved each
one. Rejected options are kept (marked *considered, rejected*) so a future reader understands what was
weighed, not just what was chosen.

- **D1 (RESOLVED) — event source: `window.tabGroups.onDidChangeTabs`.** Matches the user-visible
  notion of "opened item"; covers text, notebook and custom-editor tabs; exposes
  `isPreview`/`isPinned` (`:L19430`). This was the plan's original recommendation, accepted as-is.
  *Considered, rejected:* `window.onDidChangeActiveTextEditor` (text editors only, misses notebooks
  and custom editors); `workspace.onDidOpenTextDocument` (fires for documents opened programmatically
  and never shown — other extensions, search, git diff — which pollutes the list badly).
  Sub-decision carried forward unchanged: `TabInputTextDiff` tabs (no single `uri`,
  `:L19188-L19192`) are skipped entirely in v1.

- **D2 (RESOLVED, deviates from the plan's original options) — count-based preview promotion,
  threshold 3.** The user rejected all three original choices (record everything / skip-then-catch
  the preview→permanent transition / skip previews entirely) in favor of a new mechanism not
  originally proposed in this plan.

  **Operational definition, for an implementer reading only this file:**
  - Every recorded recent-item entry carries a per-URI preview-open counter, e.g. `previewCount:
    number` (new field on the `RecentItem` shape defined in T2 — see T1/T2 below).
  - When a tab for a given URI opens as a **preview** tab (`Tab.isPreview`, `:L19333`), the tracker
    increments that URI's `previewCount` and updates/creates its recent-item entry in the persisted
    list **as it does today for a real open** — but the entry does **not** appear in the Suggested
    tree section yet, because it has not crossed the threshold.
  - When a tab for a given URI opens as a **non-preview** (permanent) tab, the entry is treated as a
    normal open per the existing recency logic (D1), independent of `previewCount`.
  - Once a URI's `previewCount` reaches **3**, the entry is **promoted**: from that point on it is
    treated exactly like a real (non-preview) open and surfaces in the Suggested list per the normal
    recency/cap/sort rules (D3, D6).
  - **Implementer-facing clarification (not a re-opened design decision):** once an entry is
    promoted, `previewCount` no longer matters — the item behaves like any other recorded entry from
    that point on. There is no requirement to keep incrementing or to re-check the counter after
    promotion.
  - **Cap interaction (D3):** `bookmarksPlus.suggestions.maxItems` bounds the **displayed/promoted**
    set only, not the raw stored list. Sub-threshold preview entries persist their counter state (so
    a file previewed twice today and once tomorrow still promotes) but do **not** compete with
    promoted entries for the cap's slots and are never themselves evicted to make room for a promoted
    entry. This is required for R2's mitigation to hold: without it, arrow-keying through more files
    than `maxItems` would let un-promoted preview entries crowd out real opens in the stored list.
  - **`firstSeen` interaction (D6):** a promoted entry's `firstSeen` (used for the D6 sort) is the
    timestamp of the open that **crossed the threshold** (the promoting open), not the timestamp of
    the first preview open. This keeps the D6 first-seen sort meaningful — a file previewed three
    times over an hour sorts as "just seen," not as if it had been sitting in the list for an hour
    before ever surfacing.
  - The exact function signature that implements this (e.g. whether the counter lives inside
    `recordOpen`'s return shape or is threaded through a separate helper) is an **implementation-time
    decision**, not a design decision requiring further user input — see the T1/T2 note below.

  *Considered, rejected (the plan's original three options):* (a) record everything — simplest,
  noisiest; (b) skip previews on `opened` and also listen to `changed` to catch the preview→permanent
  transition — accurate, more logic, more tests; (c) skip previews entirely — a file genuinely read
  once in preview never appears. The user judged all three as either too noisy or too lossy, and chose
  count-based promotion instead, which keeps genuinely-repeated preview opens visible without
  surfacing every single-glance preview.

- **D3 (RESOLVED) — cap: configurable setting.** `bookmarksPlus.suggestions.maxItems`, default 10,
  `0` disables the section entirely. This was the plan's option (b), accepted. *Considered,
  rejected:* (a) a fixed constant (10) with no setting.

- **D4 (RESOLVED) — persistence: `workspaceState`.** Survives window reload, which is precisely when
  a "what was I working on" list is most valuable; entries can point at deleted/renamed files. This
  was the plan's option (a), accepted. *Considered, rejected:* (b) in-memory only.
  **Sub-decision not yet resolved — staleness strategy is implementation-time, not re-opened as a
  design decision:** the original plan offered two ways to handle a persisted URI that no longer
  resolves — filter at render via `FsGitCache` (`src/extension.ts:L69-L84` already resolves
  existence), or prune lazily on read. **Pick exactly one; do not do both.** This choice was not part
  of what the user resolved and remains open for the implementer to make (tracked at § 7 R3).

- **D5 (RESOLVED) — multi-root workspaces: work uniformly, no disable.** Confirmed as the plan
  recommended: **do not inherit** the mirror's multi-root disable (`resolveMirrorLocation` /
  `resolveWorkspaceEnvValue`, `src/workspaceEnv.ts:L25-L37`) — `context.workspaceState` has no
  single-folder constraint, so the recent list works uniformly across multi-root workspaces.
  Sub-decision, also confirmed: suggestions are **not** restricted to in-workspace files — an
  out-of-tree open still gets suggested, backed by the global store, exactly as the plan recommended.

- **D6 (RESOLVED) — MRU click churn: sort by first-seen.** The section sorts by first-seen timestamp
  rather than most-recent, fixing *order* churn with one comparator and a stored `firstSeen`
  timestamp. This was the plan's option (b), accepted. *Considered, rejected:* (a) accept the reorder
  (zero code, but leaves the churn); (c) suppress self-opens (fixes *membership* churn but requires a
  URI+time-window heuristic that can misfire, per the original analysis).

- **D7 (RESOLVED) — per-item dismiss: no dismiss in v1.** Items evict naturally by cap. This was the
  plan's option (a), accepted. *Considered, rejected:* (b) dismiss backed by a persisted dismissed-URI
  set — deferred as a possible follow-up issue, not built now.

- **D8 (RESOLVED) — tree placement and lifecycle: full recommended bundle, accepted as originally
  written.** Position: last (below `globalRoot`). Default state: collapsed. Visibility: hidden
  entirely when empty. Group modes: present in both `flat` and `byRepo`
  (`src/bookmarksTreeDataProvider.ts:L239-L242`). No separate view-title toggle command — the
  `maxItems: 0` setting from D3 already serves as an off-switch, so a toggle command mirroring
  `bookmarks.toggleGroupByRepo` is not needed.

- **D9 (RESOLVED) — suppression scope: either store.** A suggestion is suppressed if the file is
  bookmarked in **either** the workspace store or the global store — consistent with #96's D2 union.
  This was the plan's recommendation, accepted.

- **D10 (RESOLVED) — PR split: own PR, separate from #96.** #96 has already merged as
  [PR #100](https://github.com/glitchwerks/vscode-bookmarks-plus/pull/100) (verified 2026-08-28 via
  `gh pr view 100`), so this feature ships as its own follow-on PR rather than being bundled. This was
  the plan's recommendation, accepted.

## 5. Task breakdown (TDD; each task = one commit)

Follow `superpowers:test-driven-development`. Tests run in a real extension host via
`@vscode/test-electron` (`src/test/runTest.ts`), so `vscode.TabInputText` and friends are available as
real classes in tests.

- **T1 (test)** — `src/test/suite/recentItems.test.ts` for the pure list logic: recording a new URI
  puts it at the front; re-recording an existing URI moves it (no duplicate); the list evicts at the
  cap; ordering is stable per the D6 choice; a `cap` of `0` yields an empty list. **Per D2 (RESOLVED),
  scope now also covers the preview-count/threshold logic:** a preview open increments that URI's
  counter without the entry surfacing in suggestions; the counter crossing 3 promotes the entry so it
  surfaces per normal recency/cap/sort rules; a non-preview open is unaffected by the counter; once
  promoted, further preview opens of the same URI do not need to keep incrementing (see § 3 C2
  addendum and § 4 D2's implementer-facing clarification). The exact test shape for the counter is an
  implementation-time decision, not specified further here.

- **T2 (impl)** — `src/recentItems.ts`: `RecentItem` (declared **here, not in `src/types.ts`** — C1),
  `RECENT_STORAGE_KEY = 'bookmarks.recentlyOpened'`, pure `recordOpen(list, entry, cap)`, plus
  `loadRecentItems(memento)` / `saveRecentItems(memento, list)` with a defensive shape check that
  discards malformed persisted state (mirroring `isValidBookmarkData`'s discard-on-invalid posture,
  `src/types.ts:L31-L41`). **Per D2 (RESOLVED):** `RecentItem` gains a `previewCount: number` field (or
  equivalent), and the recording logic implements count-based preview promotion at threshold 3 (§ 4
  D2, § 3 C2 addendum). The precise function signature and where the threshold constant lives are
  implementation-time decisions.

- **T3 (test + impl)** — the tab adapter: a pure `extractTabUri(input: unknown): vscode.Uri |
  undefined` that accepts `TabInputText` / `TabInputCustom` / `TabInputNotebook` (`:L19168`, `:L19204`,
  `:L19239`), and rejects `TabInputTextDiff`, terminals, webviews, and non-`file` schemes (C6).
  Tests construct real `vscode.TabInput*` instances.

- **T4 (impl)** — the tracker: subscribe to `window.tabGroups.onDidChangeTabs` per D1/D2, run the
  adapter, call `recordOpen`, persist, and fire a change event the tree provider listens to. Disposal
  goes on `context.subscriptions` (`src/extension.ts:L119-L124` pattern). **Per D2 (RESOLVED):** VS
  Code reuses a single preview tab across successive Explorer single-clicks on different files, so
  whether repeated previews of the *same* URI arrive via the `opened` array or the `changed` array
  (§ 2 item 2, `:L19339-L19353`) determines whether `previewCount` ever advances. Which event
  array(s) feed the counter is an implementation-time decision — verify empirically which array VS
  Code actually fires for this case before assuming `opened` alone suffices.

- **T5 (test + impl)** — tree provider: add the `suggestedRoot` / `suggestion` arms to `BookmarkNode`
  (`src/bookmarksTreeDataProvider.ts:L10-L14`); `getTreeItem` sets `contextValue`
  (`bookmarkSuggestion`), `resourceUri`, and `command: vscode.open` (mirroring `:L220-L222`);
  `getChildren` filters out URIs already present in either store (C7/D9). **Regression tests must
  cover the four existing `kind`-switching sites** — `handleDrag` (`:L71-L73`), `handleDrop`
  (`:L110-L141`), `createRemoveHandler` (`src/commands.ts:L84-L90`), `createRevealHandler`
  (`src/commands.ts:L110-L118`) — because widening the union makes TypeScript silent wherever a
  default return already exists (R4).

- **T6 (test + impl)** — `bookmarks.promoteSuggestion` in `src/commands.ts`, routed through the
  existing `addBookmark` helper (`:L47-L61`) so `DuplicateBookmarkError` behaves identically to every
  other add path. Test that promoting removes the item from the suggestions list on the next render
  (it becomes bookmarked, so C7 filters it).

- **T7 (impl)** — `package.json`: the new command (`category: "Bookmarks Plus"`), a
  `view/item/context` entry keyed on `viewItem == bookmarkSuggestion`, **and** the
  `commandPalette: { "when": "false" }` entry (C5). Plus the `configuration` block for
  `bookmarksPlus.suggestions.maxItems` (D3, RESOLVED).

- **T8 (test + impl)** — `activate()` wiring in `src/extension.ts`; extend
  `src/test/suite/extension.test.ts`. `src/test/suite/fixtures.ts` may need a fake tab-groups shape
  if the tracker is tested at the `activate()` level rather than via T3's pure adapter.

- **T9 (docs)** — `README.md` (new panel section, new command, and any new setting) and
  `CHANGELOG.md`.

## 6. Out of scope

- **Any use of `_workbench.getRecentlyOpened`** — wrong granularity (workspaces/folders, not files)
  and unsupported internal API (research `:L64-L70`).
- **Recently-opened *workspaces*.** This feature is about items within a workspace.
- **Renaming/moving detection.** A recorded URI that no longer resolves is handled by D4's staleness
  choice, not by watching for renames.
- **Do not conflate with `alefragnani/vscode-bookmarks`' "suggestion" feature** — that is bookmark
  *label* auto-fill from a text selection, an unrelated concern that merely shares the word
  (research `:L72-L77`).
- **The `#96` Explorer decoration.** Separate plan.

## 7. Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | MRU churn: the list reorders under the user's cursor when a suggestion is clicked | D6 (RESOLVED) — sort by first-seen timestamp, not most-recent |
| R2 | Preview tabs flood the list during Explorer arrow-keying | D2 (RESOLVED) — count-based promotion, threshold 3, instead of `Tab.isPreview` filtering alone |
| R3 | Persisted URIs go stale (deleted/renamed files) | D4 — pick exactly one staleness strategy |
| R4 | Widening `BookmarkNode` silently changes behavior at existing `kind`-switching sites | C4 + T5's four explicit regression tests |
| R5 | Non-`file` scheme tabs become un-openable bookmarks | C6 + T3 |
| R6 | Implementer folds the MRU into `BookmarkData`, forcing a schema bump and leaking browsing history into a committed `.vscode/bookmarks.json` | C1, stated as a hard constraint with both reasons |

## 8. Traceability

- Issue: [#95](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/95) (open, milestone
  `Bookmark discovery UX` / #4, label `enhancement` — verified 2026-08-25).
- Milestone: #4 `Bookmark discovery UX`, shared with #96.
- Research: `docs/research/2026-08-25-bookmarks-suggested-and-explorer-decoration.md`.
- Sibling plan: `docs/superpowers/plans/2026-08-25-explorer-decoration-for-bookmarked-files.md`.
- **Not done in this session (no Bash / no GitHub MCP):** per-task tracking issues were not created
  and no milestone assignment was written. See the return summary.
