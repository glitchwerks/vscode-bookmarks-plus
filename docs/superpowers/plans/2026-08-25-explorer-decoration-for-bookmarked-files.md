---
title: 'Issue #96 — Explorer file decoration for bookmarked items'
touches:
  - src/bookmarkDecorationProvider.ts
  - src/extension.ts
  - src/test/suite/bookmarkDecorationProvider.test.ts
  - src/test/suite/extension.test.ts
  - package.json
  - README.md
  - CHANGELOG.md
skills_relevant:
  - test-driven-development
  - using-git-worktrees
  - pull-request-workflow
---

# Implementation plan — issue #96: Explorer decoration for bookmarked files

**Issue:** [#96](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/96) — state `open`,
milestone `Bookmark discovery UX` (milestone #4), label `enhancement`. Body and metadata verified
2026-08-26 via the GitHub connector.
**Prior art:** `docs/research/2026-08-25-bookmarks-suggested-and-explorer-decoration.md` (§ "Feature
2", `:L79-L128`).
**Sibling feature:** issue #95. The two features share a milestone but touch disjoint code; see D6
for the one-PR-vs-two decision. No sibling plan is referenced here because no such artifact is
committed on this branch (`git ls-tree -r HEAD -- docs/superpowers/plans` did not list a plan for
issue #95 on 2026-08-26).

---

## 1. What this delivers

A `vscode.FileDecorationProvider` that marks bookmarked files (and folders) in VS Code's built-in
Explorer tree, so a user can see what is bookmarked without opening the Bookmarks Plus panel.

Per issue #96, the requirement is: *"Visually identify bookmarked items in VS Code's built-in
file Explorer (badge/color decoration) so users can spot bookmarked items without opening the
Bookmarks Plus panel."*

This is entirely new surface — grep confirmed no `FileDecoration`, `FileDecorationProvider`, or
`registerFileDecorationProvider` exists anywhere in `src/` (router-brief Explore map; independently
consistent with `src/extension.ts:L86-L182`, which registers only a tree view).

## 2. Verified API facts the implementation depends on

`package.json:L12` declares `"engines": { "vscode": "^1.85.0" }`. `package.json:L103` allows newer
typings via `"@types/vscode": "^1.85.0"`, and the current lockfile resolves 1.125.0
(`package-lock.json:L850-L851`), so the installed typings alone cannot prove minimum-host
compatibility. The required surface was therefore checked directly against VS Code's `1.85.0`
tag: `FileDecoration` and `FileDecorationProvider` are present at
https://github.com/microsoft/vscode/blob/1.85.0/src/vscode-dts/vscode.d.ts#L7525-L7584
(fetched 2026-08-26), and `window.registerFileDecorationProvider` is present at
https://github.com/microsoft/vscode/blob/1.85.0/src/vscode-dts/vscode.d.ts#L11059-L11065
(fetched 2026-08-26).

1. `window.registerFileDecorationProvider(provider: FileDecorationProvider): Disposable`
   (VS Code `1.85.0` source linked above). **No `contributes` entry is required** — this is a pure
   code API.
2. `FileDecorationProvider` (VS Code `1.85.0` source linked above):
   - `onDidChangeFileDecorations?: Event<undefined | Uri | Uri[]>` (`:L7571`) — optional; firing
     `undefined` means "everything changed".
   - `provideFileDecoration(uri, token): ProviderResult<FileDecoration>` (`:L7584`), documented as
     *"only called when a file gets rendered in the UI"* (`:L7576`).
3. `FileDecoration` (`:L7525-L7555`): `badge?: string` (`:L7530`), `tooltip?: string`
   (`:L7535`), `color?: ThemeColor` (`:L7540`), `propagate?: boolean` (`:L7546`), and
   `constructor(badge?, tooltip?, color?)` (`:L7555`).
4. **The typings state no numeric badge limit** — `badge` is documented only as *"A very short string
   that represents this decoration"* (`:L7528`). The enforced limit lives in VS Code's runtime
   `FileDecoration.validate()`: **up to two grapheme-aware characters**, throwing
   `The 'badge'-property must be undefined or a short character` otherwise, and throwing
   `The decoration is empty` when none of `color`/`badge`/`tooltip` is set
   (`docs/research/2026-08-25-bookmarks-suggested-and-explorer-decoration.md:L89-L95`). Task T0/E3
   confirms this empirically rather than trusting either source alone — the research note records
   that VS Code's own published docs page and `validate()` disagree (`:L94`).
5. **ThemeIcon/codicon badges are not shippable.** A `ThemeIcon` badge (`FileDecoration2`) exists only
   in `vscode.proposed.codiconDecoration.d.ts` behind still-open proposal microsoft/vscode#135591;
   proposed APIs cannot be published to the Marketplace (research `:L97-L103`). **Do not design
   toward `$(bookmark)`.** Re-check whether #135591 stabilized at implementation time (research
   `:L141`) — but plan for text.

### Store facts this design keys off

6. `BookmarkStore.getAll(): BookmarkData` is **synchronous** (`src/bookmarkStore.ts:L121`) — so
   `provideFileDecoration` never needs to await anything.
7. `onBookmarksChanged` (`src/bookmarkStore.ts:L54-L55`) is fired from **two** sites: the normal
   persist path (`:L96-L97`) and the mirror-reload path (`:L391-L393`). Subscribing to the event
   therefore already covers externally-authored `.vscode/bookmarks.json` edits, with no extra wiring.
8. Two stores exist in `activate()` — workspace (`src/extension.ts:L99-L101`) and global
   (`:L102`). Both are already in scope at the point where the provider would be registered.
9. `BookmarkItem.uri` is documented as `vscode.Uri.toString()`, *"always absolute, never
   workspace-relative"* (`src/types.ts:L6`), and `BookmarkItem.type` is `'file' | 'folder'`
   (`src/types.ts:L5`).

## 3. Design constraints (not decisions — these are settled by the sources above)

- **C1 — `propagate` must be omitted or explicitly `false`.** `FileDecoration.propagate` (`:L7546`)
  pushes the decoration up to every ancestor, so a single bookmarked file would badge its whole
  parent chain to the workspace root. The typings also note that a propagated descendant decoration
  must be separately signalled via `onDidChangeFileDecorations` (`:L7576-L7578`) — plumbing this
  feature does not want. Bookmarked *folders* are decorated because they are themselves bookmarked
  (see D3), never by propagation.

- **C2 — canonicalize URIs at the decoration-map boundary.** Export one pure
  `decorationUriKey(uri, platform = process.platform)` helper and use it for both stored and incoming
  URIs. For `file:` URIs, key by `uri.fsPath`, lower-cased only when `platform === 'win32'`; for
  non-file schemes, key by `uri.toString()`. Parse stored values with `vscode.Uri.parse(item.uri,
  true)` so the documented absolute-URI contract is enforced, and catch failures per item so one
  malformed externally-authored entry is skipped rather than breaking activation or every later
  refresh. Reason:
  the mirror load path exists precisely because *"the author may be an external process that does not
  know this schema"* (`src/types.ts:L77-L81`); that path validates `uri` only as a non-empty string
  (`isStrictBookmarkData` → `isValidBookmarkItem`, `src/types.ts:L52-L53`) and then hands off to
  `normalizeBookmarkData` (`src/bookmarkStore.ts:L389`), **which does not normalize the URI string** —
  it only uses it verbatim as a dedupe key (`src/normalize.ts:L92-L99`). An externally-authored entry
  can therefore differ from the Explorer URI in Windows drive-letter case or URI escaping and would
  silently never match if both sides used their raw strings. **Do not change `hasDuplicateBookmark`
  (`src/bookmarkStore.ts:L108`)** — the store-side normalization asymmetry is real but is out of
  scope here; record it as a follow-up issue (see § 7).

- **C3 — `provideFileDecoration` must do zero I/O.** It runs for every file rendered in the Explorer
  (`:L7576`). Implementation is a `Set`/`Map` membership check only: no `fs.stat`, no
  `FsGitCache.get` (which resolves existence *and* the git repo — `src/extension.ts:L69-L84`), no
  promises. Note the contrast with VS Code's git extension, which uses `@debounce(500)` in its
  *ignore* provider because that check is genuinely expensive (research `:L85`); ours is not, so a
  debounce would add latency for no benefit.

- **C4 — batch the change event using the git provider's diff pattern.** Keep the previous key set,
  recompute on `onBookmarksChanged`, and fire **once** with the union of removed + added URIs
  (research `:L85`, modelling `GitDecorationProvider.onDidRunGitStatus`). Firing `undefined` is legal
  (`:L7571`) and simpler, at the cost of re-rendering every visible row on every bookmark change —
  acceptable as a first cut, but the union-diff is only a few lines more and is the pattern to land.

- **C5 — dispose everything.** Push the `Disposable` returned by `registerFileDecorationProvider`
  (`:L11065`), both store subscriptions, and the configuration-change subscription onto
  `context.subscriptions`, matching the existing pattern at `src/extension.ts:L119-L124`.

## 4. Phase 0 — empirical gate (blocks D1 and implementation)

Three questions cannot be answered from documentation and **must be answered before the visual
treatment is frozen.** Run these manually in an Extension Development Host with a temporary
hard-coded provider; record the answers as a comment on issue #96 and as a short findings block
appended to this plan before task T1 starts.

| ID | Question | Why it can't be desk-checked |
| --- | --- | --- |
| **E1** | When a file is **both bookmarked and git-modified**, does the Explorer show our badge, git's `M`, both, or neither? | This is the *common* case for any bookmarked file you are actively editing. If git wins the badge slot, a badge cannot be the primary signal and D1 must change. No source consulted answers badge-slot contention between two registered providers. |
| **E2** | For a bookmarked **folder** containing git-modified files: does returning a decoration with (a) no `color` property at all, versus (b) `color: undefined` explicitly, preserve git's own folder color? | microsoft/vscode#187756 reports that a bookmark-style decoration overrides git's folder color and that *"a default color is used if none is provided"* — but the issue carries **no maintainer analysis, no confirmed root cause, and no workaround** (research `:L105-L111`). Treat as an open, untested question in both directions. |
| **E3** | Does a 2-character badge succeed and a 3-character badge throw, per `validate()`? Does the chosen glyph render legibly in both light and dark themes on Windows? | The typings give no limit (`:L7528`); the limit comes from a source read (research `:L89-L95`). Glyph legibility is inherently visual. |

**Gate rule:** if E1 shows git's badge suppresses ours on modified files, D1 option (a)
(badge-and-tooltip only) is not viable as the sole signal and the decision returns to the user.

## 5. Open decisions requiring user input

The plan body below is written **AC-conformant** — issue #96 asks for "badge/color", so both are
carried as live options rather than one being silently dropped.

- **D1 — visual treatment and glyph.**
  - (a) **badge + tooltip, no `color`** — sidesteps microsoft/vscode#187756 entirely and needs no
    `contributes.colors` entry. Risk: depends on E1.
  - (b) **badge + tooltip + `color`** via a contributed theme color (e.g.
    `bookmarksPlus.decorationForeground`), so themes can restyle it. Requires a `contributes.colors`
    section — net-new in `package.json`. Blocked on E2.
  - (c) **`color` only, no badge** — quietest, but invisible to anyone who doesn't know to look, and
    still carries the E2 risk.
  - *Planner recommendation:* start at (a), promote to (b) if E2 clears. **Glyph needs a user pick:**
    `🔖` is a single grapheme cluster and reads unambiguously, but emoji rendering in the Explorer
    varies by platform and theme; a plain `★` or `B` is more predictable. E3 covers the render check.
  - **Decision (2026-08-26, provisional pending T0):** option (a) — badge + tooltip only, no `color`.
    Glyph: `★` (plain star character — not `🔖`, not `B`). This stays subject to the §4 **Gate rule**:
    if T0's answer to E1 shows git's own change-badge suppresses ours on modified files, D1 reopens
    and "the decision returns to the user" (§4) exactly as originally specified — this resolution does
    not override that gate.

- **D2 — which stores feed the decoration?** Workspace store only, or workspace ∪ global?
  *Recommendation:* the **union**. The user's question at the Explorer is "is this bookmarked?", not
  "in which scope?", and both stores are already in scope at the registration site
  (`src/extension.ts:L99-L102`). Structurally free.
  **Decision (2026-08-26):** the union — Workspace ∪ Global, per the recommendation above.

- **D3 — decorate bookmarked folders too?** `BookmarkItem.type` includes `'folder'`
  (`src/types.ts:L5`), and a folder row decorates through the same map at no extra cost.
  *Recommendation:* yes — but note this is exactly the surface where E2's git-folder-color risk lives,
  so D3 = yes plus D1 = (b) is the highest-risk combination.
  **Decision (2026-08-26):** yes, per the recommendation above. Note D1 resolved to (a), not (b), so
  the "highest-risk combination" called out here does not apply to this plan as currently scoped.

- **D4 — opt-out setting?** The extension contributes **no `configuration` section today**
  (`package.json:L17-L86` has none), so adding one is net-new surface.
  - (a) always on, no setting — smallest v1.
  - (b) `bookmarksPlus.explorerDecoration.enabled`, default `true`.
  *Recommendation:* (b) is the safer product call (a decoration users can't turn off is a common
  complaint) but (a) is the simplicity-first call. User's choice; it is one `configuration` block plus
  one `workspace.onDidChangeConfiguration` listener for option (b).
  **Decision (2026-08-26):** (b) — add `bookmarksPlus.explorerDecoration.enabled`, default `true`.
  Register the provider regardless of the initial value, but have it return `undefined` while
  disabled. On a matching configuration change, update the provider's enabled state and fire one
  invalidation event for all currently indexed URIs so the Explorer updates immediately in either
  direction. This confirms both manifest and runtime wiring as in-scope.

- **D5 — tooltip text.** Flat `"Bookmarked"` (lookup structure is a `Set<string>`), or richer, e.g.
  `"Bookmarked — <collection name>"` (structure becomes `Map<string, string>`; the collection lookup
  is in-memory and cheap). *Recommendation:* flat string for v1; the `Map` upgrade is a
  non-breaking follow-up.
  **Decision (2026-08-26):** flat `"Bookmarked"` string, per the recommendation above.

- **D6 — ship with #95 as one PR, or two?** *Recommendation:* **two.** The surfaces are disjoint
  (this feature touches no tree-provider, command, or persistence code), #96 has no persisted state
  and no schema question, and #96 is the shorter path to something visible. Tracking #95 and #96 as
  separate issues does **not** by itself decide PR count — this is the decision that does.
  **Decision (2026-08-26):** two separate PRs, per the recommendation above.

## 6. Task breakdown (TDD; each implementation slice ends in one green commit)

Follow `superpowers:test-driven-development` — the test lands red first, then the implementation.
Tests run in a real extension host via `@vscode/test-electron` (`src/test/runTest.ts`), so
`vscode.*` classes are available for real in tests.

- **T0 — Phase-0 empirical runbook.** Answer E1/E2/E3 in an Extension Development Host. Record
  results on issue #96 and append a findings block to this plan. **No implementation task starts
  before T0 is recorded**, because E1 can invalidate D1.
  **Failure branch:** if E1 shows git's badge suppresses ours on modified files, **halt and return to
  the user with D1 reopened** — do not fall through to T1 on an assumed D1(b)/(c). If E2 shows the
  `color` override is unavoidable, D1(b) is off the table but T1 may proceed on D1(a).

- **T1 (test + impl)** — `src/test/suite/bookmarkDecorationProvider.test.ts` and
  `src/bookmarkDecorationProvider.ts`. Add
  `decorationUriKey(uri: vscode.Uri, platform?: NodeJS.Platform): string`,
  `buildDecoratedUriKeys(itemGroups: readonly BookmarkItem[][]): Set<string>`, and a
  `BookmarkDecorationProvider implements vscode.FileDecorationProvider` class. Cover:
  - a bookmarked URI is present in the key set and returns the `★` / `Bookmarked` decoration;
  - `file:///C:/tmp/a.txt`, `file:///c%3A/tmp/a.txt`, and the Explorer-style
    `vscode.Uri.file('c:/tmp/a.txt')` produce the same key when the helper is explicitly passed
    `win32` — the C2 regression test must exercise different case and escaping, not merely construct
    the same uppercase drive twice;
  - a malformed or relative stored URI is ignored without throwing, while subsequent valid entries
    still decorate;
  - the set is the union of both stores' items (per D2);
  - an empty store yields an empty set; a non-bookmarked URI yields `undefined` from
    `provideFileDecoration`.
  `propagate` is never set (C1). No async, no I/O (C3). Run the focused test red before implementation,
  then green; commit test and implementation together so the branch does not contain an intentionally
  failing commit.

- **T2 (test + impl)** — change-event wiring: subscribe to both stores' `onBookmarksChanged`
  (`src/bookmarkStore.ts:L54-L55`), recompute, and fire once with the union of added + removed URIs
  (C4). Tests cover both event sources explicitly:
  1. construct a real `BookmarkStore` against `FakeMemento` and call a normal mutation, covering the
     persist fire site (`src/bookmarkStore.ts:L96-L97`);
  2. construct the workspace store with `FakeMirror`, establish the mirror hash, replace the mirror
     content, call and await `reloadFromMirror()`, and assert exactly one invalidation containing the
     changed URI, covering the mirror-adoption fire site (`src/bookmarkStore.ts:L389-L393`).

- **T3 (test + impl)** — enabled-state behavior in `BookmarkDecorationProvider`. Add
  `setEnabled(enabled: boolean): void`: no-op when unchanged; when changed, update the state and fire
  once with every currently indexed URI. Tests assert default-enabled output, disabled output,
  enabled→disabled invalidation, disabled→enabled invalidation, and no event for a repeated value.

- **T4 (test + impl)** — registration, configuration, and disposal in `src/extension.ts`. Export a
  small `registerBookmarkDecorationProvider` helper with injectable registration/configuration
  dependencies so the test does not rely on subscription-array counts or monkey-patching the
  read-only `vscode` module. Production defaults must:
  - read `bookmarksPlus.explorerDecoration.enabled` with fallback `true`;
  - register the provider exactly once regardless of the initial enabled value;
  - subscribe to `workspace.onDidChangeConfiguration`, react only when
    `affectsConfiguration('bookmarksPlus.explorerDecoration.enabled')` is true, and pass the freshly
    read value to `setEnabled`;
  - push the provider registration, configuration listener, and both store-event subscriptions onto
    `context.subscriptions`.
  Injected-fake tests assert each behavior and disposal identity; the real activation test remains a
  smoke test rather than trying to identify an opaque registration disposable by array position.

- **T5 (test + impl)** — `package.json` contribution and manifest assertion in
  `src/test/suite/extension.test.ts`. D1 resolved to (a), so no `contributes.colors` section is needed.
  Add `contributes.configuration.properties.bookmarksPlus.explorerDecoration.enabled` with
  `type: "boolean"`, `default: true`, and `scope: "window"`; assert those exact values through
  `ext.packageJSON`.

- **T6 (docs)** — `README.md` (the decoration is user-visible behavior and D4(b) adds a new setting)
  and `CHANGELOG.md`.

## 7. Out of scope

- **Editor gutter / line decorations.** That is `TextEditorDecorationType`, a different API — it is
  what the sibling extension `alefragnani/vscode-bookmarks` uses, and it has **no** Explorer-decoration
  code at all (research `:L113-L119`). Nothing portable, nothing wanted here.
- **Decorating any tree other than the Explorer.** The Bookmarks Plus tree already shows its own icons
  (`src/bookmarksTreeDataProvider.ts:L210-L218`).
- **Store-side URI normalization.** C2 fixes the read boundary only. Normalizing at
  `hasDuplicateBookmark` (`src/bookmarkStore.ts:L108`) would change duplicate-detection semantics for
  existing data — **file as a separate issue**, do not fold in.
- **The `#95` suggested-bookmarks feature.** Separate plan, separate decisions.

## 8. Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | Git's badge suppresses ours on modified files — the common case for an actively-edited bookmark | E1 gate before D1 is frozen |
| R2 | Bookmark decoration overrides git's folder color (microsoft/vscode#187756, research `:L105-L111`) | E2 gate; D1(a) avoids it outright |
| R3 | Implementer reaches for a `$(bookmark)` codicon badge | C1/§2.5: proposed-API-only, not Marketplace-shippable (research `:L97-L103`) |
| R4 | Accidental `await`/I/O inside `provideFileDecoration` degrades the whole Explorer | C3; T1 asserts the method is synchronous |
| R5 | Externally-authored mirror URIs never match, or one malformed URI breaks refresh | C2 + dedicated T1 case/escaping and malformed-input regression tests |
| R6 | Opt-out setting appears in Settings but does not change the Explorer until reload | D4 + T3/T4 runtime-toggle and invalidation tests |

## 9. Traceability

- Issue: [#96](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/96) (open, milestone
  `Bookmark discovery UX` / #4, label `enhancement` — verified 2026-08-26).
- Milestone: #4 `Bookmark discovery UX`, shared with #95.
- Research: `docs/research/2026-08-25-bookmarks-suggested-and-explorer-decoration.md`.
- Sibling feature: issue #95. No uncommitted plan path is used as a durable reference.
- Per-task tracking issues are intentionally not created: issue #96 is the single source of truth for
  this bounded feature, and the tasks above are implementation steps rather than independent work
  items.
