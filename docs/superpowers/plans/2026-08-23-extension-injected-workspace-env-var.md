---
title: 'Issue #58 — extension-injected BOOKMARKS_PLUS_WORKSPACE terminal env var'
touches:
  - src/workspaceEnv.ts
  - src/extension.ts
  - src/test/suite/fixtures.ts
  - src/test/suite/workspaceEnv.test.ts
  - src/test/suite/extension.env.test.ts
  - src/test/suite/extension.test.ts
  - package.json
  - mcp-server/test/sentinelDrift.test.ts
  - README.md
  - CHANGELOG.md
skills_relevant:
  - test-driven-development
  - using-git-worktrees
  - pull-request-workflow
---

# Implementation plan — issue #58: inject `BOOKMARKS_PLUS_WORKSPACE` into terminals

**Issue:** #58 (`per router brief, not independently verified` — this planning session had no Bash
or GitHub MCP access, so issue state, milestone `v1.1.0`, and "#57 is merged" are taken from the
dispatching brief rather than fetched from GitHub).
**Design source:** `docs/superpowers/specs/2026-08-09-mcp-dynamic-workspace-resolution.md` § 4B
(`:L147-L330`), marked READY FOR IMPLEMENTATION.
**Server half (#57):** already shipped — `mcp-server/src/config.ts:L3-L5` declares the sentinel
literals and `resolveWorkspaceState` (`:L61-L95`) consumes them. Nothing in `mcp-server/src/`
changes in this issue.

---

## 1. What this delivers

The extension writes exactly one of three values into every integrated terminal it launches:

| Window state | `BOOKMARKS_PLUS_WORKSPACE` value | Source of the requirement |
| --- | --- | --- |
| Single folder open (mirror enabled) | the folder's absolute OS path | spec `:L238-L244`; `mcp-server/src/config.ts:L46,L56` |
| Two or more folders open | `disabled:multi-root` | spec `:L241`; `mcp-server/src/config.ts:L73-L79` |
| No folder open | `disabled:no-folder` | spec `:L242`; `mcp-server/src/config.ts:L80-L85` |

Silence (variable never set) is reserved for "this extension is not running in this window at
all" (spec `:L232`).

## 2. Verified API facts the implementation depends on

All citations are to the pinned, committed-lockfile copy of the VS Code API typings —
`package.json:L103` pins `"@types/vscode": "^1.85.0"` and `package.json:L12` declares
`"engines": { "vscode": "^1.85.0" }`, so every member below is available at the extension's
minimum supported host version.

1. `ExtensionContext.environmentVariableCollection` is a `GlobalEnvironmentVariableCollection`
   (`node_modules/@types/vscode/index.d.ts:L8479-L8483`).
2. `persistent` — "Whether the collection should be cached for the workspace and applied to the
   terminal across window reloads… **this API will return the cached version if it exists** …
   Defaults to true." (`index.d.ts:L12897-L12904`).
   - **This resolves an uncertainty the spec left open.** Spec `:L170` marked the caching claim
     `unverified:` and `:L176` asked whether the cache is keyed per workspace or globally. The
     typings say **"cached for the workspace"** — so the cross-window leak scenario at spec `:L176`
     is not reachable; the residual risk is the narrower "stale value for *this* workspace after a
     reload". D6 (`persistent = false`) is unchanged and still justified on spec `:L178`'s
     stale-is-worse-than-absent argument, which never depended on the cache's scope.
   - Because a persistent collection "will return the cached version if it exists", **set
     `persistent = false` before calling `replace()`**, not after.
3. `replace(variable, value, options?)` — "an extension can only make a single change to any one
   variable, so this will overwrite any previous calls to replace, append or prepend… when no
   options are provided this will default to `{ applyAtProcessCreation: true }`"
   (`index.d.ts:L12912-L12923`).
4. **The options trap.** `EnvironmentVariableMutatorOptions.applyAtProcessCreation` itself
   "Defaults to false" (`index.d.ts:L12859-L12863`). So passing *any* options object — e.g.
   `{ applyAtShellIntegration: true }` — silently switches **off** process-creation application,
   which is exactly the mechanism a `claude` subprocess spawned by the shell relies on. **Omit the
   options argument entirely** and leave a comment saying why; if shell-integration application is
   ever wanted, both flags must be passed explicitly.
5. Implicit activation: since VS Code 1.74 a contributed view activates its extension with no
   `onView` entry (https://code.visualstudio.com/api/references/activation-events, fetched
   2026-08-23). So `"activationEvents": []` (`package.json:L15`) is not *broken* today — the
   extension does activate when the Bookmarks view is revealed. Adding `onStartupFinished`
   ("emitted and interested extensions will be activated some time after VS Code starts up…
   will not slow down VS Code startup", same page) **adds early activation** so a terminal opened
   before the user ever touches the Bookmarks view still gets the variable (spec `:L186`).

## 3. Design decisions carried into the tasks

- **D-A — separate function, not folded into `handleWorkspaceFoldersChanged`.** That function
  early-returns on `kind === 'enabled'` (`src/extension.ts:L56-L59`) and three existing tests pin
  its return value and side-effect set (`src/test/suite/extension.test.ts:L115-L129`). A
  single-root → single-root *folder swap* is an enabled→enabled transition where the variable must
  still change. The env sync is therefore its own exported function, called from the same listener
  callback (`src/extension.ts:L151-L164`) **alongside** `handleWorkspaceFoldersChanged`.
- **D-B — write the variable early in `activate()`**, immediately after the `resolveMirrorLocation`
  call and its disabled-logging block (`src/extension.ts:L87-L91`) and before `new BookmarkStore` at
  `:L93` — well ahead of `registerAddCommands` (`:L120`). Two reasons: the
  variable should be set even if a later activation step throws, and
  `src/test/suite/extension.globalStore.test.ts:L21-L28,L46-L49` depends on the
  `command '…' already exists` collision firing *after* the behavior under test — anything wired
  in after command registration is unobservable from a fake-context test. `activate()` stays
  synchronous.
- **D-C — `uri.fsPath`, never `uri.path`.** The server does `path.resolve(workspace)` and
  `path.join(workspacePath, '.vscode', 'bookmarks.json')` with Node's `path`
  (`mcp-server/src/config.ts:L46,L56`), which needs an OS-native path.
- **D-D — duplicated literals, no import across the package boundary.** The extension declares its
  own `disabled:` / `multi-root` / `no-folder` literals; agreement with
  `mcp-server/src/config.ts:L3-L5` is enforced by a test that *reads* the extension source as text
  (spec § 4B.7a `:L246-L262`), mirroring `mcp-server/test/schemaDrift.test.ts:L30`.
- **D-E — no 4th sentinel for non-`file`-scheme workspaces.** `resolveMirrorLocation` has no scheme
  check (`src/bookmarkMirror.ts:L22-L44`), so a virtual-filesystem workspace is already unsupported
  today, independent of #58. Explicit non-goal; the server's unknown-slug fallback
  (`mcp-server/src/config.ts:L87-L91`) makes adding one later cheap.
- **D-F — already-open terminals are not retroactively updated.** VS Code applies a collection at
  terminal-process creation (`index.d.ts:L12920-L12922`); an open terminal keeps the value it was
  launched with. Accepted behavior, documented in the README — not a gap to engineer around.
- **D-G — deliberate deviation from the issue's acceptance criteria.** AC 4 allows "variable unset"
  for the no-workspace case. **The plan sets `disabled:no-folder` instead**, because an unset
  variable falls through to `CLAUDE_PROJECT_DIR` (`mcp-server/src/config.ts:L33`) and serves a
  wrong workspace — the failure spec `:L216-L232` exists to prevent. The AC's "or an equivalent
  'not applicable' sentinel" clause is the branch being taken; flagged here so a reviewer reads it
  as reconciliation, not oversight.

## 4. Open questions — answer before starting T2 (Q1 also gates T7)

None of these block T1.

- **Q1 — module name.** Plan assumes a new `src/workspaceEnv.ts` (no such file today; `src/*.ts`
  currently holds `bookmarkMirror`, `bookmarkStore`, `bookmarksTreeDataProvider`, `commands`,
  `delayer`, `extension`, `fsGitCache`, `gitInfo`, `migrations`, `normalize`, `types`,
  `workspaceFolders`). Confirm the name before starting T2 — and note it must stay settled through
  T7, not just T2: the drift test hard-codes this path independently (T7), so a rename discovered
  or made after T2 would need a matching T7 update, not just a T2 one.
- **Q2 — mutator options.** Recommendation: omit the argument (see § 2.4). Confirm you do not want
  shell-integration application.
- **Q3 — opt-out setting.** `package.json` contributes no `configuration` section today
  (`package.json:L17-L86`). Recommendation: **no** setting — a user who does not want the variable
  can disable the extension, and a toggle adds a state the drift test cannot see. Confirm.
- **Q4 — collection `description` wording.** It surfaces in VS Code's terminal-env UI
  (`index.d.ts:L12906-L12910`). Proposed: `Bookmarks Plus: workspace path for the MCP server`.
- **Q5 — clear on deactivate?** Recommendation: no explicit `clear()`; with `persistent = false`
  there is nothing cached, and VS Code invalidates the collection on uninstall
  (`index.d.ts:L12900-L12902`). `deactivate()` (`src/extension.ts:L172-L177`) stays as-is.

### Decisions locked (2026-08-23)

All five questions above are answered — the recommended default in each case, confirmed by the
user. Tasks below should treat these as settled, not as open questions to re-raise:

- **Q1 → `src/workspaceEnv.ts`.** This is the name used throughout §5's task list; no rename
  pending. T7's hard-coded path is correct as written.
- **Q2 → omit the mutator-options argument** to `replace()` (per §2.4's trap analysis). No
  shell-integration application.
- **Q3 → no `contributes.configuration` opt-out.** `package.json`'s `contributes` section is not
  touched by this issue.
- **Q4 → collection `description` = `Bookmarks Plus: workspace path for the MCP server`.**
- **Q5 → no explicit `clear()` in `deactivate()`.** Leave `src/extension.ts:L172-L177` unchanged.

## 5. Task list

Work on a worktree branch off `main` (`superpowers:using-git-worktrees`); PR body carries
`Closes #58`. Each task is one commit; T2–T7 are test-first.

### T1 — `FakeEnvironmentVariableCollection` fixture (must land first)

`src/test/suite/fixtures.ts:L62-L74` defines `FakeExtensionContext` as `{ subscriptions,
workspaceState, globalState }`. Once `activate()` touches
`context.environmentVariableCollection`, the two tests at
`src/test/suite/extension.globalStore.test.ts:L36-L85` will hit a `TypeError` that
`assertKnownActivationCollision` (`:L21-L28`) correctly re-throws — so the fixture must gain the
member **before** T4, not with it.

- Add a `FakeEnvironmentVariableCollection` implementing the members the code uses (`persistent`,
  `description`, `replace`) plus a call log recording, per call, the variable name, value, whether
  an options argument was passed, and the value of `persistent` at call time (that last field is
  what makes the ordering assertion in T3 possible).
- Add it to `FakeExtensionContext` and `createFakeExtensionContext()` (`fixtures.ts:L62-L74`).
- **Caller set verified 2026-08-23:** a grep of `src/test/` for `activate(` finds the exported
  `activate()` called with a fake context in exactly two places, both via
  `createFakeExtensionContext()` (`src/test/suite/extension.globalStore.test.ts:L46,L71`). The
  hand-rolled `{ subscriptions } as unknown as vscode.ExtensionContext` literals in
  `src/test/suite/commands.test.ts:L259,L284,L309,L334,L946,L970` go to `registerAddCommands` /
  `registerViewCommands`, never to `activate()`, so they are unaffected. The remaining
  `ext!.activate()` calls (`src/test/suite/extension.test.ts:L11,L18,L47`) go through the real
  host, which supplies a real collection. Updating the one fixture is therefore sufficient.
- **Gate:** `npm test` still green with no production change.

### T2 — pure value resolution (`resolveWorkspaceEnvValue`)

New `src/test/suite/workspaceEnv.test.ts` first, in the style of
`src/test/suite/workspaceFolders.test.ts` (synthetic folder arrays, no real workspace):

1. single folder → that folder's `fsPath`;
2. two folders → `disabled:multi-root`;
3. `undefined` → `disabled:no-folder`;
4. `[]` → `disabled:no-folder`;
5. the returned path is OS-native, not the URI `path` form — assert against `Uri.file(...).fsPath`
   rather than a hard-coded string so the test is stable on both win32 (local) and ubuntu-latest
   (CI: `.github/workflows/ci.yml:L15`);
6. the three literals are exported constants, and the disabled values are exactly
   `` `${DISABLED_PREFIX}${MULTI_ROOT_SLUG}` `` etc. (so T7's regex has a stable target).

Then `src/workspaceEnv.ts`: exported `DISABLED_PREFIX`, `MULTI_ROOT_SLUG`, `NO_FOLDER_SLUG`,
`WORKSPACE_ENV_VAR = 'BOOKMARKS_PLUS_WORKSPACE'`, and a pure
`resolveWorkspaceEnvValue(folders: readonly { uri: vscode.Uri }[] | undefined): string`. Mirror
`resolveMirrorLocation`'s branch order (`src/bookmarkMirror.ts:L25-L34`) so the two cannot disagree
about what "multi-root" means. Do **not** parse `MirrorLocation.reason` — it is an English sentence
(`src/bookmarkMirror.ts:L26,L32`), not a slug.

### T3 — applying it to a collection (`applyWorkspaceEnv`)

Tests first, in the same file:

1. `replace` called exactly once, with `WORKSPACE_ENV_VAR` and the T2 value;
2. **`replace` receives exactly two arguments** — assert on the recorded "options passed?" flag
   (see § 2.4);
3. `persistent === false` **at the moment `replace` was called** (uses T1's per-call snapshot; a
   plain post-hoc `assert.strictEqual(collection.persistent, false)` would pass even if the order
   were wrong);
4. `description` is set;
5. calling it twice with different folder sets leaves the second value in place (the
   single-mutator-per-variable rule, `index.d.ts:L12914-L12916`).

Then implement `applyWorkspaceEnv(collection, folders)` in `src/workspaceEnv.ts`, typed against a
minimal local port interface (`{ persistent: boolean; description: string | vscode.MarkdownString |
undefined; replace(v, val): void }`, matching `EnvironmentVariableCollection.description`'s real
type at `index.d.ts:L12910`) so the fake can use `description: string = ''` without an `as` cast.
Add the comment explaining why no options argument is passed.

### T4 — call it from `activate()`

New `src/test/suite/extension.env.test.ts`, reusing the known-collision pattern verbatim from
`extension.globalStore.test.ts:L21-L28`: build a fake context, call `activate()`, swallow only the
`command '…' already exists` error, then assert the fake collection recorded a `replace` for
`BOOKMARKS_PLUS_WORKSPACE`. Note the test host launches with **no** folder
(`src/test/runTest.ts:L8` passes no `launchArgs`), so the observed value will be
`disabled:no-folder` — that is a genuine end-to-end assertion of the no-folder branch, worth an
explicit comment so a future reader does not "fix" it.

Then insert the call in `src/extension.ts` immediately after `resolveMirrorLocation`
(`:L87-L91`), per D-B.

### T5 — resync on workspace-folder changes

Test the exported function directly for the enabled→enabled **swap** case (folder A → folder B
produces a different absolute path), plus enabled→multi-root and multi-root→enabled. These tests
belong in `workspaceEnv.test.ts` (the file T2/T3 already build up), not a new file.

Then, in the existing `onDidChangeWorkspaceFolders` callback (`src/extension.ts:L151-L164`), call
the env sync alongside `handleWorkspaceFoldersChanged` — not inside it (D-A). Keep the existing
`disabled` / `mirrorResources` handling untouched.

### T6 — `onStartupFinished`

Test first, following the `ext.packageJSON` inspection precedent at
`src/test/suite/extension.test.ts:L49-L50`: assert
`ext.packageJSON.activationEvents` includes `onStartupFinished`, with a comment stating *why*
(early terminal launches, spec `:L186`) — an assertion without the reason invites a future cleanup
that deletes it as redundant with implicit activation.

Then change `package.json:L15` to `"activationEvents": ["onStartupFinished"]`. Frame it in the
commit message as *adding* early activation, not fixing broken activation (§ 2.5).

### T7 — cross-package drift test (**easy to miss: it lives in `mcp-server/`, not `src/`**)

New `mcp-server/test/sentinelDrift.test.ts`, modeled on `mcp-server/test/schemaDrift.test.ts`:

- Resolve `here` via the `dirname(fileURLToPath(import.meta.url))` pattern
  (`schemaDrift.test.ts:L14`) and reach the extension source at
  `join(here, '..', '..', '..', 'src', 'workspaceEnv.ts')` — the compiled test runs from
  `mcp-server/dist/test`, so three levels up is the repo root, exactly as
  `schemaDrift.test.ts:L28-L30` documents for `schemas/`.
- **`readFileSync` only — never `import`.** That is what keeps #52's D4 intact (spec `:L250-L258`)
  and is why no `tsconfig.test.json` change is needed.
- Extract each literal with a regex and assert it equals `DISABLED_PREFIX` /
  `MULTI_ROOT_REASON_SLUG` / `NO_FOLDER_REASON_SLUG` imported from `../src/config.js`
  (`mcp-server/src/config.ts:L3-L5`). The regex must match the literal in a functional-use context —
  a property access or a quoted string-literal assignment (e.g. capturing the quoted value out of
  `export const DISABLED_PREFIX = '...'`) — not a bare substring scan; a substring scan would pass
  vacuously if the literal only appeared inside a comment.
- **Assert the regex matched at all, as its own assertion.** Text-scraping tests fail open: if the
  extension renames or reformats the constant, an unguarded `match?.[1] === undefined` comparison
  can pass vacuously. Every extraction needs an explicit "the pattern must have matched" check
  naming what to do if it fires (update the regex, or the rename is the drift being caught).
- **Also guard the variable *name*, not just the slugs.** `WORKSPACE_ENV_VAR =
  'BOOKMARKS_PLUS_WORKSPACE'` is the single most load-bearing string in the feature and it has no
  symmetric constant to compare against: the server reads it as a bare property access,
  `env.BOOKMARKS_PLUS_WORKSPACE` (`mcp-server/src/config.ts:L32,L69`). Rename it on the extension
  side and the feature silently no-ops while all three slug assertions still pass. Assert instead
  that the extension's literal appears in a property-access position in the text of
  `mcp-server/src/config.ts` — a regex anchored to `env\.BOOKMARKS_PLUS_WORKSPACE`, not a bare
  substring scan, since a bare substring scan would pass vacuously if the name only appeared in a
  comment (e.g. a "renamed from" note) — read the same cross-boundary way — `join(here, '..', '..',
  'src', 'config.ts')`, **two** levels up from `mcp-server/dist/test`, not three — with the same
  match-must-have-matched guard.
- Copy `schemaDrift.test.ts`'s habit of a comment stating the failure this guards, and state the
  known fragility the spec already concedes at `:L262`.
- Runs in CI via the existing `Test mcp-server` step (`.github/workflows/ci.yml:L42-L44`).

### T8 — README

- `README.md:L94-L96` currently says the variable is "**Not shipped yet** (tracked as issue #58);
  until it lands, nothing sets this variable and this tier is always skipped." That sentence must
  go, replaced with what the extension now guarantees (the three-value table in § 1) and the
  requirement that the extension be installed and active in the window.
- `README.md:L191-L192` says only that multi-root writes "are never picked up". After #58, a
  multi-root or no-folder window makes the server **refuse per tool call with a message**
  (`mcp-server/src/config.ts:L73-L91`) — a user-visible behavior change that is currently
  undocumented anywhere in the README (grep for `disabled` / `refus` finds only `:L13`, `:L57-58`,
  `:L104`, `:L191`). Document it here.
- Add one sentence for D-F: a terminal opened before the extension activated, or before the
  workspace folders changed, keeps its original value — reopen the terminal.

### T9 — CHANGELOG

Add to the existing `## [Unreleased]` → `### Added` list (`CHANGELOG.md:L5-L41`), matching the
neighbouring entries' voice and the `(#NN)` suffix convention used at `:L23` and `:L35`. Mention
`onStartupFinished` under `### Changed` (`:L43`) if you judge the earlier activation to be
user-visible.

### T10 — verify and open the PR

- `npm run lint && npm test` at the repo root; `npm run lint && npm test` in `mcp-server/`
  (the two are separate suites — `README.md:L212-L213`).
- Confirm the T7 drift test **fails** when you temporarily rename one extension-side literal, then
  restore. A drift test that has never been seen red is not evidence of anything.
- PR body: `Closes #58`, milestone `v1.1.0`, and an explicit note of the D-G AC deviation.

## 6. Out of scope

- Any change to `mcp-server/src/**` — the server half shipped in #57
  (`mcp-server/src/config.ts:L61-L95`).
- Scoped collections via `getScoped` (`index.d.ts:L12982-L12999`) — irrelevant while the mirror is
  single-root only (`src/bookmarkMirror.ts:L29-L34`).
- A `contributes.configuration` opt-out (Q3).
- Non-`file`-scheme workspace support (D-E).
- A terminal-echo integration test that spawns a real terminal and reads the variable back: the
  real collection is not reachable from a test because `activate()` returns `void`
  (`src/extension.ts:L85`), and shell-integration echo tests are flaky under `xvfb-run`
  (`.github/workflows/ci.yml:L32`). Fake-collection coverage inside the `@vscode/test-electron`
  host is how this repo has always satisfied "tested" for activation behavior
  (`src/test/suite/extension.globalStore.test.ts:L7-L20`).
- A test that fires the real `onDidChangeWorkspaceFolders` callback and asserts it invokes the env
  sync function. T5 tests `resolveWorkspaceEnvValue` in isolation and T4 tests only `activate()`'s
  initial call; nothing exercises the one line in the callback (`src/extension.ts:L151-L164`) that
  wires the env sync into the listener. `@vscode/test-electron` cannot programmatically fire
  `onDidChangeWorkspaceFolders` without a real workspace-folder add/remove/rename operation, and the
  test host launches with no folder and no way to add one (`src/test/runTest.ts:L8`). A future
  refactor that deletes or conditions out that wiring line would pass every existing test — a
  known, accepted coverage gap, not an oversight.
