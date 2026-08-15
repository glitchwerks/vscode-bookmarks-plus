## Idea

Add an optional `description` field to bookmark items/collections (schema v1→v2 migration), and mirror the extension's in-memory `BookmarkData` state to `.vscode/bookmarks.json` in the workspace with bidirectional `vscode.FileSystemWatcher` sync, so a future external MCP server can read and write bookmarks and the extension picks up external edits live.

## Requirements

1. **File contract** — the mirrored file's location and format must follow an idiomatic, documented pattern for "workspace JSON file consumed by both the extension and an external process" — not an ad-hoc choice.
2. **No feedback loop** — a technique to distinguish the extension's own writes from external writes, so `write → watcher fires → reload → write` does not loop or thrash.
3. **Lightweight schema migration** — a v1→v2 (and future vN) transform for a single local JSON blob, without pulling in a DB/ORM-style migration framework.
4. **Debounce with no existing utility** — the codebase has zero debounce code today; the candidate should show what VS Code extension authors reach for by default (raw `setTimeout`, a vendored utility, or an npm package) and the tradeoff of each.
5. Deal-breakers: heavy new dependencies (full DB engines, Electron-only packages that won't run in the extension host / web extension context), and multi-process write safety being silently assumed when the library in question explicitly disclaims it.

## Search axes used

- **Direct synonyms** — "vscode extension mirror state to JSON file", "FileSystemWatcher bidirectional sync", "debounce vscode extension"
- **Problem-shape synonyms** — "avoid file watcher feedback loop", "self-write suppression", "version-keyed JSON migration", "external tool interop file contract"
- **Adjacent domains** — note-taking app plugins with the same shared-file-with-external-process shape (Obsidian vault + MCP servers), Redux/Electron local-storage migration conventions, VS Code's own workspace config files (`tasks.json`, `launch.json`, `mcp.json`)
- **Vendor-specific phrasing** — VS Code extension API docs (`FileSystemWatcher`, MCP developer guide), VS Code core source (`src/vs/base/common/async.ts`)
- **Negative axes** — full database/ORM migration frameworks (Knex, TypeORM, node-pg-migrate) — out of scope for a single JSON blob; CRDT-based collaborative sync (Yjs) — too heavy for a single-writer-usually file; Electron-only persistence libraries — won't run reliably in the VS Code extension host

## Shortlist (ranked by expected value)

### Area 1 — Mirroring state to a workspace JSON file for external interop

#### 1. VS Code's own `.vscode/mcp.json` contract — the closest same-ecosystem precedent

- **URL:** https://code.visualstudio.com/docs/agent-customization/mcp-servers (fetched 2026-08-04)
- **Relevance:** addresses requirement 1 directly. VS Code itself ships a first-party precedent for exactly this shape: a workspace-scoped `.vscode/*.json` file that is (a) hand-editable, (b) IntelliSense/schema-backed, (c) explicitly meant to be committed to source control "to share... configurations with your team," and (d) discovered/consumed by MCP-related tooling outside the editor process itself. Since this project's stated end-consumer is a future MCP server, `.vscode/mcp.json` is direct evidence that `.vscode/<name>.json` is the idiomatic, Microsoft-sanctioned location for this exact class of file — not `bookmarks.json` at the workspace root.
- **Maturity:** actively documented, current VS Code feature (checked 2026-08-04).
- **Worth borrowing:** two things. (a) The convention itself — workspace-scoped file under `.vscode/`, documented as a semi-public contract with its own reference schema page. The docs page states directly: *"Include this file in source control to share MCP server configurations with your team"* — confirmed by direct fetch of the page (an earlier search-result snippet claimed the opposite, "typically not source controlled"; the fetched page text is the primary source and is what this citation relies on). (b) The mechanism VS Code extensions use to attach schema/IntelliSense to a custom JSON file is the `jsonValidation` contribution point (`contributes.jsonValidation` in `package.json`, mapping a `fileMatch` glob to a schema `url` — either a local file shipped in the extension or a remote URL) — confirmed via https://code.visualstudio.com/api/references/contribution-points (fetched 2026-08-04). This is plausibly the mechanism behind `mcp.json`'s IntelliSense, though the docs page itself doesn't name `jsonValidation` explicitly, so treat that specific link as unverified: inferred, not stated.
- **What to avoid:** `.vscode/mcp.json` is not itself watched bidirectionally for live external edits in the way this issue needs — it doesn't demonstrate the watcher-loop-avoidance half of the problem (see Area 2). More importantly: **committing `.vscode/mcp.json` by convention is a precedent this project should weigh carefully before copying**, because bookmarks today live in `workspaceState` — per-user, private, never committed. Mirroring to a committed `.vscode/bookmarks.json` would silently convert private, per-user bookmark data into team-shared, source-controlled data unless the file is deliberately gitignored. This is a requirement-level decision for the planner, not a detail — see body note below and the corresponding open question.
- **Lift effort:** study-only (it's a convention, not code to import).

#### 2. `tasks.json` / `launch.json` — longstanding general precedent for `.vscode/*.json` as tool-readable config

- **URL:** https://code.visualstudio.com/docs/agent-customization/mcp-servers and general VS Code docs knowledge (from training, not independently re-checked this session) — `.vscode/tasks.json` and `.vscode/launch.json` predate MCP and are the original examples of workspace JSON consumed by both VS Code and external tooling (debuggers, task runners).
- **Relevance:** reinforces requirement 1 as a second, older data point — the `.vscode/` convention is not new or MCP-specific.
- **Maturity:** unverified: long-standing VS Code core convention, not independently re-checked with a fresh fetch this session.
- **Worth borrowing:** nothing code-level; corroborating evidence only.
- **What to avoid:** n/a.
- **Lift effort:** study-only.

#### 3. Dev Container spec (`devcontainer.json`) — cross-tool JSON contract, but read-mostly not bidirectional

- **URL:** https://containers.dev/implementors/spec/ (fetched 2026-08-04) — the VS Code docs page itself (https://code.visualstudio.com/docs/devcontainers/create-dev-container, fetched 2026-08-04) only describes VS Code's own use of the file and does not itself state the multi-tool claim; the containers.dev spec page is the source for that claim, referencing a standalone CLI reference implementation (`github.com/devcontainers/cli`) and describing the spec as intended for adoption "by multiple independent implementors" beyond VS Code.
- **Relevance:** addresses requirement 1 partially. `devcontainer.json` is consumed by more than one independent tool (VS Code, the standalone `devcontainer` CLI, and per general knowledge — unverified in this session — GitHub Codespaces) from a single workspace file — a real example of a JSON file acting as a "semi-public contract" across tool boundaries. Does not address requirement 2: it's authored by humans and read by tools, not concurrently written by both an editor extension and an external live process.
- **Maturity:** actively maintained, official Microsoft spec (containers.dev).
- **Worth borrowing:** nothing code-level — the "one file, many independent readers" framing only.
- **What to avoid:** don't over-index on this as a bidirectional-write precedent; it isn't one.
- **Lift effort:** study-only.

---

### Area 2 — Avoiding the write → watcher → reload → write feedback loop

#### 1. Generic self-write-suppression technique (content comparison before reacting to a watcher event) — the dominant pattern across tools

- **URL:** https://medium.com/@impactarchitecture/file-watchers-lie-debounce-throttle-and-coalescing-in-build-loops-8d91cb29f712 (fetched 2026-08-04, content confirmed by direct fetch — not just a search snippet). This article states a single `Ctrl+S` can generate 4–12 raw filesystem events within a 20ms window, and specifically calls out that "VS Code's atomic save path alone produces a minimum of three events: CREATE (temp file), RENAME (swap to original), and WRITE (follow-up)." Its own mitigation is a 50ms debounce window that resets on each incoming event and coalesces paths into a single deduplicated batch per logical change. A concrete same-domain example of the *content-comparison* half of the pattern (not just debounce) is `thewordisbird/VaultSync`, an Obsidian sync plugin: https://github.com/thewordisbird/VaultSync (fetched 2026-08-04; 33 commits, 25 stars, 8 open issues, 0 open PRs at fetch time — a small, moderately-active project, not a heavily-vetted one) — its stated sync rule is "provider and client files with the same name and content hash are untouched; files with the same name but different content hashes sync using the most recent modification timestamp."
- **Relevance:** addresses requirement 2 directly, at the pattern level. The combined technique: **debounce/coalesce first** (a single logical save produces a burst of raw events that must be collapsed to one), **then compare content** (the watcher's job is only to signal "something changed"; the handler decides whether the change matters by comparing the file's current content, or a hash of it, against what was last read/written by this process). If they match, the event is the process's own write and is ignored; if they differ, it's an external edit and should be reloaded.
- **Maturity:** the underlying technique is old and widely used in build tools generally; the VaultSync citation specifically is a small, low-star project — treat it as one worked example, not a heavily field-tested reference.
- **Worth borrowing:** the two-stage shape — debounce/coalesce the raw watcher events first, then compare content/hash against "last content this process wrote" before deciding to reload — rather than a time-based-only heuristic ("ignore events within N ms of our own write"), which is fragile if the external process writes during that window.
- **What to avoid:** a pure debounce-only approach (no content check) will still reload on the extension's own write once the debounce timer elapses — debounce and self-write suppression solve different problems and both are needed together.
- **Lift effort:** adapt-pattern (a few lines: keep last-written string/hash in memory, compare in the watcher callback after debounce settles).

#### 2. VS Code's `FileSystemWatcher` API shape is acknowledged by Microsoft as awkward for exactly this kind of logic — constraint to design around, not a solution

- **URL:** https://github.com/Microsoft/vscode/issues/26852 (fetched 2026-08-04, content confirmed by direct fetch) — "Extension API FileSystemWatcher is a bit odd." The issue's specific, verified complaints: the `ignoreCreateEvents`/`ignoreChangeEvents`/`ignoreDeleteEvents` constructor options are read-only properties that leak an implementation detail rather than offering practical control; a watcher can be told to ignore an event type yet still be given a callback for it (or vice versa); callbacks receive only a bare `vscode.Uri` with no change-type or file-vs-directory metadata, forcing extra filesystem checks; detecting renames requires manual, non-portable workarounds. (A related PR, https://github.com/microsoft/vscode/pull/110858, was found via search and titled "Docs for FileSystemWatcher limitations" but its specific content could not be confirmed by fetch this session — treat any claim attributed to that PR specifically as unverified.)
- **Relevance:** addresses requirement 2 as a hazard, not a fix. Any self-write-suppression logic has to tolerate an API that gives coarse, occasionally ambiguous signals (bare URI, no change type) and, per the Medium citation above, fires multiple raw events for one logical save.
- **Maturity:** open, long-standing, Microsoft-acknowledged API design issue (not resolved as of this report).
- **Worth borrowing:** nothing to adopt — this is context that should shape the debounce window and the content-comparison check (the comparison must be idempotent against repeated fires for the same write, and must not assume the callback tells it what kind of change occurred).
- **What to avoid:** assuming one write = one watcher event, or that the watcher payload alone (URI only) is enough to distinguish a self-write from an external one.
- **Lift effort:** n/a (informational).

#### 3. Atomic-write-then-rename as a corruption guard, not just a loop-avoidance concern

- **URL:** https://github.com/sindresorhus/conf (readme fetched 2026-08-04) — states plainly: "Changes are written to disk atomically, so if the process crashes during a write, it will not corrupt the existing config."
- **Relevance:** addresses a sub-case of requirement 2 this project should not skip: a reader (the extension's own watcher handler, or the external MCP process) that reads mid-write can otherwise see truncated/invalid JSON. This is also *why* the Medium article's citation shows VS Code's own save path producing CREATE (temp file) + RENAME (swap in) + WRITE — the temp-file-then-rename technique is the standard way to make a write atomic from a reader's perspective, and it is also the direct cause of the multi-event bursts that the debounce/coalesce logic in item 1 has to absorb.
- **Worth borrowing:** the write-to-temp-file-then-rename technique itself, as the safe way to perform the extension's own writes to `.vscode/bookmarks.json`.
- **What to avoid:** writing the JSON blob in place with a single `fs.writeFile` — a reader (either side) can observe a partial write.
- **Lift effort:** adapt-pattern (Node's `fs` module supports this directly; no new dependency needed).

---

### Area 3 — Lightweight JSON schema versioning/migration for a single local blob

#### 1. `conf` (sindresorhus) — `migrations` option: version-keyed handler map, applied in ascending order

- **URL:** https://github.com/sindresorhus/conf (readme fetched 2026-08-04, last commit `0c66c3710fb9` 2026-07-21)
- **Relevance:** addresses requirement 3 directly as a *pattern* reference. `conf`'s `migrations` option is exactly the shape wanted: `{ 'version': store => { /* transform */ } }`, executed automatically in order when the stored `projectVersion` is behind the running one. Two caveats the README states outright and this project should weigh: (a) **"It does not support multiple processes writing to the same store"** — a direct conflict with this issue's requirement that an external MCP server and the extension both write the file; (b) the maintainer states **"I cannot provide support for this feature [migrations]. It has some known bugs. I have no plans to work on it."** (c) by default it stores config in the OS user-config directory, not the workspace — using it for a workspace-relative file means setting `cwd`, which the README explicitly discourages ("You most likely don't need this... very likely to get this wrong").
- **Maturity:** actively maintained (commit within the last month as of this report), MIT-equivalent-license npm package (unverified: exact SPDX not re-checked this session), large install base.
- **Worth borrowing:** the migration *shape* only — a plain object keyed by version string, each value a pure function that mutates/returns the next-version data, run in ascending order. This is directly reimplementable in a few lines without the dependency.
- **What to avoid:** do not adopt `conf` itself as a dependency for this feature — its multi-process caveat and default-storage-location assumptions actively work against this issue's two core requirements (external-process co-writer, workspace-relative file).
- **Lift effort:** study-only for the library; adapt-pattern for the migration shape.

#### 2. `redux-persist` `createMigrate` — same version-keyed migration shape, framework-agnostic idea

- **URL:** https://github.com/rt2zz/redux-persist/blob/master/docs/migrations.md (fetched 2026-08-04, content confirmed by direct fetch). Confirmed shape: `migrations = { 0: state => ({ ...state, device: undefined }), 1: state => ({ device: state.device }) }`, passed to `createMigrate(migrations)`, executed sequentially from `0` up to the target `version`.
- **Relevance:** addresses requirement 3. A second, independent implementation of the identical pattern (`{ [version]: (state) => newState }`, applied in ascending integer-key order, synchronous by design) — corroborates that this is the community-converged lightweight approach for local-storage-shaped migrations, not something specific to `conf`.
- **Maturity:** long-standing, widely used in the React/Redux ecosystem; not directly applicable outside Redux (has Redux-specific plumbing like `PERSIST`/`REHYDRATE` action types this project doesn't need).
- **Worth borrowing:** confirms the version-keyed-map pattern as the de facto standard; nothing else — the package itself pulls in Redux-specific concerns not relevant here.
- **What to avoid:** don't take the dependency; it doesn't compose with a non-Redux extension.
- **Lift effort:** study-only.

---

### Area 4 — Debounce idiom for VS Code extensions with no existing debounce code

#### 1. VS Code core's `Delayer` class (`src/vs/base/common/async.ts`) — the canonical debounce utility VS Code itself uses internally

- **URL:** https://github.com/microsoft/vscode/blob/main/src/vs/base/common/async.ts (fetched 2026-08-04)
- **Relevance:** addresses requirement 4. `Delayer<T>` wraps a `trigger(task, delay)` method: repeated calls cancel and reschedule the pending task, resolving only the most recent invocation once the delay elapses with no further calls — precisely the debounce semantics needed for coalescing watcher events. `ThrottledDelayer` adds throttling on top for cases where the task itself takes meaningful time (relevant if a reload also touches disk).
- **Maturity:** part of VS Code's own MIT-licensed source tree; not published as a standalone importable npm package, so using it means vendoring the ~30-line class, not adding a dependency.
- **Worth borrowing:** the `Delayer` class shape (constructor takes a default delay, `trigger()` cancels/reschedules) — it is small enough to copy directly and is a battle-tested reference implementation from the same codebase this extension targets.
- **What to avoid:** don't import `vscode`'s internal `async.ts` as a runtime dependency — it isn't a published package; treat it as a reference implementation to reproduce, not a library to pull in.
- **Lift effort:** adapt-pattern (vendor a small class).

#### 2. Hand-rolled `setTimeout`/`clearTimeout` closure — what a real, popular extension actually ships

- **URL:** https://github.com/lostintangent/gitdoc/blob/master/src/watcher.ts (fetched 2026-08-04, last commit `074fc8b60c79` 2025-08-07, MIT license per `LICENSE.txt`)
- **Relevance:** addresses requirement 4 with a live, shipped example from a VS Code/Codespaces extension maintained by a Microsoft engineer (`lostintangent`, per commit author metadata). Its `debounce(fn, delay)` helper is an 8-line closure using raw `setTimeout`/`clearTimeout`, with a `Map<Repository, () => void>` to keep one debounced function per watched entity. Notably, the package.json carries `@types/debounce` in devDependencies but the shipped code does **not** use the `debounce` npm package — it inlines the closure instead.
- **Maturity:** actively maintained (commit within the last year), MIT license, zero new runtime dependency for this specific mechanism.
- **Worth borrowing:** the exact minimal-closure shape — no dependency, no vendored class, ~8 lines — for a project that currently has zero debounce code and prefers not to add one.
- **What to avoid:** GitDoc's version has a `// TODO: Clear the timeout when GitDoc is disabled.` comment acknowledging it doesn't clean up the pending timer on extension deactivation — a leak/dangling-callback risk worth closing in a fresh implementation rather than copying verbatim.
- **Lift effort:** adapt-pattern (copy and fix the disposal gap).

#### 3. `lodash.debounce` — the "just add a dependency" option, actively discouraged by its own maintainers

- **URL:** https://www.npmjs.com/package/lodash.debounce — unverified: page returned HTTP 403 on direct fetch this session; the claims below come from a WebSearch result summary, not a confirmed fetch. https://lodash.com/per-method-packages is the (unfetched) source for the deprecation claim specifically.
- **Relevance:** addresses requirement 4 as the path *not* to prefer. It is a well-known standalone debounce package; per unverified search-result summary, Lodash's own per-method packages page states these single-method packages are discouraged and will be removed in Lodash v5, and `lodash.debounce` itself last published a version roughly a decade ago. Treat the specific "10 years" figure as unverified until independently confirmed.
- **Maturity:** stable but stagnant; large existing install base does not offset the "discouraged by maintainer" signal.
- **Worth borrowing:** nothing — listed to close off the option explicitly given the "no new heavy dependencies preferred" constraint.
- **What to avoid:** adding it when the GitDoc-style 8-line closure covers the same need with zero dependency footprint.
- **Lift effort:** n/a (not recommended).

## No prior art found

- **A VS Code extension bidirectionally mirroring workspace state to a JSON file specifically for a companion MCP server, with self-write suppression.** Searched: GitHub code search for `FileSystemWatcher` + self-write/ownership flags, Obsidian-MCP ecosystem (which is the closest adjacent domain — note-taking app + companion MCP server). What was found instead: most Obsidian↔MCP integrations (e.g. `MarkusPfundstein/mcp-obsidian`) avoid the shared-file problem entirely by having the MCP server talk to a REST API exposed by a companion Obsidian plugin (the community "Local REST API" plugin), rather than both processes reading/writing the same file on disk. That is a materially different architecture than the one specified in this issue (shared-file + watcher), and no directly matching precedent for the shared-file approach with a bookmarks-shaped payload was found. Implementer should expect the self-write-suppression logic (Area 2) to be original integration work, informed by the general pattern but not copied from an existing bookmarks/MCP-shaped example.
- **Concurrent-write safety between the extension and an external process on the same JSON file (locking / conflict resolution beyond "last write wins").** Searched: `conf` (explicitly disclaims multi-process write support), file-locking npm packages were not investigated in depth since it fell outside the four requested research areas. If the future MCP server and the extension can genuinely race to write the same file, this is unaddressed by anything found here and should get explicit design attention.
- **Two-sources-of-truth reconciliation on activation.** The extension keeps bookmark state in `workspaceState` (`Memento`) today, and this issue adds a second store — `.vscode/bookmarks.json`. None of the candidates above address the startup/reconciliation question this creates: if the external process edited the file while VS Code was closed, which store wins on the next activation — `Memento` or the file? What if both changed since the last known-good state (no shared "last synced" marker exists between the two stores)? This is not a watcher-timing problem (Area 2) — the watcher isn't running while VS Code is closed — it is a distinct reconciliation problem that none of the researched candidates model, because none of them have two independent local stores of the same data; they all have exactly one file as the source of truth. This is the actual crux of "mirror," not a peripheral detail, and should get explicit design attention from the planner rather than being assumed away by "the watcher pattern handles it."
- **The file-open-in-editor case.** `.vscode/bookmarks.json` is explicitly meant to be hand-editable (per the `.vscode/*.json` convention in Area 1), which means a user can have it open in a text editor tab when the extension writes it, and `vscode.workspace.onDidSaveTextDocument` can fire alongside — or interleaved with — the `FileSystemWatcher` callback for the same edit. This sub-case was not researched (out of scope for the four requested areas) but is an implicit consequence of choosing a hand-editable file format, and should be flagged to the planner as an unresearched interaction, not assumed to be covered by the Area 2 patterns above.

## Recommended handoff

- `project-planner` — for Area 1 (file contract) and Area 4 (debounce), the planner can treat the `.vscode/mcp.json` convention and the GitDoc-style closure debounce as directly reusable design inputs when scoping the `.vscode/bookmarks.json` mirror and the watcher-driven reload path. **Before adopting the `.vscode/` convention as-is, the planner needs an explicit decision from the user**: bookmarks today live in `workspaceState` (per-user, private, never committed); the `.vscode/mcp.json` precedent this report leans on is officially recommended to be *committed* to source control. Mirroring bookmarks into a committed `.vscode/bookmarks.json` silently changes bookmarks from private to team-shared data unless the file is deliberately `.gitignore`d — this is a scope decision, not an implementation detail.
- `project-planner` — for Area 2 (feedback-loop avoidance) and Area 3 (migration), no single drop-in exists; the planner should scope original design work guided by the corroborating patterns found (debounce/coalesce raw watcher events, then compare content/hash against last-known-write; write via temp-file-then-rename for atomicity; version-keyed migration function map applied in ascending order) rather than searching for a library to adopt.
- `project-planner` — the two-sources-of-truth reconciliation gap (Memento vs. file, resolved on activation) and the file-open-in-editor interaction (`onDidSaveTextDocument` vs. `FileSystemWatcher` firing for the same edit) are both unaddressed by any candidate found — see "No prior art found." These should be scoped as explicit design questions in the plan, not assumed to fall out of the Area 2 patterns.
- `user` — two decisions block planning: (1) should `.vscode/bookmarks.json` be committed to source control (following the `.vscode/mcp.json` precedent) given that bookmarks are currently private per-user data? (2) is the future MCP server expected to write to the file concurrently with a running VS Code instance (raising the concurrent-write race question), or only when the extension isn't running? Nothing found in this research resolves either question, and both materially change how much design weight Areas 2 and 3 need.

## Open questions

- Whether the future MCP server is expected to write to `.vscode/bookmarks.json` while VS Code is open (raising the concurrent-write question above) or only read it / write it while the extension is not running — this materially changes how much self-write-suppression and locking logic is warranted, and was not specified in the issue as scoped to this research pass.
- Whether `.vscode/bookmarks.json` should be committed to source control by default (following the `.vscode/mcp.json` precedent) or gitignored by default (preserving today's private-per-user semantics from `workspaceState`) — see the Area 1 note above.
- `.vscode/mcp.json`'s docs mention VS Code "automatically detect[ing] and reus[ing] MCP server configurations from other applications, such as Claude Desktop" — unverified how deep that cross-tool-discovery convention goes beyond MCP server definitions; not independently verified whether it extends to any general pattern for extensions publishing workspace state files for external consumption.
