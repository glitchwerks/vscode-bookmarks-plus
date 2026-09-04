---
title: "MCP server: session-scoped workspace resolution (issue #57)"
touches:
  - mcp-server/src/config.ts
  - mcp-server/test/config.test.ts
  - README.md
  - CHANGELOG.md
  - mcp-server/src/index.ts
  - mcp-server/src/tools/list.ts
  - mcp-server/src/tools/add.ts
  - mcp-server/test/list.test.ts
  - mcp-server/test/add.test.ts
  # Deferred to the follow-up issue in § 4B.5, not touched by #57 itself:
  # src/extension.ts, src/bookmarkMirror.ts, package.json (activationEvents)
skills_relevant:
  - test-driven-development
  - simplicity-first
---

# Session-scoped workspace resolution for the Bookmarks Plus MCP server

**Issue:** [glitchwerks/vscode-bookmarks-plus#57](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/57) — state: open (fetched 2026-08-09).

**Revision 6 — status: READY FOR IMPLEMENTATION.** All `project-reviewer` findings are closed; Rev 6 resolves the last one by naming the optional-`Config` strategy in § 4B.8. Rev 1 proposed a multi-path candidate-set design; a second user constraint disqualified it and verification of the MCP process model made the whole apparatus unnecessary. Rev 3 added an extension-owned resolution source (§ 4B); Rev 4 settled registration scope (§ 4C); Rev 5 fixed two blocking review findings with real design changes — the sentinel's **cross-boundary agreement mechanism** (§ 4B.7a) and its **delivery path** (§ 4B.8). § 12 records the full history. **Do not implement Rev 1's layered design.**

**#57 ships standalone.** Confirmed in review: tier 3 (`CLAUDE_PROJECT_DIR`) delivers the ergonomic win — a path-free registration entry — with **zero extension changes**. The follow-up issue #58 only closes the launched-from-a-subdirectory gap (R1's original failure mode) and adds the multi-root refusal. Do not treat #57 as blocked on #58 in either direction.

Task breakdown in § 13.

## 0. Citation ground rules

`mcp-server/...` line numbers are on branch **`issue-52-mcp-server`, HEAD `b2fbb3f`** (worktree `I:/apps/vscode/bookmarks/.worktrees/issue-52-mcp-server`), read 2026-08-09. That branch is unmerged; these paths do not resolve on `main`.

**Before implementation starts: commit this spec and `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md` onto the implementation branch.** Both exist only as untracked files in the `main` working tree at `I:/apps/vscode/bookmarks/docs/`. The implementer will cut a worktree off `issue-52-mcp-server`, where neither is present — every `docs/research/…:LN` citation below would silently dangle. Same artifact-persistence trap already recorded on #52.

---

## 1. The two constraints

**C1 — registration count.** Verbatim: *"We need a new approach then. This wont work. We cant have an mcp per workspace."*

**C2 — context scoping.** Verbatim: *"The other constraint is context. The goal of this is to give the claude session open in vscode access to the bookmarks in that session. If it has bookmarks from many sessions it gets flooded with context it doesnt need."*

C2 is the stronger constraint and it reshapes the problem. This is not "help the server pick the right workspace from several." It is: **the session running in VS Code workspace A must never see, and never pay tokens for, workspace B's data — not its bookmarks, not its collection names, not even its path in an error message.** Any design that retains a set of known workspaces has an enumeration surface, and any enumeration surface is a leak under C2.

C2 also narrows the target: *"the claude session open in vscode."* The primary client is Claude Code running against a VS Code workspace. See § 6 Q1.

---

## 2. The load-bearing fact: the process model (verified)

The coordinator asked whether each Claude session gets its own server process or shares one. **Verified from primary sources, not assumed.**

**(a) stdio MCP servers are client-launched subprocesses, one per client connection.**

> "In the **stdio** transport, the client launches the MCP server as a subprocess. The two ends communicate over the subprocess's standard streams"
> — MCP specification, stdio transport binding, https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio (fetched 2026-08-09)

Lifecycle is per-connection: shutdown is "closing the input stream to the child process (the server)… waiting for the server to exit," and on unexpected exit "the client **SHOULD** restart it" (same page). There is no shared-broker model — the process is born with the connection and dies with it.

**(b) Claude Code sets `CLAUDE_PROJECT_DIR` in the spawned MCP server's own environment.**

> "Claude Code sets `CLAUDE_PROJECT_DIR` in the spawned server's environment to the project root, so your server can resolve project-relative paths without depending on the working directory. This is the same directory hooks receive in their `CLAUDE_PROJECT_DIR` variable. Read it from inside your server process, for example `process.env.CLAUDE_PROJECT_DIR` in Node"
> — https://code.claude.com/docs/en/mcp § "Option 3: Add a local stdio server" (fetched 2026-08-09)

Note the second sentence: the docs explicitly instruct servers to read it from inside the process, which is exactly what we need. (A separate caveat on the same page — that `${CLAUDE_PROJECT_DIR}` needs a `:-.` default when expanded in `args`, because the variable lives in the *server's* env, not Claude Code's — does not apply to us: we read `process.env`, we do not expand it in config.)

**(c) A user-scoped registration loads in every project.**

> "| [User](https://code.claude.com/docs/en/mcp#user-scope) | All your projects | No | `~/.claude.json` |"
> — https://code.claude.com/docs/en/mcp § "MCP installation scopes" (fetched 2026-08-09)

### What (a)+(b) mean together

**This is not a "pick the right workspace from N options" problem. It is a "make one already-correctly-scoped instance easier to register" problem.**

A registration entry with **no workspace path in it at all** spawns a separate server subprocess for every Claude Code session, each already carrying that session's project root in its environment. C2 is satisfied **structurally** — the process is never told about any other workspace, so there is nothing to leak, no policy to enforce, and no code path to get wrong.

**C1 is satisfied by the entry being path-free, not by there being only one of them.** This distinction is what lets the user's Q2 answer (project scope, § 4C) coexist with C1 — fact (c) above records that user scope *could* have made it literally one entry, but that is not the property C1 actually required. What the user rejected was maintaining a *bespoke, path-bearing* entry per workspace. A byte-identical, path-free entry copied into each project is a different thing: nothing to look up, nothing to keep in sync, nothing that breaks when a folder moves.

The context-flooding risk in the current shipped design was never actually present either: it would only have appeared if we had adopted Rev 1's candidate-set model. The real defect in the shipped design is narrower than it looked — it is **registration ergonomics only**: `resolveConfig` *requires* an explicit path (`mcp-server/src/config.ts:L13-L17`), so the user must add a config entry naming each workspace, even though the client already handed the process the answer in its environment.

---

## 3. The design

Change `resolveConfig`'s source list. Nothing else.

```
workspace =
  1. argv[2]                            explicit override — lives in the registration entry
  2. env.BOOKMARKS_PLUS_WORKSPACE       NEW — injected by our own VS Code extension (§ 4B)
  3. env.CLAUDE_PROJECT_DIR             NEW — the session's own project root (§ 2b)
  4. env.BOOKMARKS_MCP_WORKSPACE        legacy override, demoted — see D1
  else → throw, as today
```

Two things about this order are deliberate, not cosmetic:

- `BOOKMARKS_MCP_WORKSPACE` drops **below** both new sources. D1 explains why the obvious order is unsafe.
- `BOOKMARKS_PLUS_WORKSPACE` sits **above** `CLAUDE_PROJECT_DIR`. D5 explains why an extension-owned signal is the more direct measurement of the quantity C2 actually names — **conditional on D6**, without which the order must be reversed.

Source 2 is inert until the extension ships its half (§ 4B.5): the server reads a variable nothing sets yet. That is the normal way to land a two-sided contract, and it means the extension change can merge later without a second `mcp-server` PR.

Everything downstream is unchanged: `path.resolve`, `mirrorPath = <workspace>/.vscode/bookmarks.json`, `verifyDelayMs` (`mcp-server/src/config.ts:L19-L31`). `Config`'s shape does not change. `createServer` does not change. Neither tool's `inputSchema` changes. Resolution stays **once, at process start** — which under § 2(a) is once per session.

Registration becomes a byte-identical, path-free entry — committed to `.mcp.json` in each project that wants it (§ 4C):

```json
{ "mcpServers": { "bookmarks-plus": {
  "command": "node",
  "args": ["${BOOKMARKS_PLUS_MCP:-C:/path/to/vscode-bookmarks-plus/mcp-server/dist}/index.js"]
} } }
```

No workspace path appears anywhere in it. The only machine-specific value is where the server itself was built, which § 4C.2 handles.

### The C2 guarantee, stated as invariants the implementation must hold

1. **A server process resolves exactly one `workspacePath`, at startup, and never changes it.** No mutable registry, no re-resolution, no per-call resolution.
2. **No tool accepts a workspace-selecting argument.** `list_bookmarks` keeps `inputSchema: {}` (`mcp-server/src/tools/list.ts:L21`); `add_bookmark` keeps its five existing fields (`mcp-server/src/tools/add.ts:L156-L162`).
3. **The process never learns of any workspace other than its own.** It reads one env var and one file path. It does not scan, glob, or enumerate directories — see § 5 D3.
4. **No error message can name another workspace,** because none is ever in scope. This is what makes the guarantee structural rather than a matter of careful message-writing.

Invariants 1-4 are all satisfied by *not adding* the machinery Rev 1 proposed. The strongest form of "no cross-workspace exposure" is a process that has no representation of a second workspace.

---

## 4. Why `CLAUDE_PROJECT_DIR` and not `roots` — a deliberate divergence from the docs and the research

The same docs paragraph that gives us (b) also says:

> "`CLAUDE_PROJECT_DIR` is the stable project root and doesn't change when you add or remove working directories mid-session. A server that limits its own filesystem access to a set of allowed directories should implement the MCP `roots/list` request instead. Claude Code answers `roots/list` with the session's launch directory plus every additional working directory you've granted with `--add-dir`, `/add-dir`, or the `additionalDirectories` setting."
> — https://code.claude.com/docs/en/mcp (fetched 2026-08-09)

The researcher ranked `roots` first partly on this sentence (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L46`). **That recommendation targets a different problem than ours, and under C2 it is the wrong primitive here.**

- The advice is addressed to *sandboxing* servers — ones that police access across *a set of allowed directories*. That is precisely the multi-directory shape C2 forbids.
- Roots is a **set**, and it grows with `--add-dir`. Under C2, a second directory entering the set is a defect, not a feature: it would either flood the session with a second workspace's bookmarks or force a disambiguation prompt that names it.
- The property the docs frame as a *limitation* of `CLAUDE_PROJECT_DIR` — "doesn't change when you add or remove working directories mid-session" — is exactly the property C2 wants. Stability is the feature.
- Cost avoided: roots would force reaching through `server.server.*` past the `McpServer` convenience API (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L40`), an `oninitialized` + notification lifecycle that cannot be tested without a live client (`:L29-L33`), and a documented Claude Code version floor of v2.1.203 after two silent-failure bugs (`:L43-L45`).

**Recommendation: do not implement roots.** Not "defer" — the ranking is reversed on the merits, for this use case, with the citation above. Recorded as D2; the user can overturn it.

---

## 4B. The extension-injected variable (user proposal, Rev 3)

Proposed verbatim: *"VSCode allows you to contribute to the environment when launching terminals and sessions. We should be able to inject it into the terminal each time it launches and then fetch it as an evironment variable."*

The mechanism is `ExtensionContext.environmentVariableCollection`. **Recommendation: adopt it, at the top of the fallback chain below the `args` override, subject to D6 — and ship it as a follow-up issue, not in #57.**

### 4B.1 Why it is more authoritative than `CLAUDE_PROJECT_DIR`

The extension does not *infer* its workspace, it *is* the workspace: the value comes from `vscode.workspace.workspaceFolders`, with no proxy step. `CLAUDE_PROJECT_DIR` is Claude Code's project root, which merely approximates "the VS Code workspace whose Bookmarks view the user is looking at" — and that approximation is precisely what Rev 2's Phase 0 probe existed to test. An extension-owned signal:

- measures the quantity C2 actually names (*"the claude session open in vscode… the bookmarks in that session"*) directly rather than by proxy;
- **decouples the feature from Claude Code's versioning and behavior entirely** — no version floor, no dependence on a vendor env var's future semantics. Rev 2 conceded "if measurement 1 is wrong, the design's foundation is wrong." Under Rev 3 a wrong measurement 1 costs a fallback tier, not the design.
- has first-party precedent: VS Code's built-in Git extension uses the same API to inject `GIT_ASKPASS`.

Not a substitute, though — a **complement**. See 4B.4.

### 4B.2 The API facts, version floor, and one fact that changes the design

Verified API chronology (re-fetched from official release notes on 2026-09-03):

- **VS Code 1.46:** `ExtensionContext.environmentVariableCollection` and `onStartupFinished` became stable. Environment-variable collections can `replace` / `append` / `prepend`, are persisted across reloads by default so an early terminal can receive the last known collection before the extension host starts, and are removed when disposed or when the extension is uninstalled. The built-in Git extension uses the same API. Source: https://code.visualstudio.com/updates/v1_46 (fetched 2026-09-03).
- **VS Code 1.80:** `EnvironmentVariableCollection.description` became stable. Source: https://code.visualstudio.com/updates/v1_80 (fetched 2026-09-03).
- **VS Code 1.82:** `GlobalEnvironmentVariableCollection.getScoped()` added workspace-folder-scoped collections, applied in addition to the global collection; the same release added `EnvironmentVariableMutatorOptions`, including `applyAtProcessCreation` and `applyAtShellIntegration`. Source: https://code.visualstudio.com/updates/v1_82 (fetched 2026-09-03).

The project declares `"engines": { "vscode": "^1.85.0" }` (`package.json:L12`), so every API used by the follow-up implementation is inside the supported floor. The implementation uses the **global** collection passed as `context.environmentVariableCollection` (`src/extension.ts:L293`, `src/extension.ts:L436`) and calls `replace()` without an options argument after setting `persistent = false` and `description` (`src/workspaceEnv.ts:L61-L75`). It does **not** call `getScoped()`, so workspace-folder scoping is part of the API chronology, not a runtime dependency of this design.

The verified default persistence behavior is a **C2 leak vector**, and it is the most important finding in this section:

> A cached "last known version" of the variable can be applied to terminals **before the extension host activates**. A `claude` session launched in that window would serve the cached workspace's bookmarks — silently, and with no enumeration surface involved. Exactly the failure C2 forbids, arriving through a caching optimization.

**How bad this is depends on the cache's scope, which the source does not state.** If the cache is keyed per workspace folder, the blast radius is only "the first-ever window on a new workspace has no cached value" — benign. If it is global, then opening window A on repo A and then window B on repo B could hand repo A's path to a terminal in window B — the full leak. Phase 0 measurement 6 settles which. D6 is the right call under either answer, so this uncertainty does not block.

**Mitigation (D6): set `persistent = false`.** No cache, no stale value. The cost is that a terminal opened in the gap before activation simply lacks the variable — and lacking it is *safe*, because resolution falls through to `CLAUDE_PROJECT_DIR`, which is correct for that session. **A stale-but-present value is strictly worse than an absent one:** absent degrades to a correct source, stale silently serves the wrong workspace.

Note the useful property: this mitigation is correct **regardless of whether the cache is global or workspace-scoped.** It costs one tier of latency in a narrow window and removes an entire class of failure, so resolving the remaining cache-scope uncertainty cannot invalidate D6.

### 4B.3 Two more implementation constraints, both non-obvious

**Use `replace()`, never `append()`/`prepend()`.** A terminal in window A that runs `code /other/repo` launches a window whose extension host inherits `BOOKMARKS_PLUS_WORKSPACE=/repo/A` from its parent process environment. `replace()` overwrites it with the correct value; `append()` would compound two workspace paths into one variable.

**The extension's activation timing is currently wrong for this.** `package.json:L15` declares `"activationEvents": []`, so activation is driven entirely by the contributed view — the extension does not run until the Bookmarks view is first revealed in that window. A terminal opened before that gets nothing. With `persistent = false` (D6) there is no cache to paper over it. **Add `onStartupFinished`** to the follow-up issue's scope: it activates the extension in every window shortly after load, without blocking startup. Cost: the extension activates in windows where the user never opens the Bookmarks view.

### 4B.4 Coverage — does it reach more session types? (coordinator Q3)

It reaches **more in one direction and fewer in another**, which is why both sources stay:

| Session | `BOOKMARKS_PLUS_WORKSPACE` | `CLAUDE_PROJECT_DIR` |
| --- | --- | --- |
| `claude` in a VS Code integrated terminal | ✅ and authoritative | ✅ but a proxy |
| `claude` in a VS Code terminal, launched from a **subdirectory** of the workspace | ✅ still the workspace root | ⚠️ likely the subdirectory — the R1 failure mode |
| `claude` in a plain terminal **outside** VS Code | ❌ never injected | ✅ works |
| Claude Code's **VS Code extension panel** (if it does not spawn through the terminal subsystem) | ❓ unknown — Phase 0 measurement 4 | ✅ expected |
| Desktop app **Code tab** | ❌ | ❓ Phase 0 measurement 3 |
| Desktop app **chat** surface | ❌ | ❌ |

The second row is the strongest argument for adopting it: it fixes R1's main failure mode outright, in the exact case the user described.

**Desktop chat remains unaddressed, unchanged.** It never spawns from a VS Code terminal, and it has no per-session project concept in the first place. § 6 Q1's recommended answer stands as written — this proposal does not change it.

### 4B.5 Scope — extension-side, and a separate issue (coordinator Q2)

**This does not violate #52's "`mcp-server` has NO dependency on `../src`" decision.** That rule is about *code* dependencies. An injected environment variable is a runtime handshake over an agreed name — architecturally the same shape as the `.vscode/bookmarks.json` mirror itself, which is already the sanctioned way these two components talk. No import crosses the boundary in either direction.

It does expand the *file* scope: activation logic and `package.json` in the extension, plus tests in the extension's `@vscode/test-electron` suite — which #52's D4 deliberately kept `mcp-server` out of.

**Recommendation: split.**

- **#57 (this spec):** `mcp-server` reads `BOOKMARKS_PLUS_WORKSPACE` at its documented precedence. Inert until the extension sets it. Still a sub-10-line change, still 57/57 tests preserved.
- **Follow-up issue (to be filed by the router — this agent cannot create issues):** the extension half. Set `BOOKMARKS_PLUS_WORKSPACE` via `context.environmentVariableCollection.replace()` with `persistent = false` (D6) and a `description`; add `onStartupFinished`; implement the sentinel contract in § 4B.7 by declaring its **own** literal for both reason slugs (never importing from `mcp-server/`); add `mcp-server/test/sentinelDrift.test.ts` per § 4B.7a to enforce agreement across the boundary; extension-side tests.

### 4B.7 Multi-root: the extension must set a sentinel, not stay silent

The tempting instruction — "in a multi-root workspace, just don't set the variable" — is wrong, and the reason is visible in the shipped code rather than inferable from the API.

`resolveMirrorLocation` **disables the mirror outright** when more than one folder is open:

> `if (folders.length > 1) { return { kind: 'disabled', reason: 'multi-root workspaces are not supported by the bookmarks mirror yet' }; }`
> — `src/bookmarkMirror.ts:L29-L34` (branch `issue-52-mcp-server`); the no-folder case at `:L25-L27` disables it too, and `src/extension.ts:L72-L75` acts on the result at activation.

So in a multi-root window **there is no `.vscode/bookmarks.json` anywhere**. If the extension merely stays silent, tier 2 is absent and resolution falls through to `CLAUDE_PROJECT_DIR`, which cheerfully reports whichever folder Claude Code launched from — routing the ambiguous case to the *less* informed source. Reads would be harmless (empty list). **Writes would not:** `add_bookmark` would create a mirror file in that folder which the extension is guaranteed never to read, because the mirror is disabled in that window. A bookmark that silently goes nowhere is worse than a refusal.

**Contract: the extension always sets the variable, to one of two things.**

- Mirror enabled → the workspace root path.
- Mirror disabled → a reserved sentinel of the form `disabled:<reason-slug>`.

Silence is reserved for "the extension isn't running here at all," which is the only case where falling through to tier 3 is correct.

This also strengthens D5: the extension variable can carry *mirror-enabled state*, which no other tier is in a position to know. Tier 3 can report a directory; only tier 2 can report that bookmarks are unavailable in this window.

**The sentinel must cover both disabled reasons, not just multi-root.** `resolveMirrorLocation` returns `kind: 'disabled'` for *two* cases — `'no workspace folder is open'` (`src/bookmarkMirror.ts:L25-L27`) and `'multi-root workspaces are not supported by the bookmarks mirror yet'` (`:L29-L34`). The chosen form is **prefix-based with a reason slug**, because it maps directly onto the `MirrorLocation` type the extension already has: `{ kind: 'disabled'; reason: string }` (`src/bookmarkMirror.ts:L10-L12`).

| Extension state | Variable value |
| --- | --- |
| `kind: 'enabled'` | absolute workspace root path |
| `kind: 'disabled'`, multi-root | `disabled:multi-root` |
| `kind: 'disabled'`, no folder open | `disabled:no-folder` |

The server matches the `disabled:` prefix, maps known slugs to specific user-facing messages, and **falls back to a generic message for an unrecognized slug** rather than treating it as a path. That forward-compatibility matters: a future extension version can add a disabled reason without the server needing to ship first.

### 4B.7a Cross-boundary agreement: duplicated literal + a drift test

Rev 4 said the extension should "import or mirror" the constant. **Both halves of that were wrong** and the review was right to block it:

- **Importing** would make the extension's `src/` depend on the standalone `mcp-server/` package. #52's D4 established "`mcp-server` has no dependency on `../src`"; § 4B.5 defended only *that* direction. Creating the reverse dependency is worse — it would drag a separate npm package into the VSIX build.
- **"Mirroring"** with no enforcement is exactly the unchecked duplicated literal that Task 3's own rationale rejects.

**This repo already has two working patterns for cross-component string agreement. Adopt pattern (a), plus the enforcement from pattern (b).** No third mechanism is invented:

- **(a) Duplicated literal, independently declared on each side.** Already in use: `MIRROR_RELATIVE_PATH = '.vscode/bookmarks.json'` is exported at `src/bookmarkMirror.ts:L5`, and `mcp-server/src/config.ts:L29` re-derives the same location as `path.join(workspacePath, '.vscode', 'bookmarks.json')` — no import crosses the boundary.
- **(b) A drift test that reads across the package boundary at test time.** Already in use: `mcp-server/test/schemaDrift.test.ts:L30` reads the authored schema at `../../../schemas/bookmarks.schema.json` and asserts agreement with `contract.ts`.

The key distinction that makes this safe: **a test reading a file across the boundary is not a source dependency.** `schemaDrift.test.ts` already reaches into the repo root without any package coupling, and D4 remains intact.

**Mechanism:** each side declares its own literal. **#58 adds `mcp-server/test/sentinelDrift.test.ts`**, modeled on `schemaDrift.test.ts`, which reads the extension's source across the boundary and asserts the two declarations agree — failing loudly on a rename from either side. It lands in #58 rather than #57 because until the extension half exists there is nothing to compare against.

Known fragility, stated rather than hidden: asserting on source text is coarser than a type-checked import. It catches the failure being guarded (a rename on one side) and not much else. That is an acceptable trade for keeping D4 intact, and it is the same trade `schemaDrift.test.ts` already makes.

### 4B.8 Delivering the refusal: connect first, refuse per-call

**A startup throw cannot deliver this message, and this is a design change, not a caveat.**

`main()` catches a `resolveConfig` failure, writes it to `console.error`, sets a non-zero exit code and returns — **before `server.connect()`** (`mcp-server/src/index.ts:L51-L63`). Two consequences make that path wrong for the sentinel:

- The message goes to stderr only, and the client "**MAY** capture, forward, or ignore the server's `stderr` output" (MCP stdio binding, fetched 2026-08-09). Delivery is not guaranteed.
- The process exits without ever connecting. Per the same binding, "If the server process exits unexpectedly, the client **SHOULD** restart it" — so the likely observable behavior is a restart loop, not an explanation.

Today's startup throw is acceptable because it fires only on **active misconfiguration** — a user who registered the server with no resolvable workspace. The sentinel is different: it fires **routinely, for a user who did nothing wrong**, merely by opening a multi-root workspace or a window with no folder. That user must actually see why bookmarks are unavailable.

**Design: detect the sentinel before the throw, connect the transport anyway, and refuse per tool call.**

```
main()
  state = resolveWorkspaceState(argv, env)
  state.kind === 'disabled' → createServer(undefined, { disabledReason }) → connect()   // still serves
  state.kind === 'ok'       → createServer(state.config) → connect()                    // unchanged
  resolveConfig throws      → existing stderr + exit path, unchanged                    // real misconfiguration
```

**Strategy (a): `Config` becomes genuinely optional through the factories, and absence *is* the disabled signal.**

```ts
createServer(config: Config | undefined, options?: { disabledReason?: string })
createListHandler(config: Config | undefined, deps: { …; disabledReason?: string })
createAddHandler (config: Config | undefined, deps: { …; disabledReason?: string })
```

Each handler opens with a single guard, and that guard is the *only* disabled check needed:

```ts
if (config === undefined) {
  return toolError(deps.disabledReason ?? 'The Bookmarks Plus mirror is unavailable in this VS Code window.');
}
// TypeScript narrows `config` to Config for the rest of the body — every existing line below is unchanged.
```

One branch does three jobs: it delivers the reason, it satisfies the type checker, and it makes the refusal unbypassable. No file is read, no directory is created.

**Why (a) over a synthesized placeholder `Config`.** The alternative — keeping the type non-optional by passing `{ workspacePath: '', mirrorPath: '', verifyDelayMs: 0 }` with a "never read this" comment — is more attractive on paper and considerably worse in failure. Compare what each does **if a future edit drops the guard**:

- **(a)** `config.mirrorPath` on a possibly-`undefined` value is a **compile error**. The mistake cannot ship.
- **(b)** `mirrorPath: ''` flows straight into the existing code. `readMirror('')` throws `ENOENT` → returns `undefined` → `list_bookmarks` reports an **empty but successful** workspace. Worse, `writeMirrorAtomic('')` takes `dirname('') === '.'`, calls `mkdir('.', { recursive: true })`, and writes `bookmarks.json` **into the server's current working directory** — resurrecting exactly the directory-pollution failure R2 records as designed-out.

An invariant enforced by the type system beats one enforced by a comment, and here the comment-enforced version degrades into a silent wrong answer plus a stray file write. The reviewer's instinct was right.

**Correction to Rev 5's framing.** Rev 5 said this piece was zero-churn; that was wrong and is withdrawn. Accurately:

- **No existing test is modified.** Passing a `Config` to a `Config | undefined` parameter is valid TypeScript, so every fixture literal in `index.test.ts`, `list.test.ts`, and `add.test.ts` still compiles, and `index.test.ts:L50`'s one-argument `createServer(config)` call still compiles against the new optional second parameter.
- **Two source files do change** beyond the new tier logic: `tools/list.ts` and `tools/add.ts` each gain the four-line guard above. That is a small, contained ripple — not zero, and it needs no apology.

`resolveConfig(argv, env)` itself keeps its exact signature, return type, and throwing behavior, so its 10 existing cases are untouched. A discriminated-union return on `resolveConfig` was rejected on purpose: it would force every existing test that reads `config.workspacePath` to narrow first, converting a contained ripple into a suite-wide edit.

Splitting keeps #57 shippable today, lets the extension change land on its own schedule, and avoids a second `mcp-server` PR to add the variable later.

### 4B.6 Degradation (coordinator Q4)

`args` → `BOOKMARKS_PLUS_WORKSPACE` → `CLAUDE_PROJECT_DIR` → `BOOKMARKS_MCP_WORKSPACE` → throw.

- **In VS Code, extension shipped:** tier 2 wins. Authoritative.
- **In VS Code, before the extension half ships:** tier 2 absent, tier 3 wins. Identical to Rev 2 behavior — no regression during the split.
- **Plain terminal outside VS Code:** tier 2 absent, tier 3 wins. Correct.
- **Neither, e.g. another MCP client:** tier 4 or the explicit `args` path, exactly as today.
- **VS Code terminal opened in the pre-activation gap:** tier 2 absent, tier 3 wins. Safe — this is the D6 fail-open property.

Every tier's absence degrades to a *correct* source rather than a wrong one. The only ordering that breaks this is a persistent (cached) tier 2, which D6 removes.

---

## 4C. Registration scope: project, per the user (Rev 4)

User's answer, verbatim: *"Should be project scoped since it may only be opened in certain projects."* This **overrides** the Rev 2/3 recommendation of user scope. It is a registration and documentation decision only — it changes nothing in the resolution chain, the precedence order, `persistent = false`, or the sentinel contract.

The reasoning is sound and worth recording rather than merely complying with: user scope makes the server available in *every* project on the machine, including the majority that have no bookmarks. Opt-in beats opt-out for a feature that is only sometimes wanted.

### 4C.1 Does project scope reintroduce C1?

**No — and the reason is the § 2 distinction, not a technicality.** What C1 rejected was *"an mcp per workspace"* where each entry hardcoded that workspace's absolute path, so every new project meant looking up a path and writing a bespoke entry. Under this design the entry is **byte-identical everywhere and contains no workspace path**. Adding a project is a file copy (or `claude mcp add --scope project`), and it can be committed so anyone who clones the repo gets it automatically. The maintenance burden C1 objected to — per-workspace values to author and keep correct — is gone regardless of scope.

The honest residual cost: the user still performs a per-project action once. That is real friction and it is the price of opt-in. It is not the friction C1 named.

### 4C.2 The committed-`.mcp.json` wrinkle, and its fix

`.mcp.json` is designed to be committed and shared, but our entry needs an absolute path to a locally-built `mcp-server/dist/index.js`, which differs per machine. Documented solution:

> "Claude Code supports environment variable expansion in `.mcp.json` files, allowing teams to share configurations while maintaining flexibility for machine-specific paths… `${VAR:-default}`: expands to `VAR` if set, otherwise uses `default`… Environment variables can be expanded in: `command`… `args`"
> — https://code.claude.com/docs/en/mcp § "Environment variable expansion in `.mcp.json`" (fetched 2026-08-09)

So § 3's entry stays portable: each developer sets `BOOKMARKS_PLUS_MCP` once per machine, and the `:-default` keeps the file loadable without it. If a missing variable has no default, "the config still loads: Claude Code reports a missing-variable warning for that server in `claude mcp list`" (same page) — a legible failure, not a silent one.

The README should offer both paths: commit `.mcp.json` with expansion (team/multi-machine), or `claude mcp add --scope project` for a quick local-only entry.

### 4C.3 Two consequences of project scope the README must state

**Approval prompt.** "For security reasons, Claude Code prompts for approval in interactive sessions before using project-scoped servers from `.mcp.json` files. To reset those approval choices, run `claude mcp reset-project-choices`" (https://code.claude.com/docs/en/mcp § Project scope, fetched 2026-08-09). First use in each project requires an approval click. User-scope entries would not have. Worth one line so it does not read as a bug.

**Do not define the same server name at both scopes.** Q1 puts the Desktop **Code tab** in the target set, and there the precedence inverts: "When the top level of `~/.claude.json` (user scope) and `.mcp.json` define the same stdio server name, the Code tab uses the `~/.claude.json` definition, departing from the CLI [scope hierarchy]" (https://code.claude.com/docs/en/desktop § "MCP servers from the Claude Desktop chat app", fetched 2026-08-09). A user who experiments with user scope, then switches to project scope without removing the old entry, gets **different servers in the CLI and the Code tab** — a genuinely confusing failure. README should say: pick one scope, and remove the other entry if you switch.

---

## 5. Decision points

### D1 — Precedence order. **Recommend: `argv[2]` > `CLAUDE_PROJECT_DIR` > `BOOKMARKS_MCP_WORKSPACE`. Status: this one matters — the intuitive order breaks C2.**

The obvious order — both explicit sources above the new one — has a hole. `BOOKMARKS_MCP_WORKSPACE` is a plain environment variable, and a spawned subprocess inherits the user's shell environment. The current README actively instructs users to set it (`README.md:L71`, `:L109`). A user who exported it once — in a shell profile, or as a leftover from the pre-#57 single-workspace setup — would have **every session in every workspace silently resolve to that one pinned path**. That is exactly the cross-workspace serving C2 forbids, delivered by the precedence rule rather than by an enumeration surface. § 3's invariants 1-4 do not catch it: they constrain what the process *learns*, and this is about what it *resolves to*.

The symmetric problem, so this is not flipped blindly: putting `CLAUDE_PROJECT_DIR` above the env var means a user who deliberately sets `BOOKMARKS_MCP_WORKSPACE` inside an `mcpServers` entry's `env` block gets it ignored under Claude Code. **From inside the process, "set in the registration entry" and "inherited from the shell" are indistinguishable** — there is no way to honor one and reject the other.

Resolution: make the **`args` positional the sole documented explicit override.** It lives in the registration entry, is unambiguous about intent, and cannot be inherited. `CLAUDE_PROJECT_DIR` second. `BOOKMARKS_MCP_WORKSPACE` third, retained for backward compatibility and documented as legacy/last-resort with an explicit warning that a shell-exported value will pin every session that has no `args` path and no project dir.

Cost of this order against the existing suite: **zero.** Verified test-by-test — every `config.test.ts` case passes an explicit `env` object literal rather than `process.env`, so no test can inherit an ambient `CLAUDE_PROJECT_DIR`, and the two order-sensitive cases both omit it: `:L14-L26` (argv wins over the env var) and `:L28-L34` (env var used when no positional). Both still pass under the new order.

### D2 — Implement MCP `roots`? **Recommend: no. Status: recommended, see § 4. User may overturn.**

### D3 — When the resolved directory has no `.vscode/bookmarks.json`, do we search for one? **Recommend: no, never. Status: firm.**

Today the mirror's absence is already handled correctly and needs no new code: `readMirror` returns `undefined` on `ENOENT` (`mcp-server/src/mirrorFile.ts:L9-L12`), `list_bookmarks` reports an empty workspace, and `add_bookmark` creates the file. Bootstrapping works.

Searching parent or child directories for a mirror would be a C2 violation with a friendly face: to search is to discover other workspaces, and whatever is discovered can end up in a message. If a user launches Claude Code from a directory that is not the workspace root, the correct outcome is an empty list plus a `mirrorPath` in the payload (`mcp-server/src/tools/list.ts:L34-L35`) showing exactly where the server looked — self-diagnosing, and it names only the current session's own path.

### D5 — Does `BOOKMARKS_PLUS_WORKSPACE` outrank `CLAUDE_PROJECT_DIR`? **Recommend: yes, conditional on D6. Status: recommended.**

Rationale in § 4B.1: the extension knows its workspace definitionally rather than by proxy, it fixes R1's launched-from-a-subdirectory failure, and it removes the design's dependence on a vendor env var's semantics.

**The conditional is not decorative.** If D6 is rejected and the collection stays persistent, a cached stale value can outrank a live correct one (§ 4B.2) — in that case this order must be **reversed**, because `CLAUDE_PROJECT_DIR` is always live. Adopt D5 and D6 together or neither.

Known tradeoff, documented rather than solved: in a VS Code terminal where the user `cd`s into a *different* repo and runs `claude` there, tier 2 reports the window's workspace while tier 3 reports the other repo. C2's wording — the bookmarks of "the claude session open in vscode" — favors the window's workspace, and the `args` override covers anyone who disagrees.

### D6 — `persistent` on the environment variable collection. **Recommend: `false`. Status: recommended; gates D5.**

§ 4B.2. A stale-but-present value is strictly worse than an absent one, because absent falls through to a correct source while stale silently serves another workspace's bookmarks.

### D4 — Keep the hard startup failure when nothing resolves? **Recommend: yes, unchanged.** (`mcp-server/src/config.ts:L15-L17`, surfaced by `main()`'s catch at `mcp-server/src/index.ts:L52-L59`.) The message needs updating to mention the new source, per § 8.

---

## 6. Questions — both resolved (Rev 4)

**Q1 — target clients. ANSWERED, as recommended.** Verbatim: *"Yes, vscode launched is whole target."* VS Code-launched Claude Code — Code tab and integrated-terminal CLI sessions — is the whole target. **The Desktop chat surface is a documented limitation, not a gap to close**, since it has no per-session project concept by construction. This retires the unresolved Claude Desktop roots question at `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L61` permanently.

**Q2 — registration scope. ANSWERED, against the recommendation: project scope.** Verbatim: *"Should be project scoped since it may only be opened in certain projects."* Fully treated in § 4C. No technical design change.

Supporting detail for Q1, retained because the README's limitation wording depends on it: Desktop loads `claude_desktop_config.json` servers "into local Code tab sessions," and such a server "is available in both the Desktop chat surface and local Code tab sessions" (https://code.claude.com/docs/en/desktop § "MCP servers from the Claude Desktop chat app", fetched 2026-08-09). The **Code tab** is a Claude Code session and so is expected to inherit § 2(b) — an **inference**, not a quotation, and the only one in the design; Phase 0 measurement 3 tests it directly. The **chat** surface has no documented project root or roots support either way, and needs none: it is now explicitly out of target.

---

## 7. Risks

**R1 — `CLAUDE_PROJECT_DIR` may not equal the VS Code workspace folder.** It is Claude Code's project root, and the two desync when a session is launched from a subdirectory, a parent directory, or a different checkout than the folder VS Code has open (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L47`). Mitigations, in order: the Phase 0 probe measures the common case before we commit (§ 8); the explicit override (D1) covers the rest; and D3's failure mode is a visibly empty list naming the path searched, not silent wrong data. **This risk is inherent to any client-side mechanism** — roots has it too, and worse, since roots also carries `--add-dir` noise.

**R2 — Rev 1's directory-pollution risk is gone.** It existed only because a model-supplied path would flow into `writeMirrorAtomic`'s `mkdir(dirname, { recursive: true })` (`mcp-server/src/mirrorFile.ts:L16-L18`). With no workspace argument on any tool (invariant 2), the only paths that ever reach that call come from the process's own startup environment. Recorded so a future reviewer sees it was considered and designed out, not overlooked.

**R3 — Docs describe the retired model.** `README.md:L50-L127` documents one-registration-per-workspace as current behavior, including per-workspace `args` entries (`:L83`, `:L100`) and the argv-wins-over-env rule (`:L71`). The precedence rule stays true under D1; the per-workspace framing does not.

**R6 — A cached extension-injected variable could serve the wrong workspace.** § 4B.2, the one genuinely new risk Rev 3 introduces. Removed by D6 (`persistent = false`), which is why D5 and D6 are adopted as a pair.

**R4 — Multi-root VS Code workspaces have no mirror at all, and the resolution chain must not paper over that.** Verified rather than assumed: `resolveMirrorLocation` returns `kind: 'disabled'` for `folders.length > 1` (`src/bookmarkMirror.ts:L29-L34`), so no `.vscode/bookmarks.json` exists in such a window. Reads degrade harmlessly to an empty list, but `add_bookmark` would happily *create* a mirror the extension will never read. § 4B.7's sentinel contract turns that into a named refusal. Widening multi-root support belongs to a mirror-design issue, not this one.

**R5 — Other MCP clients set no `CLAUDE_PROJECT_DIR`.** Cline, Continue, VS Code's own native MCP client, etc. all fall through to the explicit override and behave exactly as they do today. No regression; just no improvement. (VS Code's native client has its own idiom — `.vscode/mcp.json` with `${workspaceFolder}` — deliberately out of scope per the research's negative axis, `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L19`.)

---

## 8. Implementation

**Phase 0 — the probe (do this first; it is ~15 minutes and it gates the rest).**

Add a temporary probe in `main()` that **appends `process.env.CLAUDE_PROJECT_DIR` and `process.cwd()` to a known file** (e.g. `os.tmpdir()/bookmarks-mcp-probe.log`). Two placement rules, both load-bearing:

- **Write to a file, not stderr.** The stdio binding permits stderr logging but guarantees nothing about delivery: "The client **MAY** capture, forward, or ignore the server's `stderr` output" (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio, fetched 2026-08-09). A file is independent of client behavior.
- **Place it before the `resolveConfig` call**, not after. With no `args` path and the fallback not yet implemented, `resolveConfig` throws and `main()` exits at `mcp-server/src/index.ts:L52-L59` — a probe placed after it would never run.

Build, register the server with no `args` path, then take **five** measurements and record all of them in the PR body:

1. Claude Code in a **VS Code integrated terminal** on this repo — does `CLAUDE_PROJECT_DIR` equal the VS Code workspace folder? (R1.)
2. Claude Code from a **plain terminal outside VS Code**, for comparison.
3. A **Desktop app Code tab** session — measures the § 6 Q1 inference (that a Code tab session is a Claude Code session and inherits § 2(b)) rather than leaving it asserted.
4. Claude Code's **VS Code extension panel**, if the user runs sessions that way — does the panel spawn through the terminal subsystem? This determines whether § 4B's injection reaches that surface (§ 4B.4, row 4). Probing it now is nearly free; discovering it after the extension work ships is not.
5. Claude Code launched from a VS Code terminal **`cd`'d into a subdirectory** of the workspace — this is R1's main failure mode and § 4B.1's strongest argument. If `CLAUDE_PROJECT_DIR` reports the subdirectory here, that is the concrete evidence for D5.

6. **Cache-scope check, once the extension half exists** (§ 4B.2): open window A on repo A, let the extension activate, then open window B on repo B and read the probe file for a terminal created *before* B's Bookmarks view is revealed. If it records repo A's path, the persistence cache is global and R6 is the full leak; if it records nothing, the cache is per-workspace and R6 is benign. Either way `persistent = false` stays.

**This probe is not a design gate, but it *is* a correctness gate on tier 3 — do not let the first framing obscure the second.** No decision in this spec changes based on the outcome. But tier 3 is the only automatic source #57 ships (tier 2 arrives with #58), so if it does not resolve correctly in VS Code sessions, **#57 delivers zero ergonomic improvement until #58 lands** — the user would still have to put a path in every registration entry, which is the state C1 rejected.

**Stop condition:** if measurements 1 **and** 5 both disappoint — `CLAUDE_PROJECT_DIR` absent, or pointing somewhere other than the workspace root, in ordinary VS Code sessions — **halt and return to the router.** Do not ship a tier that does not work and rely on #58 to rescue it. That outcome would mean #57's value depends entirely on #58, which changes the issue's sequencing and is a decision for the user, not the implementer.

**Phase 1 — the change itself.**
1. `mcp-server/src/config.ts`: insert `env.BOOKMARKS_PLUS_WORKSPACE` then `env.CLAUDE_PROJECT_DIR` between the positional and the legacy env var (`:L13`), per § 3's order. Signature, return type, and all downstream derivation unchanged.
2. Update the startup error text (`:L16`) to name all four sources, and to say that the VS Code extension and Claude Code supply tiers 2 and 3 automatically.
3. `mcp-server/test/config.test.ts`: **add** tests — each tier used when the ones above it are absent; the `args` positional outranks all; `BOOKMARKS_PLUS_WORKSPACE` outranks `CLAUDE_PROJECT_DIR` (D5 guard); **`CLAUDE_PROJECT_DIR` outranks `BOOKMARKS_MCP_WORKSPACE`** (the D1 guard — the test that would catch a well-meaning future reorder reintroducing the shell-inheritance hole); relative values resolved to absolute; still throws when all four are absent. Change no existing test (§ 10).
4. `README.md`: rewrite the MCP section (R3) around a **project-scoped, path-free** entry (§ 4C), covering: the `${VAR:-default}` expansion for the build path (§ 4C.2), the first-use approval prompt (§ 4C.3), the do-not-define-at-both-scopes warning (§ 4C.3), the `args` explicit override, the Desktop-chat limitation (Q1), and a warning that a shell-exported `BOOKMARKS_MCP_WORKSPACE` pins every otherwise-unresolved session (D1). Drop all "one entry covers every project" framing.
5. `CHANGELOG.md`: note that the workspace path is now optional under Claude Code.

Test-first per the repo standard: the four new `config.test.ts` cases before the `config.ts` edit.

**Follow-up issue — the extension half (§ 4B.5).** For the router to file; this agent cannot create issues. Scope: `context.environmentVariableCollection.replace('BOOKMARKS_PLUS_WORKSPACE', <workspace root>)` with `persistent = false` (D6) and a user-visible `description`; add `onStartupFinished` to `package.json:L15`'s empty `activationEvents` (§ 4B.3); per the § 4B.7 sentinel contract, set the variable to `disabled:multi-root` when a multi-root window is open and `disabled:no-folder` when no workspace folder is open, rather than declining to set it at all (R4); extension-side tests. Blocked on nothing in #57 — the two halves meet only at the variable name.

**Not in this issue:** roots (D2), the extension half (above), any multi-workspace capability, any tool-schema change.

---

## 9. Alternatives considered and rejected

**A1 — Rev 1's multi-path candidate set + per-call `workspacePath` selector.** **Disqualified by C2.** Disambiguating between candidates requires telling the model what the candidates are; enumerating other workspaces' paths in a tool error is precisely the cross-session context bleed C2 forbids, and it scales with the number of registered workspaces. It also solved a problem that § 2 shows does not exist: the client already scopes each process.

**A2 — MCP `roots`.** § 4. Wrong primitive for a single-workspace requirement; costs a client version floor, an untestable lifecycle, and an escape from the convenience API.

**A3 — A launcher/wrapper script that derives the workspace from VS Code's environment.** Unnecessary: § 2(b) shows Claude Code already passes the project root into the server's environment directly, so a wrapper would only re-read what `process.env` already has. It would also add a second executable to install and to keep in sync with the server.

**A4 — Extension-published workspace registry** (`~/.bookmarks-plus/workspaces.json`). Rev 1 floated this for the Desktop-dynamic case. **Now actively undesirable**: a machine-wide list of every bookmarks workspace is the exact enumeration surface C2 argues against, plus a staleness problem and scope expansion into the extension.

**A5 — Aggregate reads across workspaces.** Directly contrary to C2. Dropped without qualification.

---

## 10. Test impact — revised

**The completion criterion is "no existing test was modified" — not a preserved-test count.** Counts drift as tasks add cases (Tasks 2 and 3 add roughly seven to `config.test.ts` alone, plus cases in `list.test.ts` and `add.test.ts`), and a count invites the wrong reconciliation when it does. The invariant that matters: `git diff mcp-server/test/` shows **additions and comments only**. Rev 1's estimate (21 untouched, ~25 fixture-edited, 3 relocated, 1 rewritten, 3 replaced) is superseded — no existing test needs to change at all.

The table below therefore describes *why* each file's existing cases survive, not how many will exist afterward.

Because `resolveConfig`'s signature, return type, and `Config`'s shape are unchanged, and no tool schema or handler changes:

| File | Tests | Disposition |
| --- | --- | --- |
| `contract.test.ts` | 10 | Untouched |
| `mirrorFile.test.ts` | 7 | Untouched |
| `schemaDrift.test.ts` | 4 | Untouched (verified by reading: asserts only authored-schema vs `contract.ts`'s `MAX_SUPPORTED_VERSION` and fixtures) |
| `add.test.ts` | 17 | Untouched — no fixture-helper change is needed now |
| `list.test.ts` | 8 | Untouched — including `:L279-L281`, which pins `Object.keys(inputSchema)` as `[]`. Rev 1 called this a deliberate break; under invariant 2 it stays green and becomes a **regression guard** for C2: if a future change adds a workspace argument to `list_bookmarks`, this test fails and should be read as C2 being violated. Worth a comment saying so. |
| `index.test.ts` | 1 | Untouched — `createServer` stays synchronous and I/O-free, which Rev 1 had to engineer for and Rev 2 gets for free |
| `config.test.ts` | 10 | No existing case modified; Tasks 2-3 **add** to this file. `resolveConfig` keeps its signature, return type, and throwing behavior — the sentinel logic lands in the new `resolveWorkspaceState` (§ 4B.8). The throw-when-nothing-present case (`:L36-L41`) still passes: it calls `resolveConfig(argvWith(), {})` with an empty env literal, so no `CLAUDE_PROJECT_DIR` is present. Verified by reading the test. |

**Net: no existing test modified; new cases added by Tasks 2, 3, and 4.** If an implementation of this spec modifies an existing test, that is a signal it has drifted from the design — treat it as a review finding, not a cleanup.

---

## 11. Open questions and unverified claims

- **`unverified:` whether `CLAUDE_PROJECT_DIR` equals the VS Code workspace folder for a session started inside VS Code.** The single load-bearing empirical unknown. Phase 0 measurement 1 settles it; nothing else in the design is asserted on top of it.
- **`unverified:` whether that persistence cache is global or per-workspace-folder.** Determines whether R6 is a real leak or a benign first-run gap. Phase 0 measurement 6.
- **`unverified:` whether Claude Code's VS Code extension panel spawns through the terminal subsystem**, i.e. whether § 4B's injection reaches it. Phase 0 measurement 4.
- **`unverified:` that a Desktop app Code tab session inherits § 2(b)'s `CLAUDE_PROJECT_DIR` behavior.** Inferred from the Code tab being a Claude Code session, not quoted from any source. Phase 0 measurement 3 settles it. Only the Q1 scope answer depends on it, not the design.
- **`unverified:` `anthropics/claude-code#75266`** (desktop-app-spawned MCP servers getting `cwd` = `$HOME`) was never fetched directly (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L73`). It does not matter here: this design reads an explicit env var and never trusts inherited `cwd`.
- **Claude Code v2.1.203's release date** — needed only for a roots version floor (`:L72`). Moot under D2.
- **Issue #57's body** was read via `WebFetch` summarisation; this planning agent has neither `Bash` nor `mcp__github__*`. Both user constraints in § 1 are quoted from the dispatch briefs, which quote the user directly.
- **No issues or milestones were created** (same tooling limitation). Follow-ups are returned to the router as prose.

---

## 13. Task breakdown

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to work this task-by-task. Test-first throughout: within each task, the test step precedes the source step.

All paths are relative to the repo root on the implementation branch. `mcp-server`'s verification command is `npm test` from `mcp-server/`, which runs `tsc && node scripts/copy-schema.mjs && node --test dist/test` (the sequence `mcp-server/test/schemaDrift.test.ts:L49-L57` documents and depends on). Baseline before any change: **57 passing.**

### Task 0 — Land the artifacts on the branch

- [ ] Copy `docs/superpowers/specs/2026-08-09-mcp-dynamic-workspace-resolution.md` and `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md` from the `main` working tree onto the implementation branch and commit them (§ 0). Without this, every `docs/research/…:LN` citation in this spec dangles.
- [ ] Confirm `npm test` in `mcp-server/` is green at 57 before touching anything. A redesign that starts from an unverified baseline cannot prove it preserved one.

### Task 1 — Phase 0 probe (evidence, not a gate)

- [ ] Add a temporary probe in `mcp-server/src/index.ts` `main()` that appends `process.env.CLAUDE_PROJECT_DIR`, `process.env.BOOKMARKS_PLUS_WORKSPACE`, and `process.cwd()` to a file under `os.tmpdir()`. **Place it above the `resolveConfig` call** (`:L52-L59`) — after it, the throw prevents it from ever running. **Write to a file, not stderr** (§ 8).
- [ ] Register the server project-scoped with no workspace in `args`; take measurements 1-5 from § 8 (VS Code integrated terminal; plain terminal; Desktop Code tab; Claude Code VS Code panel; VS Code terminal `cd`'d into a subdirectory).
- [ ] Record all results in the PR body. Measurement 5 is the evidence for D5; measurement 4 tells the follow-up issue whether injection reaches the panel.
- [ ] Remove the probe before the PR is marked ready.

### Task 2 — `resolveConfig` precedence (the whole server-side change)

- [ ] `mcp-server/test/config.test.ts`: **add** cases (change no existing case) — `BOOKMARKS_PLUS_WORKSPACE` used when `argv[2]` is absent; `argv[2]` outranks it; **`BOOKMARKS_PLUS_WORKSPACE` outranks `CLAUDE_PROJECT_DIR`** (D5 guard); **`CLAUDE_PROJECT_DIR` outranks `BOOKMARKS_MCP_WORKSPACE`** (D1 guard — the shell-inheritance hole); relative values in both new sources resolved to absolute; still throws when all four are absent.
- [ ] Run `npm test`; confirm the new cases fail for the right reason and all 57 originals still pass.
- [ ] `mcp-server/src/config.ts:L13`: insert the two new sources in § 3's order. Do not change the signature, the return type, or `Config`'s shape.
- [ ] `mcp-server/src/config.ts:L16`: update the error text to name all four sources.
- [ ] `npm test` green: 57 + new.

### Task 3 — The sentinel: detection, refusal, delivery (§ 4B.7, § 4B.8)

> **Task 3 must merge together with Task 2 — never as a follow-on commit.** Task 2's `??`-chain reads like a simple extension, and its tests pass without any sentinel handling. An implementer who stops there ships a chain that treats `disabled:multi-root` as a **relative path**, resolves it against `process.cwd()`, and lets `add_bookmark` create a mirror file in a bogus directory — precisely the silent-wrong-write § 4B.7 exists to prevent. **Do not mark Task 2 done until Task 3's checks are in place.**

- [ ] Define the sentinel prefix and reason slugs as **exported constants** in `mcp-server/src/config.ts` — e.g. `export const DISABLED_PREFIX = 'disabled:';` with known slugs `multi-root` and `no-folder` (§ 4B.7). Declared independently here; **never imported from `src/`, and never imported *by* `src/`** (§ 4B.7a).
- [ ] Add `resolveWorkspaceState(argv, env)` to `mcp-server/src/config.ts` per § 4B.8: returns a disabled state when the tier-2 value carries the prefix, otherwise delegates to `resolveConfig` unchanged. **Do not modify `resolveConfig`'s signature, return type, or throwing behavior.**
- [ ] `mcp-server/test/config.test.ts`: cases for `resolveWorkspaceState` — each known slug yields a disabled state with a reason; an **unknown** slug yields a disabled state with a generic reason rather than being treated as a path (forward compatibility, § 4B.7); a normal path yields the same `Config` `resolveConfig` would.
- [ ] `mcp-server/src/index.ts`: on a disabled state, **still connect the transport** and call `createServer(undefined, { disabledReason })` — the config argument becomes `Config | undefined` and the second parameter is new and optional (§ 4B.8, strategy (a)). Leave the existing throw/stderr/exit path at `:L52-L59` untouched for genuine misconfiguration.
- [ ] `mcp-server/src/tools/list.ts` and `add.ts`: widen the first parameter to `Config | undefined`, add `disabledReason?: string` to the existing `deps` object, and open each handler with the **single** guard from § 4B.8 — `if (config === undefined) return toolError(deps.disabledReason ?? <generic>)`. TypeScript narrows `config` for every line below it, so no other line in either handler changes.
- [ ] **Do not** synthesize a placeholder `Config` with empty-string paths as a way to keep the type non-optional. § 4B.8 records why: a dropped guard becomes a silent empty result plus a stray `bookmarks.json` written into the server's cwd, instead of a compile error.
- [ ] `mcp-server/test/list.test.ts` and `add.test.ts`: **add** cases asserting each tool returns `isError` with a legible reason when disabled, and — critically — that **no file is read and no directory is created**. Change no existing case.
- [ ] Messages should echo the extension's own wording where it exists: `src/bookmarkMirror.ts:L26` and `:L32`.
- [ ] **Deliberate asymmetry, recorded here so it is not mistaken for an oversight:** until #58 ships, these checks guard a value nothing produces (§ 3, "inert until the extension ships its half"), and the two halves' agreement on the strings is **not** covered by any test in this repo. #58 closes that with `sentinelDrift.test.ts` (§ 4B.7a).

### Task 4 — C2 regression guard

- [ ] Add a comment at `mcp-server/test/list.test.ts:L279-L281` explaining that the empty-`inputSchema` assertion is a **C2 guard**: if a future change adds a workspace argument to `list_bookmarks`, this failing test means the no-cross-workspace-exposure invariant (§ 3, invariant 2) was violated, not that the test is stale.
- [ ] In that same comment, record the guard's **blind spot**: the assertion is wrapped in `if (list.inputSchema !== undefined)` (`:L279`), so it silently passes if `inputSchema` is removed altogether — it catches an added workspace argument, not a deleted schema. Note it rather than restructuring the test, which would violate the no-existing-test-modified criterion.
- [ ] Same for `add_bookmark`'s five-field schema at `mcp-server/src/tools/add.ts:L156-L162`.

### Task 5 — Documentation

- [ ] `README.md:L50-L127`: rewrite per Phase 1 step 4 — project-scoped path-free entry, `${VAR:-default}` build path, approval prompt, both-scopes warning, `args` override, Desktop-chat limitation, `BOOKMARKS_MCP_WORKSPACE` shell-export warning.
- [ ] `CHANGELOG.md` — **two entries, and one of them is not an addition:**
  - **Added:** the workspace path is now optional under VS Code-launched Claude Code.
  - **Changed:** `BOOKMARKS_MCP_WORKSPACE` is demoted below `CLAUDE_PROJECT_DIR`. This is a **behavior regression against documented, previously-correct configuration** — `README.md:L108-L109` currently instructs users to omit the `args` path and set that variable in the entry's `env` block. Anyone who followed those instructions will now find their value **silently overridden** by `CLAUDE_PROJECT_DIR` under Claude Code. Filing it under Added would hide a breaking change.
- [ ] **Migration note in both `README.md` and `CHANGELOG.md`:** users who configured via `BOOKMARKS_MCP_WORKSPACE` should switch to the path-free entry (§ 3). Keeping the old `env`-block form is no longer reliable — state plainly that it is overridden, not merely deprecated.
- [ ] Verify no remaining text in either file describes the one-registration-per-workspace model.

### Task 6 — Close out

- [ ] `npm test` green; `npm run lint`; `npm run build`.
- [ ] Confirm **no existing test was modified** (`git diff mcp-server/test/` should show additions and comments only). A modified existing test is a signal the implementation drifted from § 10 — treat it as a review finding.
- [ ] PR body: `Closes #57`, the Task 1 measurements, and a line stating the follow-up extension issue is not blocked by this PR.

### Not in this issue

The extension half (§ 4B.5/4B.7 — the follow-up issue), MCP `roots` (D2), any multi-workspace capability, any tool-schema change.

---

## 12. Revision history

### Rev 6 — the optional-`Config` strategy

Closes the last open review item. Rev 5's § 4B.8 pseudocode implied `Config` became optional while the surrounding text claimed the change was zero-churn; those could not both be true, because the tool factories type their first parameter as a non-optional `Config` and dereference it directly.

**Named strategy: (a) — `Config | undefined` through `createServer` and both tool factories, with `config === undefined` serving as the disabled signal.** Justification is failure behavior, not aesthetics: if a future edit drops the guard, (a) produces a **compile error**, while the placeholder-`Config` alternative writes `bookmarks.json` into the server's working directory and reports an empty-but-successful bookmark list. An invariant the type checker enforces beats one a comment enforces.

Rev 5's "zero-churn" claim for this piece is withdrawn and replaced with an accurate one: **no existing test is modified** (a `Config` argument still satisfies a `Config | undefined` parameter), but `tools/list.ts` and `tools/add.ts` each gain a four-line guard. Contained ripple, not zero.



### Rev 5 — `project-reviewer` findings

Two blocking findings, both fixed as design changes rather than caveats:

1. **Cross-boundary agreement (§ 4B.7a).** Rev 4's "import or mirror the constant" was architecturally wrong in both branches — importing would have created a `src/` → `mcp-server/` dependency (the reverse of #52's D4, which § 4B.5 had defended only in the forward direction), and "mirroring" was the unenforced duplicated literal the same task rejected elsewhere. Replaced with the repo's existing pattern (a) duplicated literal, enforced by pattern (b)'s cross-boundary drift test in #58.
2. **Delivery path (§ 4B.8).** A startup throw exits before `connect()`, so the refusal would reach the user only via stderr the client *may* discard, with a likely restart loop. Redesigned: connect first, refuse per tool call with `isError`. The new logic sits in a new `resolveWorkspaceState` so `resolveConfig`'s existing tests stay untouched.

Concerns folded in: Phase 0 reframed as a correctness gate on tier 3 with an explicit stop-and-return condition; the `BOOKMARKS_MCP_WORKSPACE` demotion moved to **Changed** with a migration note in both README and CHANGELOG; the sentinel extended to cover **both** disabled reasons via a prefix-plus-slug form with generic-fallback handling; Task 3 bound to merge with Task 2. Nits: count-based preservation language replaced with "no existing test modified," the `if (inputSchema !== undefined)` blind spot recorded, `touches:` completed, stale "Revision 3." header corrected.

The lesson worth keeping: **a cross-component contract needs a named owner for its enforcement, not just its value.** Rev 4 specified the sentinel's value carefully and left "how do the two sides stay in agreement" to a code comment. Naming the value is the easy half; the half that decays silently is the check.



### Rev 4 — registration scope

Q1 answered as recommended; Q2 answered **against** the recommendation (project scope, not user scope). Purely a registration/documentation change — the resolution chain, precedence, `persistent = false`, and the sentinel contract are all untouched. New material: § 4C (including the C1 re-check, the `${VAR:-default}` portability fix, the approval prompt, and the both-scopes precedence-inversion warning), § 13's task breakdown, and § 2's reworked C1 reasoning.

The lesson worth keeping: **when a user overrides a recommendation, re-check the constraint the recommendation was serving rather than just complying.** User scope had been justified partly as "C1 satisfied — one entry forever." Project scope means N entries, which *looks* like the rejected state. Re-reading C1 showed the objection was to bespoke *path-bearing* entries, not to entry count — so the property that mattered survives, and it survives because of a different design choice (the path-free entry) than the one being overridden.



### Rev 3 — the extension-injected variable

| Rev 2 | Rev 3 | Cause |
| --- | --- | --- |
| `CLAUDE_PROJECT_DIR` is the only automatic source | `BOOKMARKS_PLUS_WORKSPACE` above it; both retained | § 4B.1 — an extension-owned signal measures C2's quantity directly instead of by proxy |
| Design's foundation rests on Phase 0 measurement 1 | A wrong measurement 1 costs one fallback tier | Two independent automatic sources instead of one |
| Phase 0: three measurements | Five — adds the extension panel and the subdirectory case | § 4B.4 rows 4 and 2 |
| No extension-side work anywhere | Extension half split into a follow-up issue | § 4B.5 — different test harness, different release cadence, no blocking dependency |
| — | New risk R6 + D6 (`persistent = false`) | § 4B.2 — a cached variable is a C2 leak vector that arrives through a caching optimization |

Test impact: unchanged at **57/57 preserved**. The `mcp-server` change is still confined to `resolveConfig`'s source list.

Lesson worth keeping: **when evaluating a new signal source, ask what happens when it is *stale*, not only when it is absent or wrong.** The VS Code API's persistence feature is a latency optimization that, for a workspace-identifying variable, silently converts "not yet available" into "confidently incorrect." Absent degrades to the next tier; stale does not.

### Rev 2 — the process model



| Rev 1 | Rev 2 | Cause |
| --- | --- | --- |
| Layer 0: N configured workspace paths | Single workspace per process, from the session's own environment | C2: a candidate set is an enumeration surface |
| Layer 1: optional per-call `workspacePath` selector | No tool-schema change at all | C2: disambiguation requires naming other workspaces |
| Layer 2: MCP `roots`, recommended by the research | Not implemented; ranking reversed with rationale | Roots is a *set* primitive; § 4 |
| "Registration count, not zero config" reframe | Superseded — zero config per workspace turns out to be achievable | § 2(b): the client already passes the project root in |
| Process model assumed, flagged as needing verification | Verified from the MCP spec and Claude Code docs | Coordinator required it; it inverted the design |
| ~4 files of new/changed source, new `workspaces.ts` module | One 1-line source change plus docs | The problem was registration ergonomics, not workspace selection |
| 21/57 tests untouched | 57/57 untouched | No signature or schema changes |

The generalisable lesson, recorded because it cost a full revision: **verify the runtime's process and environment model before designing a resolution mechanism.** Rev 1 designed an in-process selection algorithm for a choice the client had already made outside the process, and the fix for the "wrong workspace" problem turned out to be reading one environment variable the platform documents and hands you unprompted.
