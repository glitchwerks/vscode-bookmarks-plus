---
title: "MCP server: session-scoped workspace resolution (issue #57)"
touches:
  - mcp-server/src/config.ts
  - mcp-server/test/config.test.ts
  - README.md
  - CHANGELOG.md
  - mcp-server/src/index.ts
skills_relevant:
  - test-driven-development
  - simplicity-first
---

# Session-scoped workspace resolution for the Bookmarks Plus MCP server

**Issue:** [glitchwerks/vscode-bookmarks-plus#57](https://github.com/glitchwerks/vscode-bookmarks-plus/issues/57) — state: open (fetched 2026-08-09).

**Revision 2.** Rev 1 of this spec proposed a multi-path candidate-set design. The user then added a second constraint that disqualifies it, and verification of the MCP process model turned up a primary-source fact that makes the whole candidate-set apparatus unnecessary. § 12 records what changed and why. **Do not implement Rev 1's layered design.**

**Status: NEARLY UNBLOCKED.** One cheap empirical probe (§ 8 Phase 0) and two questions (§ 6) remain. The design is otherwise determined by primary sources rather than by preference.

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

> "| [User](#user-scope) | All your projects | No | `~/.claude.json` |"
> — https://code.claude.com/docs/en/mcp § "MCP installation scopes" (fetched 2026-08-09)

### What (a)+(b)+(c) mean together

**This is not a "pick the right workspace from N options" problem. It is a "make one already-correctly-scoped instance easier to register" problem.**

One user-scoped registration entry, with **no workspace path in it at all**, spawns a separate server subprocess for every Claude Code session, each with `CLAUDE_PROJECT_DIR` already set to that session's project root. C1 is satisfied (one entry, forever). C2 is satisfied **structurally** — the process is never told about any other workspace, so there is nothing to leak, no policy to enforce, and no code path to get wrong.

The context-flooding risk in the current shipped design was never actually present either: it would only have appeared if we had adopted Rev 1's candidate-set model. The real defect in the shipped design is narrower than it looked — it is **registration ergonomics only**: `resolveConfig` *requires* an explicit path (`mcp-server/src/config.ts:L13-L17`), so the user must add a config entry naming each workspace, even though the client already handed the process the answer in its environment.

---

## 3. The design

Change `resolveConfig`'s source list. Nothing else.

```
workspace =
  1. argv[2]                            explicit override — lives in the registration entry
  2. env.CLAUDE_PROJECT_DIR             NEW — the session's own project root
  3. env.BOOKMARKS_MCP_WORKSPACE        legacy override, demoted — see D1
  else → throw, as today
```

Note the order: `BOOKMARKS_MCP_WORKSPACE` drops **below** `CLAUDE_PROJECT_DIR`. That is a deliberate C2 fix, not a cosmetic reshuffle — D1 explains why the obvious order is unsafe.

Everything downstream is unchanged: `path.resolve`, `mirrorPath = <workspace>/.vscode/bookmarks.json`, `verifyDelayMs` (`mcp-server/src/config.ts:L19-L31`). `Config`'s shape does not change. `createServer` does not change. Neither tool's `inputSchema` changes. Resolution stays **once, at process start** — which under § 2(a) is once per session.

Registration becomes, for every workspace on the machine, one entry:

```json
{ "mcpServers": { "bookmarks-plus": {
  "command": "node",
  "args": ["C:/path/to/vscode-bookmarks-plus/mcp-server/dist/index.js"]
} } }
```

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

### D4 — Keep the hard startup failure when nothing resolves? **Recommend: yes, unchanged.** (`mcp-server/src/config.ts:L15-L17`, surfaced by `main()`'s catch at `mcp-server/src/index.ts:L52-L59`.) The message needs updating to mention the new source, per § 8.

---

## 6. Remaining questions

**Q1. Is Claude Desktop's *chat* surface still a target, or is "Claude Code in VS Code" the whole target?** Your C2 wording — *"the claude session open in vscode"* — reads as the latter, and there is a structural reason to accept it: the Desktop chat app has no per-session project concept at all, so per-session scoping is impossible there **by construction**, not by missing support. Verified as far as the docs go: Desktop loads `claude_desktop_config.json` servers "into local Code tab sessions" and the same server "is available in both the Desktop chat surface and local Code tab sessions" (https://code.claude.com/docs/en/desktop § "MCP servers from the Claude Desktop chat app", fetched 2026-08-09) — the *Code tab* is a Claude Code session and therefore gets § 2(b) for free; the *chat* surface has no documented project root or roots support either way.

One caveat on that reasoning: "a Code tab session is a Claude Code session and therefore gets § 2(b) for free" is an **inference**, not a quotation — everything else in § 2 is quoted. Phase 0 measurement 3 tests it directly rather than leaving it asserted.

Recommended answer, pending yours: **Code-tab and CLI sessions are the target; the Desktop chat surface is supported only via the explicit `args` path (D1), which inherently means one workspace per entry there.** Documented as a limitation, not solved. This retires the unresolved research gap at `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L61` — Desktop chat's roots support stops mattering, because roots is not being implemented (D2) and Desktop chat has no session-workspace to scope to regardless.

**Q2. Should the README recommend user scope for the registration?** User scope is what makes one entry cover every project (§ 2(c)). It also means the server is offered in *every* project, including ones with no bookmarks — harmless (empty list, cheap) but worth your call versus per-project `.mcp.json` entries that are committed and shared with a team.

---

## 7. Risks

**R1 — `CLAUDE_PROJECT_DIR` may not equal the VS Code workspace folder.** It is Claude Code's project root, and the two desync when a session is launched from a subdirectory, a parent directory, or a different checkout than the folder VS Code has open (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L47`). Mitigations, in order: the Phase 0 probe measures the common case before we commit (§ 8); the explicit override (D1) covers the rest; and D3's failure mode is a visibly empty list naming the path searched, not silent wrong data. **This risk is inherent to any client-side mechanism** — roots has it too, and worse, since roots also carries `--add-dir` noise.

**R2 — Rev 1's directory-pollution risk is gone.** It existed only because a model-supplied path would flow into `writeMirrorAtomic`'s `mkdir(dirname, { recursive: true })` (`mcp-server/src/mirrorFile.ts:L16-L18`). With no workspace argument on any tool (invariant 2), the only paths that ever reach that call come from the process's own startup environment. Recorded so a future reviewer sees it was considered and designed out, not overlooked.

**R3 — Docs describe the retired model.** `README.md:L50-L127` documents one-registration-per-workspace as current behavior, including per-workspace `args` entries (`:L83`, `:L100`) and the argv-wins-over-env rule (`:L71`). The precedence rule stays true under D1; the per-workspace framing does not.

**R4 — Multi-root VS Code workspaces have no single answer, and that is an inherited constraint, not a new gap.** `CLAUDE_PROJECT_DIR` is one path, while a multi-root VS Code workspace has several folders and no single mirror-bearing root. This does not regress anything: the `.vscode/bookmarks.json` mirror shipped in #51 / PR #54 (merged as `005d67f`) is single-root by design, so multi-root workspaces were already outside the mirror's scope before #57 existed. A reviewer will ask; the answer is "inherited constraint," and widening it belongs to a mirror-design issue, not this one.

**R5 — Other MCP clients set no `CLAUDE_PROJECT_DIR`.** Cline, Continue, VS Code's own native MCP client, etc. all fall through to the explicit override and behave exactly as they do today. No regression; just no improvement. (VS Code's native client has its own idiom — `.vscode/mcp.json` with `${workspaceFolder}` — deliberately out of scope per the research's negative axis, `docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L19`.)

---

## 8. Implementation

**Phase 0 — the probe (do this first; it is ~15 minutes and it gates the rest).**

Add a temporary probe in `main()` that **appends `process.env.CLAUDE_PROJECT_DIR` and `process.cwd()` to a known file** (e.g. `os.tmpdir()/bookmarks-mcp-probe.log`). Two placement rules, both load-bearing:

- **Write to a file, not stderr.** The stdio binding permits stderr logging but guarantees nothing about delivery: "The client **MAY** capture, forward, or ignore the server's `stderr` output" (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio, fetched 2026-08-09). A file is independent of client behavior.
- **Place it before the `resolveConfig` call**, not after. With no `args` path and the fallback not yet implemented, `resolveConfig` throws and `main()` exits at `mcp-server/src/index.ts:L52-L59` — a probe placed after it would never run.

Build, register the server with no `args` path, then take **three** measurements and record all of them in the PR body:

1. Claude Code **in VS Code** on this repo — does `CLAUDE_PROJECT_DIR` equal the VS Code workspace folder? (R1; this is the one that gates the design.)
2. Claude Code from a **plain terminal**, for comparison.
3. A **Desktop app Code tab** session — this measures the § 6 Q1 inference (that a Code tab session is a Claude Code session and inherits § 2(b)) rather than leaving it asserted.

If measurement 1 is absent or wrong, **stop and re-open § 6** — the whole design rests on it. If measurement 3 is absent, the Q1 recommendation still stands but Desktop Code tab joins Desktop chat in the explicit-path-only bucket.

**Phase 1 — the change itself.**
1. `mcp-server/src/config.ts`: insert `env.CLAUDE_PROJECT_DIR` between the positional and the env var (`:L13`), per D1's order. Signature, return type, and all downstream derivation unchanged.
2. Update the startup error text (`:L16`) to name all three sources and to say that Claude Code supplies `CLAUDE_PROJECT_DIR` automatically.
3. `mcp-server/test/config.test.ts`: **add** tests — `CLAUDE_PROJECT_DIR` used when neither override is present; the `args` positional outranks it; **it outranks `BOOKMARKS_MCP_WORKSPACE`** (the D1 regression guard — this is the test that would catch a well-meaning future reorder reintroducing the shell-inheritance hole); relative `CLAUDE_PROJECT_DIR` resolved to absolute; still throws when all three are absent. Change no existing test (§ 10).
4. `README.md`: rewrite the MCP section (R3) around one user-scoped entry with no path, plus an "explicit path" subsection covering the `args` override, the Desktop-chat limitation (Q1), and a warning that a shell-exported `BOOKMARKS_MCP_WORKSPACE` pins every otherwise-unresolved session (D1).
5. `CHANGELOG.md`: note that the workspace path is now optional under Claude Code.

Test-first per the repo standard: the four new `config.test.ts` cases before the `config.ts` edit.

**Not in this issue:** roots (D2), any multi-workspace capability, any tool-schema change.

---

## 9. Alternatives considered and rejected

**A1 — Rev 1's multi-path candidate set + per-call `workspacePath` selector.** **Disqualified by C2.** Disambiguating between candidates requires telling the model what the candidates are; enumerating other workspaces' paths in a tool error is precisely the cross-session context bleed C2 forbids, and it scales with the number of registered workspaces. It also solved a problem that § 2 shows does not exist: the client already scopes each process.

**A2 — MCP `roots`.** § 4. Wrong primitive for a single-workspace requirement; costs a client version floor, an untestable lifecycle, and an escape from the convenience API.

**A3 — A launcher/wrapper script that derives the workspace from VS Code's environment.** Unnecessary: § 2(b) shows Claude Code already passes the project root into the server's environment directly, so a wrapper would only re-read what `process.env` already has. It would also add a second executable to install and to keep in sync with the server.

**A4 — Extension-published workspace registry** (`~/.bookmarks-plus/workspaces.json`). Rev 1 floated this for the Desktop-dynamic case. **Now actively undesirable**: a machine-wide list of every bookmarks workspace is the exact enumeration surface C2 argues against, plus a staleness problem and scope expansion into the extension.

**A5 — Aggregate reads across workspaces.** Directly contrary to C2. Dropped without qualification.

---

## 10. Test impact — revised

**Rev 1 estimated 21 tests untouched, ~25 needing fixture edits, 3 relocated, 1 rewritten, 3 replaced. That estimate is superseded: all 57 tests are preserved verbatim.**

Because `resolveConfig`'s signature, return type, and `Config`'s shape are unchanged, and no tool schema or handler changes:

| File | Tests | Disposition |
| --- | --- | --- |
| `contract.test.ts` | 10 | Untouched |
| `mirrorFile.test.ts` | 7 | Untouched |
| `schemaDrift.test.ts` | 4 | Untouched (verified by reading: asserts only authored-schema vs `contract.ts`'s `MAX_SUPPORTED_VERSION` and fixtures) |
| `add.test.ts` | 17 | Untouched — no fixture-helper change is needed now |
| `list.test.ts` | 8 | Untouched — including `:L279-L281`, which pins `Object.keys(inputSchema)` as `[]`. Rev 1 called this a deliberate break; under invariant 2 it stays green and becomes a **regression guard** for C2: if a future change adds a workspace argument to `list_bookmarks`, this test fails and should be read as C2 being violated. Worth a comment saying so. |
| `index.test.ts` | 1 | Untouched — `createServer` stays synchronous and I/O-free, which Rev 1 had to engineer for and Rev 2 gets for free |
| `config.test.ts` | 10 | Untouched. The throw-when-nothing-present test (`:L36-L41`) still passes: it calls `resolveConfig(argvWith(), {})` with an empty env object, so no `CLAUDE_PROJECT_DIR` is present. Verified by reading the test. |

**Net: 57/57 preserved, ~4 tests added.** If an implementation of this spec modifies an existing test, that is a signal it has drifted from the design — treat it as a review finding, not a cleanup.

---

## 11. Open questions and unverified claims

- **`unverified:` whether `CLAUDE_PROJECT_DIR` equals the VS Code workspace folder for a session started inside VS Code.** The single load-bearing empirical unknown. Phase 0 measurement 1 settles it; nothing else in the design is asserted on top of it.
- **`unverified:` that a Desktop app Code tab session inherits § 2(b)'s `CLAUDE_PROJECT_DIR` behavior.** Inferred from the Code tab being a Claude Code session, not quoted from any source. Phase 0 measurement 3 settles it. Only the Q1 scope answer depends on it, not the design.
- **`unverified:` `anthropics/claude-code#75266`** (desktop-app-spawned MCP servers getting `cwd` = `$HOME`) was never fetched directly (`docs/research/2026-08-09-mcp-dynamic-workspace-resolution.md:L73`). It does not matter here: this design reads an explicit env var and never trusts inherited `cwd`.
- **Claude Code v2.1.203's release date** — needed only for a roots version floor (`:L72`). Moot under D2.
- **Issue #57's body** was read via `WebFetch` summarisation; this planning agent has neither `Bash` nor `mcp__github__*`. Both user constraints in § 1 are quoted from the dispatch briefs, which quote the user directly.
- **No issues or milestones were created** (same tooling limitation). Follow-ups are returned to the router as prose.

---

## 12. What changed in Rev 2, and why

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
