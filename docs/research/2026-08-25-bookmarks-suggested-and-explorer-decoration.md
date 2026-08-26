# Prior-art scouting: suggested bookmarks from recent items, and Explorer file decoration

## Idea

Two candidate features for Bookmarks Plus (`glitchwerks/vscode-bookmarks-plus`): (1) track the last 5-10 recently opened files/items per workspace and surface them as dismissible "suggested to bookmark" entries in the existing tree panel, and (2) badge/color bookmarked files in VS Code's built-in Explorer tree using `FileDecorationProvider`.

## Requirements

**Feature 1 — suggested bookmarks:**
1. Track the last 5-10 most recently opened files/items, scoped per workspace.
2. Surface them as "suggested to bookmark" entries in the existing `bookmarksView` tree panel.
3. Each suggested item remains independently clickable/openable without first being converted into a real bookmark.
4. Must not collide conceptually with the sibling extension's existing "suggest a label from selection" feature (different concern, easy to conflate by name).

**Feature 2 — Explorer decoration:**
1. Badge and/or color files in the built-in Explorer based on bookmark membership — a form of state the built-in Explorer has no native visual language for (unlike git status).
2. Must not fight or silently override git's own SCM decorations for files that are both bookmarked and have git status.
3. Must understand the documented and undocumented limits of `FileDecorationProvider` (badge length, refresh/invalidation, performance) before design commits to a specific visual treatment.

## Search axes used

- **Direct synonyms** — "recently opened files" MRU tracking in a VS Code extension; `FileDecorationProvider` example / tutorial.
- **Problem-shape synonyms** — "suggest to bookmark" / quick-access-to-recent-items UX; "non-git file badges in Explorer".
- **Adjacent domains** — IntelliJ-style recent-files navigation; Obsidian's recent-files sidebar plugin (same MRU-list-in-a-panel shape, different host API); VS Code's own SCM (git) decoration provider as the first-party reference implementation.
- **Vendor-specific phrasing** — VS Code extension API reference for `FileDecoration`/`FileDecorationProvider`/`registerFileDecorationProvider`; `ExtensionContext.workspaceState` vs `globalState`; VS Code's internal (non-API) `_workbench.getRecentlyOpened` command and the `vscode.proposed.*.d.ts` proposed-API mechanism.
- **Negative axes** — NOT `TextEditorDecorationType` (gutter/line/editor-scoped decorations — a different API already used by the closest sibling extension, not Explorer-tree badging); NOT alefragnani/vscode-bookmarks' `suggestion.ts` (bookmark *label* auto-fill from selected text, unrelated to surfacing recent items).

## Shortlist (ranked by expected value)

### Feature 1 — Suggested bookmarks from recent items

