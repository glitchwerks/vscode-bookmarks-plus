---
title: "MCP server: dynamic workspace resolution (issue #57)"
touches:
  - mcp-server/src/config.ts
  - mcp-server/src/index.ts
  - mcp-server/src/tools/list.ts
  - mcp-server/src/tools/add.ts
  - mcp-server/src/workspaces.ts
  - mcp-server/test/config.test.ts
  - mcp-server/test/index.test.ts
  - mcp-server/test/list.test.ts
  - mcp-server/test/add.test.ts
  - mcp-server/test/workspaces.test.ts
  - README.md
  - CHANGELOG.md
skills_relevant:
  - test-driven-development
  - simplicity-first
---

# Dynamic workspace resolution for the Bookmarks Plus MCP server

**Issue:** [glitchwerks/vscode-bookmarks-plus#57](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/57) — "MCP server: replace fixed per-workspace config with dynamic workspace resolution" (state: open, no comments; fetched 2026-08-09 via `WebFetch`).

**Status: DRAFT — BLOCKED on user answers to Q1–Q5 (§ 6).** The design in § 4 is a recommendation, not a decision. Every decision point in § 5 carries an explicit status. Do not begin implementation before § 6 is answered — § 5's D1 and D3 change the tool schemas, and getting those wrong costs test rework twice.

## 0. Where the code being changed lives, and how to read the citations

All `mcp-server/...` citations in this spec are line numbers **on branch `issue-52-mcp-server`, HEAD `b2fbb3f`** (worktree `I:/apps/vscode/bookmarks/.worktrees/issue-52-mcp-server`). That branch is not merged to `main`, so these paths do not resolve in a `main` checkout. Verified by reading each file on that branch on 2026-08-09.

The external prior-art report is `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md` (in the `main` checkout, untracked). Citations to it are `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:LN`.

**Before implementation starts: commit this spec and that research report onto the implementation branch.** Both files exist only as untracked files in the `main` working tree at `I:/apps/vscode/bookmarks/docs/`. The implementer will cut a worktree off `issue-52-mcp-server`, where neither file is present — so every `docs/research/…:LN` citation below silently dangles, and the spec itself is invisible from the branch. This is the same artifact-persistence trap recorded on #52; do not repeat it.

The issue #52 implementation plan (`docs/superpowers/plans/2026-08-08-mcp-server-bookmarks.md`) exists **only in the `issue-52-mcp-server` worktree** and is pre-implementation, so it is cited here for *rationale provenance only*, never as evidence of shipped behavior. Behavior claims cite `mcp-server/src/*.ts` directly.

---

## 1. The problem

Issue #52 shipped a server whose workspace is fixed at process start:

- `resolveConfig(argv, env)` takes `argv[2] ?? env.BOOKMARKS_MCP_WORKSPACE` and throws if neither is present (`mcp-server/src/config.ts:L13-L17`), then derives `mirrorPath` as `<workspace>/.vscode/bookmarks.json` (`:L29`).
- `main()` calls it exactly once at startup and hands the resulting `Config` to `createServer(config)` (`mcp-server/src/index.ts:L51-L63`), which closes over that single value when registering both tools (`:L21`, `:L32`).
- Neither tool accepts a workspace-selecting input: `list_bookmarks` declares `inputSchema: {}` (`mcp-server/src/tools/list.ts:L21`) and `add_bookmark` declares only `uri`/`type`/`collectionId`/`collectionName`/`description` (`mcp-server/src/tools/add.ts:L156-L162`).

Consequence: one `mcpServers` registration entry serves exactly one workspace. The user rejected this in the words quoted in the dispatch brief: *"We need a new approach then. This wont work. We cant have an mcp per workspace."*

This was not an implementation slip. It was #52's stated acceptance criterion — "Workspace path is supplied via MCP server config/args — no auto-discovery… one workspace per server config" (quoted in `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L3`). #57 supersedes that criterion.

**Assumption being challenged, explicitly:** #52 assumed a workspace-per-registration model was acceptable because the human operator vets the path once at registration time. That assumption bought a real safety property — the server can only ever touch a directory a human approved. Any dynamic design gives that property up unless it is deliberately re-established (see § 5 D3 and § 7 R1). "Make it dynamic" is not free.

---

## 2. Reframe: the constraint is *registration count*, not *zero configuration*

The user's constraint is that there must not be one MCP server registration per workspace. It is **not** stated as "the server must require no configuration." These come apart, and the difference is the cheapest lever available:

> Letting the existing `argv` / `BOOKMARKS_MCP_WORKSPACE` mechanism accept **N paths instead of 1** satisfies the user's literal constraint with zero MCP-protocol dependency, zero client-capability dependency, and no dependence on the unresolved Claude Desktop question (§ 6 Q1).

This matters for sequencing: it means **the Claude Desktop `roots` unknown does not block the design.** It only decides whether the client-roots layer ships in phase 1 or is deferred.

The honest caveat, stated so this reframe does not read as a dodge: a user annoyed by per-workspace registration is plausibly also annoyed by editing a config file for every new project. Multi-path static config satisfies the letter of the constraint and may not satisfy the intent. That is precisely why the roots layer stays in the plan as a real phase (§ 4 layer 2, § 8 phase 2) rather than a "maybe later" — but it is stacked *on top of* a floor that works without it.

---

## 3. What the research settled, and what it did not

From `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md`:

**Settled:**
- The MCP `roots` primitive exists in the already-pinned SDK (`@modelcontextprotocol/sdk` 1.30.0) — `listRoots()`, `RootsListChangedNotificationSchema`, capability gating are all present at that tag (`:L40`).
- But the high-level `McpServer` class this project uses (`mcp-server/src/index.ts:L16`) **does not surface roots**; a caller must reach through `server.server.*` to the low-level `Server` (`:L40`).
- The reference filesystem server's lifecycle is the pattern to copy: request roots inside `oninitialized` (post-connect, never at startup), re-request on `roots/list_changed`, fall back to CLI-supplied directories when the client lacks the capability or `listRoots()` throws, hard-error only when *no* source produced anything (`:L29-L33`).
- Claude Code CLI answers `roots/list` with launch dir + `--add-dir` set, and sends `list_changed`, **since v2.1.203** — after two closed bug reports where it advertised the capability and silently failed (`:L43-L45`).
- Anthropic's own docs point servers that scope filesystem access toward `roots/list` rather than `CLAUDE_PROJECT_DIR` (`:L46`).

**Not settled — do not design as if these were answered:**
- Whether Claude Desktop (the standalone chat app) implements client-side `roots` at all. No primary source either way; the researcher recommends empirical verification (`:L61`).
- Which returned root is "the bookmarks workspace" when `roots/list` returns zero, one, or several — no external prior art, this is our design work (`:L62`).
- A root is *Claude Code's session directory set*, not *the VS Code workspace with the extension open*. They coincide in the common case and desync for worktrees, monorepo subdirs, and sessions launched from `$HOME` (`:L47`). **This caveat applies to every candidate**, including the recommended one.

**A consequence the research did not draw, which the user should weigh (§ 6 Q1):** Claude Desktop has no "open folder" concept at all. If it has no roots *and* the model in that client has no filesystem context, then *no* dynamic mechanism can work there — not roots, not a per-call path argument (the model would have nothing to fill it with), not `cwd` inheritance. For Desktop the realistic options reduce to: a configured path list, or a new discovery surface written by the extension (§ 9 A3). This reframes Q1 from a capability question into a semantics question.

---

## 4. Recommended design (pending § 6)

**Core structural change:** workspace resolution moves from *once per process* to *once per tool call*. `Config`-as-a-value becomes settings-plus-provider.

```
ServerSettings                          resolved once at startup
  configuredWorkspaces: string[]        argv positionals + BOOKMARKS_MCP_WORKSPACE (comma-separated)
  verifyDelayMs: number                 unchanged semantics

WorkspaceRegistry                       mutable, lives for the process
  configured: string[]                  from ServerSettings, never emptied
  fromRoots: string[]                   populated at oninitialized, replaced on roots/list_changed
  candidates(): string[]                configured ∪ fromRoots, de-duplicated, absolute

resolveWorkspace(registry, requested?)  called per tool invocation
  → { workspacePath, mirrorPath } | AmbiguityError | NoCandidatesError
```

**Resolution algorithm** (this is the whole design; § 5 D1–D5 are the choices baked into it):

1. If the call supplied `workspacePath`, it must **match a member of `candidates()`** (after `path.resolve` normalisation). No match → tool error naming the candidate set. It is a *selector*, never a free-form path (see § 7 R1).
2. Else if `candidates()` is empty → tool error explaining that no workspace is configured and the client advertised no usable roots. Actionable text, not a stack trace.
3. Else if `candidates()` has exactly one entry → use it, **whether or not `.vscode/bookmarks.json` exists yet**. This preserves the ability to bootstrap a workspace's first bookmark through `add_bookmark`.
4. Else narrow to candidates where `<candidate>/.vscode/bookmarks.json` exists. If exactly one survives → use it.
5. Else → tool error enumerating the surviving candidates and instructing the model to re-call with `workspacePath: "<one of these>"`.

Mirror presence is a **ranking signal, not a membership filter** — that is what makes step 3 and step 4 coexist without a bootstrap dead-end.

Fail-loud at every ambiguity. The server never guesses which workspace the user meant.

**Layering:**

- **Layer 0 (floor, no protocol dependency):** multi-path static config. Satisfies the user's constraint on its own.
- **Layer 1 (disambiguator):** optional `workspacePath` selector argument on both tools.
- **Layer 2 (auto-population, additive):** client roots feed `registry.fromRoots`, following the reference server's lifecycle (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L29-L33`). If the client lacks `roots` or `listRoots()` throws, layers 0+1 still work. Roots **augment** the candidate set here rather than replacing configured directories the way the reference filesystem server does (`:L31`) — deliberate divergence, see § 5 D4.

**Architecture constraint that keeps existing tests standing:** roots resolution fires at `oninitialized`, i.e. after `connect()`. `createServer()` today is synchronous and performs no I/O, and `mcp-server/test/index.test.ts:L47-L76` asserts exactly that (server constructed, `isConnected() === false`, exactly two tools registered, no transport). Keep `createServer()` I/O-free; put roots wiring in a separate `attachRootsSync(server, registry)` that is unit-testable on its own and mutates the registry the handlers read **at call time**.

---

## 5. Decision points

Each carries a recommendation and a status. Statuses marked BLOCKED must be resolved before implementation.

### D1 — Do the tools gain a `workspacePath` argument? **Recommend: yes, optional, selector-only. BLOCKED on Q2.**

Optional on both `list_bookmarks` and `add_bookmark`. Absent → algorithm steps 2-5 apply. Present → step 1 (must match a candidate).

Cost: breaks the `inputSchema` assertion at `mcp-server/test/list.test.ts:L279-L281` (`assert.deepEqual(Object.keys(list.inputSchema), [])`). That test's *title* says "no required input" (`:L265`) — the assertion is stricter than its stated intent. Update the assertion to "no **required** keys," preserving the intent.

Alternative rejected: making it required. Per `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L54-L56`, a practitioner reported the per-call-path pattern "works flawlessly" but "adds burden to every tool call," with no protocol guarantee the model supplies it correctly. Optional-with-fallback gets the escape hatch without paying that cost on every call.

### D2 — How are multiple static paths expressed? **Recommend: repeated positionals + comma-separated env var. Status: open, low stakes, reversible.**

`node dist/index.js /path/a /path/b` and `BOOKMARKS_MCP_WORKSPACE=/path/a,/path/b`.

Separator choice is `,` deliberately, not `path.delimiter`: `path.delimiter` is `;` on Windows and `:` on POSIX, and `:` is unusable here because Windows paths contain drive-letter colons. A platform-dependent separator would make one documented example wrong on the other OS. `,` means the same thing everywhere and appears in neither platform's conventional paths. The primary development machine here is Windows, so the cross-platform-consistent choice costs nothing locally.

Today `argv[2]` wins over the env var entirely (`mcp-server/src/config.ts:L13`); under the multi-path model, **union the two sources instead of overriding** — an override rule on a set is a footgun. This is a documented behavior change for anyone who currently sets both.

### D3 — Is `workspacePath` a free-form path or a selector from the candidate set? **Recommend: selector. Status: strongly recommended, confirm via Q2.**

See § 7 R1 — this is the single highest-consequence line in the spec.

### D4 — Do roots *replace* or *augment* configured paths? **Recommend: augment. Status: open.**

The reference filesystem server replaces (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L31`). Diverge, because the two sources mean different things here: configured paths are *human-vetted bookmarks workspaces*; roots are *whatever directories the client session happens to hold* (`:L47`). Replacing would let an unrelated `--add-dir` evict the user's real workspace from the allowlist. Augmenting keeps the vetted set as a floor.

### D5 — Does the roots layer ship in phase 1 or phase 2? **Recommend: phase 2. BLOCKED on Q1/Q3.**

Layer 0+1 is shippable, testable without a real client, and satisfies the stated constraint. The roots layer needs an empirical capability check against real clients (§ 8 phase 2 step 1) which cannot be done from a test suite.

### D6 — Does `list_bookmarks` keep returning a single workspace's bookmarks? **Recommend: yes. Status: open, see § 9 A2.**

---

## 6. Clarifying questions — answer these before implementation

**Q1. Which clients must this support?** Claude Code CLI only, or Claude Code + Claude Desktop? And — the more useful form of the question — **in Claude Desktop, which has no open-folder concept, what should "the relevant workspace" even mean?** If the answer is "in Desktop you just point it at a path (or a few) in the config," then Desktop's `roots` support is moot regardless of whether it exists, and the unresolved research gap (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L61`) drops off the critical path entirely.

**Q2. Is an optional per-call `workspacePath` selector acceptable** (D1/D3)? It is client-agnostic and has no protocol dependency. The cost is that the model must supply the right value when more than one candidate exists — mitigated by the enumerated-candidates error in algorithm step 5, which tells the model exactly what to re-call with.

**Q3. Ship the roots layer now, or ship layer 0+1 first and add roots after?** (D5.) Roots buys "new project just works without editing config" for Claude Code ≥ v2.1.203. It costs reaching through `server.server.*` past the convenience API (`:L40`), plus a lifecycle you cannot fully test without a live client.

**Q4. Is a minimum Claude Code version acceptable as a documented requirement?** Roots is only reliable from v2.1.203 onward; before that Claude Code advertised the capability and never answered, hanging callers 5+ seconds (`:L43-L45`). If we ship roots, README must state the floor. No release *date* for v2.1.203 was found (`:L72`) — if a date is needed, pull it from the GitHub releases API, not `CHANGELOG.md`.

**Q5. If Desktop must resolve dynamically, is an extension-side change in scope?** The only mechanism that could work there is the extension publishing a machine-level registry of known bookmarks workspaces (§ 9 A3). That expands #57 out of `mcp-server/` and into the extension. Default assumption unless you say otherwise: **out of scope.**

---

## 7. Risks

**R1 — `add_bookmark` with a free-form path is a directory-polluter.** `writeMirrorAtomic` calls `mkdir(dirname(path), { recursive: true })` before writing (`mcp-server/src/mirrorFile.ts:L16-L18`). Under a free-form `workspacePath`, a model that supplies a plausible-but-wrong path silently creates `.vscode/bookmarks.json` inside an unrelated repository, where nothing will ever consume it and the user will never see it. **This risk does not exist today** — it is created by this redesign, and it is the price of giving up #52's human-vets-the-path property (§ 1). Mitigation is D3: the argument selects from `candidates()`; it never introduces a new path. Reads could safely be laxer; writes must not be. This is also the strongest reason to keep the configured-path list after roots works.

**R2 — A client root is not a bookmarks workspace.** Restating `:L47` as a live risk: Claude Code answers with its own session dirs. Worktrees are the concrete case in this very repo — the code under discussion lives at `.worktrees/issue-52-mcp-server/mcp-server/…`, a real directory Claude Code would plausibly report as a root and which is *not* a bookmarks-enabled workspace (`:L33`). Mitigation: the mirror-presence ranking in algorithm step 4, plus fail-loud ambiguity.

**R3 — Stale registry after `roots/list_changed` is missed.** Claude Code did not send that notification before v2.1.203 (`:L44`). If it is missed, `fromRoots` goes stale and a newly-added directory is rejected. Mitigation: configured paths are never evicted (D4), so the floor still works; the ambiguity error names what the server *does* know, making staleness visible instead of silent.

**R4 — Untested lifecycle.** `oninitialized` and the notification handler cannot be exercised by the existing `node --test` suite without a live client. Mitigation: unit-test `attachRootsSync` against a fake `Server` shape and record the real-client check as a manual verification step (§ 8 phase 2 step 1) rather than pretending a unit test covers it.

**R5 — Two docs surfaces already describe the old model.** `README.md:L50-L127` documents the one-workspace-per-registration model as current behavior, including the argv-wins-over-env rule (`:L71`) and per-workspace config entries (`:L83`, `:L100`, `:L109`). All of it needs rework, and D2 changes the precedence rule it documents.

---

## 8. Provisional phasing (finalise after § 6)

Test-first throughout, per the repo's TDD standard. Phase 1 is shippable on its own.

**Phase 1 — layer 0 + layer 1 (no protocol dependency).**
1. `mcp-server/src/workspaces.ts`: `WorkspaceRegistry` + `resolveWorkspace`, with the five-step algorithm. New test file; this is where the new coverage lands.
2. `mcp-server/src/config.ts`: `resolveConfig` → `resolveSettings`, returning `{ configuredWorkspaces: string[], verifyDelayMs }`. Drops `workspacePath`/`mirrorPath`; keeps `verifyDelayMs` parsing byte-for-byte.
3. `mcp-server/src/tools/list.ts` + `add.ts`: factories take `(settings, registry, deps)`; each handler resolves at call time. `addOnce` takes the resolved `mirrorPath` as a parameter — **its read → mutate → atomic write → verify → one-retry body does not change** (`mcp-server/src/tools/add.ts:L92-L145`).
4. Optional `workspacePath` in both `inputSchema`s (D1).
5. `mcp-server/src/index.ts`: `main()` builds settings + registry, passes both into `createServer`. `createServer` stays synchronous and I/O-free.
6. README + CHANGELOG rework (R5).

**Phase 2 — layer 2 (roots), only if Q3 says now.**
1. **Manual, first:** connect the server to a real Claude Code session and a real Claude Desktop session, log `server.server.getClientCapabilities()`, record both results in the PR body. This is the empirical answer to the research gap (`:L61`) and it gates the rest of the phase.
2. `attachRootsSync(server, registry)`: `oninitialized` → capability check → `listRoots()` in a try/catch that logs and degrades rather than throwing → validate each root resolves to a real directory → populate `fromRoots`. Register the `list_changed` handler to re-run the same path.
3. Unit-test against a fake `Server` (capability present / absent / `listRoots()` rejects / returns non-directories).
4. README: minimum Claude Code version (Q4).

---

## 9. Alternatives considered and not recommended

**A1 — `CLAUDE_PROJECT_DIR` / inherited `cwd`.** Anthropic's own docs steer scoping servers to `roots` over `CLAUDE_PROJECT_DIR` (`:L46`), and there is an unverified report that desktop-app-spawned MCP servers get `cwd` set to `$HOME` (`:L47`, flagged as not directly fetched at `:L73`). Nothing here beats layer 0+1, and it inherits R2 in full.

**A2 — `list_bookmarks` aggregates across all candidate workspaces.** Genuinely appealing: reads are safe, and aggregation makes disambiguation unnecessary for the read path. Rejected for phase 1 because it restructures the `list_bookmarks` payload and costs list-tool tests, against this spec's preservation goal (§ 10). Reconsider as a follow-up.

**A3 — Extension-published workspace registry** (e.g. the extension maintains `~/.bookmarks-plus/workspaces.json` of workspaces it has mirrors in; the server reads it and exposes selection by *name*). This is the only option that would let a Claude Desktop session pick a workspace without the model knowing filesystem paths. Costs: a new cross-process surface, a new staleness problem, and scope expansion out of `mcp-server/` into the extension. Promote to a decision point only if Q1/Q5 say Desktop must resolve dynamically.

**A4 — Required `workspacePath` on every call, no static config.** Simplest schema, worst ergonomics, and it hands R1 a loaded weapon: with no candidate set there is nothing to validate against. Rejected.

---

## 10. Preservation analysis — how much of the green 57 survives

Baseline: 57 tests across 7 files (counted 2026-08-09 by matching `test(` declarations on branch `issue-52-mcp-server`).

| File | Tests | Disposition |
| --- | --- | --- |
| `contract.test.ts` | 10 | **Untouched.** `contract.ts` is pure parse/serialize; nothing workspace-aware. |
| `mirrorFile.test.ts` | 7 | **Untouched.** `readMirror`/`writeMirrorAtomic` are already path-parameterised (`mcp-server/src/mirrorFile.ts:L5`, `:L16`). |
| `schemaDrift.test.ts` | 4 | **Untouched.** Verified by reading it: all four assertions compare the authored JSON Schema against `contract.ts`'s `MAX_SUPPORTED_VERSION` and fixtures. No tool-schema coupling. |
| `add.test.ts` | 17 | **Bodies preserved.** Only the local `makeConfig` helper changes to supply a fixed single-candidate registry. The RMW-verify-retry assertions — the most valuable tests in the suite — are untouched. |
| `list.test.ts` | 8 | 7 preserved via the same helper change. **1 deliberate break:** `:L279-L281` pins `Object.keys(inputSchema)` as `[]`; D1 adds an optional key. Rewrite to assert *no required keys*, matching the test's own title at `:L265`. `:L284-L297` (payload surfaces the resolved workspace/mirror path) survives as-is and becomes *more* meaningful. |
| `index.test.ts` | 1 | Preserved, provided `createServer` stays synchronous and I/O-free (§ 4). Only the `makeConfig` fixture shape changes. |
| `config.test.ts` | 10 | **Most affected**, itemised below. |

`config.test.ts`, test by test (all 10 accounted for):

- `:L65`, `:L71`, `:L79`, `:L87` — the 4 `verifyDelayMs` tests (default 400, parse, explicit `0` is not "missing", reject non-numeric). **Survive essentially verbatim** against `resolveSettings`.
- `:L43-L48`, `:L50-L57` — relative positional / relative env var resolve to an **absolute** path. **Preserved and moved** to `workspaces.test.ts`, generalised to "every configured path is normalised to absolute." More load-bearing under multi-path, not less: absolute normalisation is what makes the selector match in algorithm step 1 reliable.
- `:L59-L63` — `mirrorPath` derived as `<workspace>/.vscode/bookmarks.json`. **Preserved and moved** to `workspaces.test.ts`; it becomes an assertion about `resolveWorkspace`'s return value.
- `:L14-L26`, `:L28-L34` — the 2 precedence tests (positional wins over env; env used when no positional). **Replaced.** D2 makes the two sources union rather than override.
- `:L36-L41` — throws when neither source is present. **Replaced.** Startup no longer throws on an empty set; the error moves to tool-call time (algorithm step 2), so the replacement assertion lives in `workspaces.test.ts`.

**Net: 21 tests untouched outright; ~25 preserved with a fixture-helper edit; 3 preserved but relocated to `workspaces.test.ts`; 1 deliberately rewritten; 3 replaced by new resolution tests.** This is a change to *how the workspace is chosen*, not to *what the server does with it* — no rewrite is warranted, and any plan that produces one has gone wrong.

---

## 11. Open questions and unverified claims

- **Claude Desktop's `roots` support is unknown** and is not resolved by this spec. Recorded as a manual verification step (§ 8 phase 2 step 1), not an assumption.
- **`unverified:` Claude Code v2.1.203's release date.** Not present in the fetched `CHANGELOG.md` (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L72`). Needed only if Q4 says a version floor goes in the README.
- **`unverified:` `anthropics/claude-code#75266`** ("cwd set to `$HOME` for desktop-app-spawned MCP servers") was seen only in search-result titles, never fetched (`:L73`). It is cited in A1 as a reason not to *rely* on inherited `cwd` — a directional signal, not a settled fact. Nothing in the recommended design depends on it.
- **Issue #57's body was read via `WebFetch` summarisation**, not verbatim through the GitHub API — this planning agent has neither `Bash` nor `mcp__github__*`. The rejected-assumption quote in § 1 comes from the dispatch brief, which quotes the user directly.
- **Milestone / follow-up issues are not created by this spec** (same tooling limitation). Requests for them are handed back to the router as prose.