#### 1. `microsoft/vscode` issue #136878 — "Provide API to access the list of recently opened files in a workspace"
- **URL:** https://github.com/microsoft/vscode/issues/136878 (fetched 2026-08-25)
- **Relevance:** addresses requirement 1 directly, in the negative — there is no public extension API to enumerate recently opened files in a workspace. The request dates to 2021 and references an earlier, closed 2019 request (#64223); it remains unresolved/backlog as of this writing.
- **Maturity:** long-lived, unresolved feature request; no maintainer commitment to ship an API.
- **Worth borrowing:** the conclusion itself — plan for building and owning an MRU list rather than reading one from VS Code.
- **What to avoid:** don't assume a future API will appear; design as if this gap is permanent.
- **Lift effort:** n/a (informs scope, not code).

#### 2. `wahyd4/vscode-plugin-recent-files` (deprecated) — minimal MRU tracker + QuickPick UI
- **URL:** https://github.com/wahyd4/vscode-plugin-recent-files/blob/master/src/extension.js and `src/file.js` (fetched 2026-08-25, default branch `master`)
- **Relevance:** addresses requirement 1 (MRU tracking shape) and partially requirement 3 (each item opened via `workspace.openTextDocument` on selection). Does not address requirement 2 (no tree-view surfacing — QuickPick only) or persistence.
- **Maturity:** author marks the repo "Deprecated!"; last push 2018-04-08; unmaintained.
- **Worth borrowing:** the cap-and-evict shape — `list` is a plain in-memory array, capped at exactly 20 via `if (list.length === 20) list = _.tail(list)`, deduplicated via `_.uniq(list)`, and updated on `vscode.window.onDidChangeActiveTextEditor`.
- **What to avoid:** the tracker reads `vscode.window.activeTextEditor._documentData._uri.path` — a private, underscore-prefixed internal field, not the public `document.uri`. This is exactly the kind of private-API reliance that breaks across VS Code releases. Also: no persistence (list is lost on window reload) and no per-workspace scoping.
- **Lift effort:** study-only (JS, 2018-era API surface, unmaintained).

#### 3. `percygrunwald/vscode-intellij-recent-files` — thin wrapper over VS Code's own internal editor MRU
- **URL:** https://github.com/percygrunwald/vscode-intellij-recent-files/blob/master/src/extension.ts (fetched 2026-08-25)
- **Relevance:** negative finding for requirement 1. The entire implementation (13 lines) is `workbench.action.quickOpen` followed by `workbench.action.quickOpenNavigateNext` (or `quickOpenSelectNext`) — it drives VS Code's own built-in Quick Open MRU navigation via command, rather than reading a list. This confirms VS Code's internal per-editor-group MRU exists but is exposed only as *navigate next/previous* commands, never as an enumerable list — consistent with issue #136878.
- **Maturity:** last pushed 2023-07-19; small hobby project, still listed on the Marketplace.
- **Worth borrowing:** nothing code-wise; useful as corroborating evidence for the "must build your own" conclusion.
- **What to avoid:** don't assume wrapping a built-in command gets you an enumerable recent-items list — it doesn't.
- **Lift effort:** n/a.

#### 4. `tgrosinger/recent-files-obsidian` (Obsidian plugin, adjacent domain) — sidebar MRU list with prune-to-max-length and per-item dismiss
- **URL:** https://github.com/tgrosinger/recent-files-obsidian/blob/main/main.ts (fetched 2026-08-25)
- **Relevance:** addresses requirements 1-3 in shape, on a different host platform. Updates the list on a `file-open` (or `file-edit` via `quick-preview`) event; `pruneLength()` trims the array once it exceeds `maxLength` (default 50, user-configurable); persisted via the plugin's own `saveData()`/`loadData()`; each list entry renders as an independently clickable element that calls `focusFile()` to open the target, with a separate per-item delete (`lucide-x`) control to dismiss without opening.
- **Maturity:** actively distributed on the Obsidian community plugin registry; cannot verify exact commit recency from this pass.
- **Worth borrowing:** the *shape* of "update-on-open, prune-to-configurable-max, persist via host-provided storage, list items independently clickable with a separate dismiss affordance" — this is the closest UX precedent found anywhere for "suggested items that remain independently actionable." It is Obsidian's plugin API, not VS Code's, so nothing here is portable as code.
- **What to avoid:** don't treat this as a VS Code API reference — `saveData()`/`loadData()`/workspace `leaf` concepts have no VS Code equivalent; only the interaction pattern transfers.
- **Lift effort:** study-only (different platform).

#### 5. `_workbench.getRecentlyOpened` internal command — real usage found, but wrong granularity
- **URL:** confirmed real third-party usage in https://github.com/jackiotyu/git-worktree-manager/blob/main/src/core/util/workspace.ts (fetched 2026-08-25); the command itself is registered in VS Code core at `src/vs/workbench/browser/actions/workspaceCommands.ts` (unstable, no doc anchor — internal API).
- **Relevance:** partially informs requirement 1. `git-worktree-manager` calls `vscode.commands.executeCommand('_workbench.getRecentlyOpened')` and reads the `.workspaces` array (typed `IRecentFolder | IRecentWorkspace`) to get recently opened **folders and workspaces** — not individual files. A broad code search for this command returns ~100+ hits, but the large majority are VS Code-core forks (the command's own definition file, `workspaceCommands.ts`, appearing repeatedly across forked repos) rather than third-party extensions consuming it; `git-worktree-manager` is the clearest confirmed non-fork consumer found.
- **Maturity:** the command is internal/undocumented (underscore-prefixed), not part of the stable extension API surface, and can change or disappear across VS Code releases without notice.
- **Worth borrowing:** nothing directly — it answers a different question (recent workspaces/folders, not recent files) and carries real breakage risk since it sits outside the supported API contract.
- **What to avoid:** don't reach for this command as a shortcut to "recently opened files" — it doesn't return files, and it's unsupported.
- **Lift effort:** not applicable to this feature's requirements.

#### 6. `alefragnani/vscode-bookmarks` `src/suggestion.ts` — a different "suggestion" feature (do not conflate)
- **URL:** https://github.com/alefragnani/vscode-bookmarks/blob/master/src/suggestion.ts (fetched 2026-08-25)
- **Relevance:** none to requirement 1, despite being the closest sibling extension. This module implements `label.suggestion` config (`dontUse` / `suggestWhenSelected` / `useWhenSelected` / `suggestWhenSelectedOrLineWhenNoSelected`) — it pre-fills a bookmark's *label* from the current text selection or line at the moment a bookmark is created. It has nothing to do with surfacing recently-opened items as bookmark candidates.
- **Worth borrowing:** nothing for this feature.
- **What to avoid:** don't let the shared word "suggestion" cause scope confusion during planning — this is a distinct, already-solved-elsewhere problem in the sibling extension.
- **Lift effort:** n/a.

### Feature 2 — Explorer file decoration for bookmarked files

#### 1. `microsoft/vscode` — `extensions/git/src/decorationProvider.ts` (first-party, canonical reference)
- **URL:** https://github.com/microsoft/vscode/blob/80e7b544f2927d3031630b33fdbe9c8a53f8cebc/extensions/git/src/decorationProvider.ts (fetched 2026-08-25)
- **Relevance:** addresses requirements 1 and 3 directly — this is VS Code's own shipped implementation of `FileDecorationProvider`, used to badge git status in the Explorer. Three separate providers are registered: `GitDecorationProvider` (status badges/colors, e.g. `badge: 'S'` for submodules), `GitIncomingChangesFileDecorationProvider` (2-character badges like `'↓A'`, `'↓M'`, `'↓D'`, `'↓~'` for incoming changes), and `GitIgnoreDecorationProvider` (debounced, batched ignore-check).
- **Maturity:** part of VS Code core, actively maintained, MIT-licensed.
- **Worth borrowing:** the refresh pattern — maintain a `Map<string, FileDecoration>` keyed by `uri.toString()`, recompute it on the relevant change event, union the old and new key sets, and fire `onDidChangeFileDecorations` once with the full `Uri[]` of everything that might have changed (see `GitDecorationProvider.onDidRunGitStatus`). Also the `@debounce(500)` pattern in `GitIgnoreDecorationProvider.checkIgnoreSoon()` for coalescing many `provideFileDecoration` calls into one batched check when the underlying check is expensive.
- **What to avoid:** nothing — this is the trustworthy reference to model against, not a source of anti-patterns.
- **Lift effort:** adapt-pattern (the git-specific status computation doesn't transfer, but the provider/event/batching architecture does).

#### 2. `microsoft/vscode` — `FileDecoration.validate()` in `src/vs/workbench/api/common/extHostTypes.ts` (stable API constraint, authoritative)
- **URL:** https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/api/common/extHostTypes.ts (fetched 2026-08-25)
- **Relevance:** addresses requirement 3 — the actual enforced badge-length rule, which several secondary web sources describe inconsistently (one source said "2 characters," VS Code's own docs page said "single character" when fetched). The real rule from source: if `badge` is a string, `validate()` computes `nextCharLength(badge, 0)`, and if that's shorter than the full string, adds a second `nextCharLength` call — then throws `The 'badge'-property must be undefined or a short character` if the string is still longer than that. This is **up to two grapheme-cluster-aware "characters"** (correctly handling surrogate pairs/emoji), not a strict single character and not a raw UTF-16 code-unit count — confirmed empirically by the git provider's own `badge: '↓A'` (2 visible characters) and `badge: 'S'` (1). Also confirmed: a `FileDecoration` with none of `color`/`badge`/`tooltip` set throws `The decoration is empty`.
- **Maturity:** authoritative, current `main` branch source.
- **Worth borrowing:** the exact constraint, so the badge design targets "at most 2 short characters" rather than the (wrong) "single character" figure some docs pages report.
- **What to avoid:** don't trust `code.visualstudio.com`'s prose description of the badge limit over the enforced `validate()` logic — the two disagree, and `validate()` is what actually runs.
- **Lift effort:** reference only.

#### 3. `microsoft/vscode` — `vscode.proposed.codiconDecoration.d.ts` (ThemeIcon badges are proposed-API-only, not stable)
- **URL:** https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.codiconDecoration.d.ts (fetched 2026-08-25), tracking issue https://github.com/microsoft/vscode/issues/135591
- **Relevance:** directly resolves an ambiguity in requirement 3. `extHostTypes.ts` (internal implementation) types `badge` as `string | vscode.ThemeIcon`, which looks like ThemeIcon/codicon badges (e.g. `$(bookmark)`) are usable to sidestep the 2-character text limit. They are **not**, for a Marketplace-published extension: the `ThemeIcon`-badge surface (`FileDecoration2`) lives only in this `vscode.proposed.*.d.ts` file, gated behind a still-open proposal (#135591). Proposed APIs require explicit opt-in (`enabledApiProposals` in `package.json`) and are not installable from the Marketplace for arbitrary users — only for extensions VS Code has allowlisted or that ship pre-release/insiders-only.
- **Maturity:** proposal open, unmerged into stable as of this fetch.
- **Worth borrowing:** the awareness that a ThemeIcon badge is not a shippable option today — plan the visual design around the enforced 2-character text limit, not around codicons.
- **What to avoid:** designing the decoration around `$(bookmark)`-style badges before confirming (at implementation time, against the then-current `vscode.d.ts`) whether proposal #135591 has since stabilized.
- **Lift effort:** reference only.

#### 4. `microsoft/vscode` issue #187756 — reported color-override interaction with git decorations
- **URL:** https://github.com/microsoft/vscode/issues/187756 (fetched 2026-08-25)
- **Relevance:** addresses requirement 2 as an open, unresolved warning rather than a solved problem. The reporter states that a `FileDecoration` with a `color` set — including attempts to pass `null`/`undefined` — appears to override git's own decoration color on folders, and that "a default color is used if none is provided." Two fetch attempts against this issue returned **no maintainer analysis, no confirmed root cause, and no documented workaround**; the issue was "under discussion" at fetch time.
- **Maturity:** open, unresolved, reporter-only content retrieved.
- **Worth borrowing:** the warning itself — treat "does an omitted/undefined `color` field actually preserve git's decoration on a folder, or does VS Code substitute a default" as an open, untested question for this codebase, not a settled fact either way.
- **What to avoid:** don't assume any particular fix (e.g., "just omit `color`") without empirically verifying it in a real Explorer with both a bookmarked and git-modified folder — this belongs in the implementer's test plan, not in inherited guidance.
- **Lift effort:** reference only; flagged as an open question below.

#### 5. `alefragnani/vscode-bookmarks` — `src/decoration/decoration.ts` (negative finding: no Explorer-decoration precedent in the closest sibling)
- **URL:** https://github.com/alefragnani/vscode-bookmarks/blob/master/src/decoration/decoration.ts (fetched 2026-08-25)
- **Relevance:** the extension most similar to Bookmarks Plus does **not** use `FileDecorationProvider` anywhere. All of its visual decoration is `TextEditorDecorationType` — a gutter icon (`createGutterRulerDecoration`), an overview-ruler mark, an optional inline label, and a line background/border — all scoped to the currently open editor via `activeEditor.setDecorations(...)`. There is no Explorer-tree badging in this codebase at all.
- **Maturity:** actively maintained, large user base, MIT-adjacent (GPLv3) license.
- **Worth borrowing:** confirms this is genuinely new ground — there's no code to port from the closest comparable extension.
- **What to avoid:** don't assume the sibling extension already solved (or attempted) Explorer-level badging; it explicitly stayed at the editor-gutter level.
- **Lift effort:** n/a (negative finding).

#### 6. `incredincomp/explorer-dates` — a shipped non-git `FileDecorationProvider` extension (existence proof only; implementation not trustworthy)
- **URL:** https://github.com/incredincomp/explorer-dates/blob/release/1.3/src/fileDateDecorationProvider.js (fetched 2026-08-25)
- **Relevance:** confirms requirement 1 is achievable and shipped on the Marketplace — this extension badges files in the Explorer by modification time (`5m`, `2h`, `3d`, `1w`) using `FileDecorationProvider`, unrelated to git.
- **Maturity:** unclear; the repository around this single feature is unusually large and complex (module-federation build tooling, a "chunk" runtime-loading system, security validators, team-config persistence, incremental indexers) for what should be a straightforward decoration provider. The actual `FileDateDecorationProvider` class in the fetched file is a thin proxy that dynamically `require()`s an implementation from one of several possible chunk paths at runtime, with multiple layered fallbacks — not a legible, directly portable reference implementation.
- **Worth borrowing:** only the existence proof (non-git `FileDecorationProvider` extensions are viable and accepted on the Marketplace).
- **What to avoid:** do not port code or architecture from this repository — the indirection and scaffolding are disproportionate to the feature and make the implementation low-trust as a design reference, independent of whether it functions correctly.
- **Lift effort:** study-only, and only for the "yes this is possible" data point.

## No prior art found

- **A tree-view panel that mixes a persisted item list with a live, dismissible "suggested" group in the same VS Code `TreeDataProvider`** — searched under all five axes above; no VS Code extension was found that combines an ephemeral/derived MRU-based suggestion list alongside a persisted, user-curated tree in one view. This is original `TreeDataProvider` design work — how a synthetic "Suggested" group participates in the same `refresh()`/`getChildren()` lifecycle as the persisted bookmark collections is not answered by any prior art found here.
- **Whether an omitted/`undefined` `color` on a bookmark `FileDecoration` actually preserves git's own folder decoration color** — searched microsoft/vscode issues and the extension API docs; issue #187756 reports the opposite behavior but with no maintainer confirmation or workaround retrieved. This needs to be verified empirically against a current VS Code build before the decoration's color treatment is finalized.

## Recommended handoff

- `project-planner` — for Explorer decoration, use `microsoft/vscode`'s `extensions/git/src/decorationProvider.ts` (`Map<uriString, FileDecoration>` + diffed `onDidChangeFileDecorations` firing, `@debounce` for expensive per-file checks) as the primary architectural reference, and design the badge text within the confirmed 2-grapheme-character limit from `extHostTypes.ts` rather than a `ThemeIcon` codicon (proposed-API-only, not shippable today per `vscode.proposed.codiconDecoration.d.ts` / issue #135591). For suggested bookmarks, there is no VS Code API to enumerate recent files (issue #136878) — the planner should design the extension's own MRU tracker; both an in-memory-only approach (wahyd4) and a persisted approach (`recent-files-obsidian`'s `pruneLength()` + `saveData()` shape, ported to `ExtensionContext.workspaceState`) appear in prior art, and choosing between them is a planning decision, not one this report makes.
- `user` — decide, before implementation, whether the color-override risk from issue #187756 is acceptable for bookmarked-and-git-modified files, or whether the badge/tooltip alone should carry all bookmark signaling and `color` should be avoided entirely on this `FileDecoration`. This can't be resolved from prior art; it needs an empirical check against the current VS Code build.

## Open questions

- Whether proposal microsoft/vscode#135591 (`FileDecoration2` / ThemeIcon badges) has stabilized into the stable `vscode.d.ts` by the time this feature is implemented — worth a quick re-check at implementation time rather than assuming today's proposed status.
- Whether an omitted (vs. explicitly `undefined`) `color` field on a returned `FileDecoration` avoids the override reported in issue #187756 — no maintainer answer was retrieved; flagged for empirical testing.
- The exact recency/coverage of `tgrosinger/recent-files-obsidian`'s current maintenance state was not verified beyond the fetched `main.ts` — it's cited only for its interaction-pattern shape, not as a maintenance-quality signal.
