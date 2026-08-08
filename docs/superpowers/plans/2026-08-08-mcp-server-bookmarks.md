---
title: "`mcp-server/` — expose bookmarks to Claude via MCP (issue #52)"
touches:
  - mcp-server/package.json
  - mcp-server/package-lock.json
  - mcp-server/tsconfig.json
  - mcp-server/.eslintrc.json
  - mcp-server/src/**
  - mcp-server/test/**
  - mcp-server/scripts/**
  - .vscodeignore
  - .gitignore
  - .github/workflows/ci.yml
  - README.md
  - CHANGELOG.md
skills_relevant:
  - test-driven-development
  - simplicity-first
  - claude-github-tools:github-actions
---

# MCP Server for Bookmarks Plus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver GitHub issue #52 (milestone v1.0): a standalone Node/TypeScript `mcp-server/` package that exposes the extension's `.vscode/bookmarks.json` mirror to Claude Desktop and Claude Code over stdio, with two tools — `list_bookmarks` (read) and `add_bookmark` (append). The workspace path is supplied by MCP server config; there is no auto-discovery.

---

## Before you start: the checkout is current, but citations still need a sweep

**The `git pull --ff-only` is done.** Local `main` now matches `origin/main` with PR #54 (issue #51) fully present: `src/migrations.ts`, `src/normalize.ts`, `src/bookmarkMirror.ts`, `src/delayer.ts`, `schemas/bookmarks.schema.json`, the README mirror section, and `CURRENT_SCHEMA_VERSION = 2` all exist in the tree.

All `src/*.ts:Lx` citations in this plan were verified against that pulled tree on 2026-08-08 and are real line numbers.

Unrelated leftover, not part of this work: a locked worktree directory at `.worktrees/issue-51-bookmark-descriptions` survived cleanup because of a Windows file-handle issue. Ignore it here; clean it separately.

### Remaining obligation: the `2026-08-04-...md:Lx` citations

A few design-rationale claims below still cite `docs/superpowers/plans/2026-08-04-bookmark-descriptions-file-mirror.md` by line. That file is **untracked** — it has never been on `main`, and per CLAUDE.md § Document Files it is due for deletion now that #51 closed via PR #54. It is also a *pre-implementation* document, so it is not authoritative for shipped behavior — this plan documents one place where it already diverged from what shipped (see "Drift is not hypothetical" below).

Every claim that depends on actual runtime behavior has already been re-anchored to `src/*.ts:Lx`. **Task 1 Step 1 finishes the job** for the remaining rationale-only references and decides that file's fate. Do not skip it — leaving this plan depending on an untracked file makes those references dangle the moment #52's PR merges.

---

## Architecture

```
  Claude Desktop / Claude Code
            │  stdio (JSON-RPC 2.0)
            ▼
  mcp-server/           standalone npm package — NO dependency on ../src
    src/index.ts          bootstrap: server + StdioServerTransport
    src/config.ts         workspace path from argv/env → mirror file path
    src/mirrorFile.ts     read (ENOENT → undefined) / atomic write (temp + rename)
    src/contract.ts       tolerant read validation | canonical write construction
    src/tools/list.ts     list_bookmarks   (readOnly)
    src/tools/add.ts      add_bookmark     (read → mutate → atomic write → verify → 1 retry)
            │  reads / writes
            ▼
  <workspace>/.vscode/bookmarks.json          ← the shared contract
            ▲
            │  FileSystemWatcher (150 ms debounce) + SHA-256 echo suppression
  VS Code extension — BookmarkStore
    persist() → Delayer(250 ms) → atomic write → record bookmarks.mirrorHash
    reloadFromMirror() → JSON.parse → isStrictBookmarkData → migrate → normalize → adopt
```

The mirror file is the entire interface. The MCP server never imports from `../src`, never talks to a running VS Code, and works with the editor closed — matching the `obsidian-brain` "vault is just a folder" design principle (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:49`).

---

## The contract the server must honor

This is the most load-bearing section of the plan. It is derived from the extension's adopt path, which **gates on strict validation before it normalizes**:

> `adoptMirrorContent()` … 1. JSON parsing … 2. Schema validation: `if (!isStrictBookmarkData(parsed))` — reject with message 3. Migration … 4. Normalization
> — `adoptMirrorContent`, `src/bookmarkStore.ts:368-392` (JSON parse `:373`, strict gate `:376-377`, migrate `:385`, normalize `:389`, hash record `:392`); the rejection path is `rejectMirrorContent`, `:404`

That gate splits externally-authored data into two very different outcomes:

| The server writes… | The extension does… | Result |
|---|---|---|
| Data that **fails** `isStrictBookmarkData` | `rejectMirrorContent()` — logs, keeps its own state, leaves the file untouched "until your next bookmark change overwrites it" | **The server's write is silently lost.** |
| Data that **passes strict** but violates store invariants (dangling `collectionId`, duplicate `(uri, collectionId)`, non-contiguous `order`) | `normalizeBookmarkData()` repairs it, adopts it, and schedules a write-back | **Converges.** |

So the server's obligation is precisely: **must be strictly valid; may be invariant-imperfect.**

This is why the server does **not** need to reimplement `src/normalize.ts` (~140 lines of repair logic). Repair is the extension's job by design: `normalizeBookmarkData` (`src/normalize.ts:37`) resets dangling `collectionId`s, drops duplicate `(uri, collectionId)` pairs, and renumbers `order` contiguously per parent — and the adopt path runs it on every externally-authored payload (`src/bookmarkStore.ts:389`). The server only needs to not emit *malformed* data, plus enough hygiene to avoid obvious churn (assign a uuid, set `order` to the sibling count, refuse an exact duplicate).

### Read validation must be tolerant, write validation must be strict

These two are **not** the same check, and conflating them ships a bug.

`schemas/bookmarks.schema.json` sets `"additionalProperties": false` on both `bookmarkItem` and `bookmarkCollection`. `isStrictBookmarkData` (`src/types.ts:80-85`) delegates to `isValidBookmarkItem` / `isValidBookmarkCollection`, neither of which rejects unknown fields. **The JSON Schema is stricter than the extension's own validator.** That asymmetry is the safe direction for writes and the wrong direction for reads, because the published contract promises the opposite:

> "Fields may be added in a future schema version; existing fields will not change meaning without a version bump."
> — `README.md` § "The .vscode/bookmarks.json mirror"

If `list_bookmarks` validated reads with ajv against the bundled v2 schema, it would reject exactly the additive-field files the contract guarantees will appear — breaking the AC's forward-compatibility requirement and manufacturing the failure mode the research flagged as having no prior art (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:101`).

Therefore:

- **Read path (`list_bookmarks`)** — parse JSON; check `version` is an integer in `1..2`; check the fields the server actually reads (`id`, `type`, `uri`, `collectionId`, `order`, `description`) are well-typed; **ignore unknown fields entirely**. `version > 2` → a clear error naming "upgrade the MCP server", never a silent read and never a write.
- **Write path (`add_bookmark`)** — the output object must satisfy **both** the JSON Schema (including `additionalProperties: false`) **and** `isStrictBookmarkData`. Unknown fields read from the input file are preserved verbatim on entries the server did not touch, and the new entry the server constructs carries only known fields.

### Drift is not hypothetical — it already happened

The `isValidBookmarkCollection` written into #51's implementation plan omits the `v.name.length > 0` check that the shipped `src/types.ts:59-72` actually has — and the shipped behavior is pinned by a real test, `'isStrictBookmarkData rejects a payload whose collection is missing its name'` (`src/test/suite/migrations.test.ts:110-116`). Two encodings of one contract diverged inside issue #51's own artifacts, within days. That is the concrete argument for the drift-check test in Task 8, not a speculative one.

---

## Decisions

### D1 — SDK generation: pin `@modelcontextprotocol/sdk` v1.x (`^1.30.0`)

**Decided: v1.x.** The research deliberately left this open and documented both live generations (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:22-33`).

Reasons:

1. **v2 has two mutually inconsistent official idioms right now.** `typescript-sdk/docs/get-started/first-server.md` teaches a factory + `serveStdio(createServer)` shape with `zod/v4`; `modelcontextprotocol.io/quickstart/server` teaches `registerTool` + `new StdioServerTransport()` + `server.connect()` on the same v2 package (`:31-32`). Two official pages disagreeing about the idiom is a strong in-flight-churn signal. Pinning a first release to a moving target costs more than one migration later.
2. **v1 is what first-party code still runs.** `modelcontextprotocol/servers` `src/memory/index.ts` on `main` imports the v1 API (`:27`).
3. **v1 is what Anthropic's own guidance prescribes.** The `mcp-builder` skill pins `^1.6.1` and mandates `registerTool` over the deprecated `server.tool()` / manual `setRequestHandler` style (`:28`, `:82`).
4. **Both closest prior arts use v1** — `chromium-bookmarks-mcp` on `^1.29.0`, `infinitepi-io/bookmark-manager-mcp` on `^1.13.2` (`:29`).

**Gate before any tool logic (Task 0).** The research flags as `unverified:` whether Claude Desktop/Code enforce a minimum protocol version that would force v2 (`:33`, `:115`). Task 0 settles it empirically with a hello-world server and one real tool call. If v1 is refused, switch to the `modelcontextprotocol.io` v2 idiom (`:32`) — **no other task in this plan changes**, because the migration surface is `src/index.ts` plus the `inputSchema` shape (bare Zod field object in v1 vs. `z.object({...})` in v2, `:26`, `:32`).

**Explicitly rejected:** an abstraction layer over both SDK generations. The shim costs more than the one-file migration it would insure against.

### D2 — Package layout: standalone `mcp-server/`, no npm workspaces

**Decided: fully standalone. No workspaces, no shared TS package, no runtime or build-time import from `../src`.**

This resolves the question issue #51's plan explicitly handed to #52:

> **Q5 — Should the future MCP server (#52) write through a documented helper rather than raw JSON?** … Worth deciding in #52 whether the server reuses this repo's serialization/normalization code or reimplements it.
> — #51's implementation plan, Open Question Q5. Quoted verbatim here because the source file is untracked and due for deletion; the durable anchor for this handoff is **#51 / PR #54**, and this plan is its answer of record.

**Answer: reimplement a minimal subset; consume `schemas/bookmarks.schema.json` as the contract; do not share TypeScript source.**

Reasons:

1. **The repo root `package.json` is the VSIX manifest**, not a bare workspace root — it carries `contributes`, `activationEvents`, `main`, and the publish scripts (`package.json:15-16`, `:17-68`, `:69-82`). Converting it to an npm-workspaces root on a shipped 1.0 extension puts `vsce package --no-dependencies` (`package.json:79`), the esbuild bundle, the `@vscode/test-electron` runner, and both publish lanes in the blast radius of a feature that needs none of them.
2. **`mcp-server/` is already outside the extension's compile graph.** Root `tsconfig.json` sets `"rootDir": "src"` and `"include": ["src/**/*.ts"]` (`tsconfig.json:7`, `:14`). A sibling directory with its own `tsconfig.json` needs zero root changes.
3. **The only reusable modules are the ones the server barely needs.** `src/types.ts`, `src/migrations.ts`, and `src/normalize.ts` are pure (node `crypto` only), but `src/bookmarkMirror.ts:2` imports `vscode` — and its `MirrorPort` implementation is built on `vscode.FileSystem`, `vscode.Uri`, and `vscode.FileSystemError`, so it is unusable outside the extension host. The I/O layer must be rewritten regardless. And per the contract section above, `normalize.ts` is the extension's job, not the server's.
4. **The `chromium-bookmarks-mcp` precedent does not transfer cleanly.** Its workspace root is a bare coordinator, not a publishable extension manifest (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:40`). Its genuinely transferable lesson is the dependency footgun — "a shared/internal package must be a **devDependency**, not a runtime dependency, if it's bundled into the published server's `dist`" (`:42`) — which we sidestep entirely by having no shared package.

**Single source of truth for the schema.** `schemas/bookmarks.schema.json` stays authored once at the repo root. `mcp-server/`'s build copies it into `mcp-server/dist/` (Task 1) so a published tarball is self-contained, and Task 8 adds a test that fails if the copy diverges from the authored file. One file, one copy step, one drift gate.

### D3 — Concurrency: documented last-write-wins, plus post-write verification and one bounded retry

**Decided: conform to the published LWW contract. Add read → write → verify → retry-once → surface-a-clear-error. No lock files.**

The research found no prior art for this race — the first-party `memory` server does an unlocked full-file rewrite with no atomic rename and no optimistic-concurrency check (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:61`, `:96-100`). This is original design work.

**The concrete race, traced against the extension's actual mechanism** — write debounce `DEFAULT_MIRROR_WRITE_DELAY_MS = 250` (`src/bookmarkStore.ts:21`), watcher debounce `WATCHER_DEBOUNCE_MS = 150` (`src/extension.ts:26`, applied at `:112-114`), hash recorded after a successful write (`src/bookmarkStore.ts:364`), echo suppression comparing that hash on both read paths (`src/bookmarkStore.ts:308` in `syncWithMirror`, `:336` in `reloadFromMirror`):

```
t=0     user adds bookmark B in VS Code → persist() → mirror write scheduled for t≈250
t=100   MCP server writes the file: {A, M}
t≈100   extension's watcher fires → reload scheduled for t≈250
t=250   both timers fire. Whichever runs first wins:

  (a) write first:  extension writes {A, B}, records hash({A,B}).
                    reload then reads {A,B}, hash MATCHES → early-returns as an echo.
                    → M is lost, silently, with no log line.

  (b) reload first: extension adopts {A, M} wholesale, replacing in-memory {A, B}.
                    writeMirrorNow then writes {A, M}.
                    → B is lost — the user's own just-added bookmark.
```

Both orderings lose exactly one write, and case (a) is invisible to everyone. This is the LWW the README already publishes ("If the extension and an external tool write at the same moment, the later write survives" — `README.md` § "The .vscode/bookmarks.json mirror") — the plan does not try to defeat it, it makes it **observable**.

**Mechanism (the contract):**

1. `add_bookmark` re-reads the file on every call. **No in-memory cache between tool calls** — the caching-plus-blind-overwrite pattern is the concrete anti-pattern the research called out in `infinitepi-io/bookmark-manager-mcp` (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:72`).
2. Write atomically: temp file in the same directory, then rename with overwrite — matching the extension's own `WorkspaceMirrorFile.write` (`src/bookmarkMirror.ts`, `WorkspaceMirrorFile` class) so no reader observes a partial write.
3. After the write, wait a short delay, re-read, and confirm the new item's `id` is present.
4. If absent, run the whole read-modify-write **once more**.
5. If still absent, return a tool error naming the likely cause: *"the bookmark was written but did not survive — VS Code is probably running and overwrote the file. Retry, or add it from the Bookmarks view."*

**The delay is tuning, not a guarantee.** 400 ms is derived as 250 + 150, and **both constants are verified against the pulled tree**: `DEFAULT_MIRROR_WRITE_DELAY_MS = 250` (`src/bookmarkStore.ts:21`) and `WATCHER_DEBOUNCE_MS = 150` (`src/extension.ts:26`). They are nonetheless private constants inside a package this server deliberately does not depend on, and can change without notice. The retry-and-report *mechanism* is the deliverable; only the knob's default depends on these numbers. Expose it as `BOOKMARKS_MCP_VERIFY_DELAY_MS` (default `400`, `0` disables verification for scripted/batch use) and document the derivation as a heuristic. **The retry-and-report contract is the deliverable; the number is a knob.**

**Why not lock files:** the extension does not acquire or honor any lock — `WorkspaceMirrorFile.write` (`src/bookmarkMirror.ts`) is exactly `createDirectory` → `writeFile` (temp) → `rename`, with no lock acquisition anywhere in the module. A lock the other writer ignores protects only against a second MCP server instance — a case that barely exists — while manufacturing false confidence about the case that does. It also adds stale-lock recovery, which on Windows is its own bug farm. Honest LWW plus visible failure beats a lock that lies.

**Two edge cases that are also LWW instances:**

- **File or `.vscode/` does not exist.** `add_bookmark` creates both. If the extension is running with `bookmarks.mirrorDirty` set from an earlier failed write (`src/bookmarkStore.ts:20`, set at `:360`), both read paths short-circuit to a forced write of `workspaceState` before they ever look at the file (`src/bookmarkStore.ts:293`, `:319`) — clobbering whatever the server created. Document, do not defend.
- **Multi-root workspaces.** The server will happily write to any path its config names, but `resolveMirrorLocation` disables the mirror entirely for 0 or 2+ workspace folders (`src/bookmarkMirror.ts:22-34`). In a multi-root workspace the server's writes are **never adopted**. This belongs in the README configuration section (an AC), not just in this plan.

### D4 — Test strategy: `node:test` + `tsc`, zero VS Code

**Decided: `node --test` over compiled output. No `@vscode/test-electron`, no Mocha, no Jest.**

The extension's suite requires a real Extension Development Host (`package.json:77` → `node ./out/test/runTest.js`) and CI wraps it in `xvfb-run` (`.github/workflows/ci.yml:32`). None of that applies to a package with no `vscode` import. Node 20.x — the version CI pins (`.github/workflows/ci.yml:25`) — ships `node --test` in core, so the runner is a zero-dependency choice and `simplicity-first` says take it.

Layers:

- **Pure unit** — contract validation, version handling, the add-mutation function. Fixture JSON files under `mcp-server/test/fixtures/`: `v1-basic.json`, `v2-with-descriptions.json`, `v2-unknown-fields.json` (forward-compat), `v3-future.json`, `malformed.json`, `not-an-object.json`, `empty-collections.json`.
- **Real-filesystem integration** — `mirrorFile.ts` read/atomic-write against `fs.mkdtemp()` temp dirs. Asserts the temp file is gone after a successful rename and that a failed rename leaves the original intact.
- **Concurrency, deterministically** — inject a fake reader whose content *changes between the write and the verify re-read*, and assert the retry fires, then that a second failure produces the named error. **Do not put a real two-process race in the blocking CI path** — it is the single most flake-prone thing in this plan.
- **Drift gate** — Task 8.

### D5 — Distribution: build from source now, npm publish as a follow-up

**Decided: v1 of the server is built from source and wired by absolute path.** README documents `npm --prefix mcp-server ci && npm --prefix mcp-server run build`, then `{"command": "node", "args": ["<abs>/mcp-server/dist/index.js", "<abs workspace>"]}` — the canonical Claude Desktop shape (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:88`).

Ship the `bin` field and `files`/`prepublishOnly` scripts anyway so publishing is a one-step follow-up, but **do not publish under #52**. Publishing adds a name reservation, a release lane, and a versioning-compatibility question with the extension (`obsidian-brain` enforces lockstep `major.minor` between its server and plugin, `:50`) — all of which deserve their own issue. Surfaced as **Q1** below.

---

## Global Constraints

Every task inherits these.

1. **Never write to stdout.** `console.log` in any handler corrupts the JSON-RPC stream — the near-universal first bug in stdio servers (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:91`). All diagnostics go to `console.error`. Add an ESLint `no-console` rule allowing only `error`/`warn`.
2. **Every write is atomic** — temp file in the same directory, then rename with overwrite.
3. **The new entry the server constructs satisfies both the JSON Schema and `isStrictBookmarkData`'s rules** (`src/types.ts:80`) — carrying only known fields, so it passes `additionalProperties: false` on its own. **Unknown fields on entries the server did not touch are preserved verbatim, and the file as a whole is never re-validated against `additionalProperties: false`.** Doing so would reject the very forward-compat files the read path is required to accept. Schema validation on the write path is scoped to the constructed entry, never to the whole document. Verified by test, not by inspection.
4. **Reads tolerate unknown fields** and never reject on them.
5. **`version > 2` is a hard stop** — clear error, no read result, no write, ever.
6. **Missing file → empty result** for `list_bookmarks` (ENOENT-specific catch, the first-party `memory` server's pattern, `:58`, `:60`); **create-on-write** for `add_bookmark`.
7. **Malformed file → clear error, file left untouched.** Never overwrite with defaults — the explicit `infinitepi-io/bookmark-manager-mcp` anti-pattern (`:71`).
8. **No state between tool calls.** Re-read the file every time (`:72`).
9. **`list_bookmarks` never writes** — not even to migrate a v1 file to v2. It is annotated `readOnlyHint: true` and must behave like it.
10. **`add_bookmark` writes `version: 2`.** It is a write tool; normalizing to current on write matches what the extension does on its next persist and keeps a single output shape. `list_bookmarks` reads v1 and v2 without rewriting either.
11. **`uri` values are absolute** `vscode.Uri.toString()` strings, never workspace-relative (`src/types.ts:4`).
12. **Serialization matches the extension byte-for-byte**: `JSON.stringify(data, null, 2) + '\n'` (`serializeBookmarkData`, `src/bookmarkMirror.ts:14-16`). A trailing-newline mismatch would make every server write look like an external edit to the extension's hash comparison (`src/bookmarkStore.ts:308`, `:336`), causing needless adopt/write-back churn.
13. **No dependency on `../src`** — not in `imports`, not in `tsconfig` `paths`, not in the build.

---

## File Structure

```
mcp-server/
  package.json              NEW  type: module, bin, own deps, own scripts
  package-lock.json         NEW
  tsconfig.json             NEW  shared compilerOptions only (no include/rootDir)
  tsconfig.build.json       NEW  rootDir src, include src/**  -> dist/index.js
  tsconfig.test.json        NEW  rootDir ".",  include src+test -> dist/src, dist/test
  .eslintrc.json            NEW  no-console except error/warn
  scripts/copy-schema.mjs   NEW  ../schemas/bookmarks.schema.json -> dist/
  src/
    index.ts                NEW  bootstrap + stdio transport + tool registration
    config.ts               NEW  workspace path resolution, mirror path
    mirrorFile.ts           NEW  read (ENOENT -> undefined) + atomic write
    contract.ts             NEW  tolerant read validation, canonical write shape
    tools/list.ts           NEW  list_bookmarks
    tools/add.ts            NEW  add_bookmark (RMW + verify + retry)
  test/
    fixtures/                NEW  8 files, enumerated in Task 4 Step 1:
      v1-basic.json                 v1, no descriptions
      v2-with-descriptions.json     v2, descriptions present
      v2-unknown-fields.json        v2 + unknown fields — forward-compat
      v2-invariant-violations.json  strictly valid, invariants broken
      v3-future.json                unsupported version
      malformed.json                truncated JSON
      not-an-object.json            bare array
      empty-collections.json        no collections
    config.test.ts          NEW
    mirrorFile.test.ts      NEW  real temp-dir I/O
    contract.test.ts        NEW
    list.test.ts            NEW
    add.test.ts             NEW  includes the deterministic race test
    schemaDrift.test.ts     NEW  Task 8
.vscodeignore               NEW  keep mcp-server/ (and more) out of the VSIX
.gitignore                  MOD  mcp-server/node_modules, mcp-server/dist
.github/workflows/ci.yml    MOD  build + test mcp-server in the existing `test` job
README.md                   MOD  configuration guide (AC)
CHANGELOG.md                MOD  [Unreleased] entry
```

---

## Task 0: SDK smoke gate — settle the protocol-version question first

**This is a gate, not a deliverable. Time-box it. Nothing else starts until it passes.**

- [ ] **Step 1:** `mkdir mcp-server`, minimal `package.json` (`"type": "module"`), `npm i @modelcontextprotocol/sdk@^1.30.0 zod`.
- [ ] **Step 2:** Write ~30 lines: `new McpServer(...)`, one `registerTool('ping', ...)` returning a fixed string, `await server.connect(new StdioServerTransport())`. Use the v1 import paths (`@modelcontextprotocol/sdk/server/mcp.js`, `@modelcontextprotocol/sdk/server/stdio.js`) and the **bare Zod field object** `inputSchema` form — `{ a: z.string() }`, not `z.object({...})` (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:26`).
- [ ] **Step 3:** Register it in Claude Code's MCP config by absolute path and **call the tool for real.**

  Expected: the tool call returns. Confirms no protocol floor rejects v1.

  **If it fails to connect:** re-do steps 2-3 against the `@modelcontextprotocol/server` v2 idiom from `modelcontextprotocol.io/quickstart/server` (`:32`) — `import { McpServer } from "@modelcontextprotocol/server"`, `StdioServerTransport` from `@modelcontextprotocol/server/stdio`, `inputSchema: z.object({...})`, `zod@^4`. Record which generation won in the PR body. **Every later task is unchanged either way**; only `src/index.ts` and the `inputSchema` literal shape differ.
- [ ] **Step 4:** Delete the throwaway `ping` tool. Keep the dependency decision.

---

## Task 1: Package scaffold, build, packaging guard, CI

**Files:** `mcp-server/package.json`, `mcp-server/tsconfig.json`, `mcp-server/.eslintrc.json`, `mcp-server/scripts/copy-schema.mjs`, `.vscodeignore`, `.gitignore`, `.github/workflows/ci.yml`

**Shape** (per the `mcp-builder` reference, `docs/research/2026-08-08-mcp-server-bookmarks-companion.md:81`): `"type": "module"`, `target: ES2022`, `module`/`moduleResolution: Node16`, `strict: true`, `bin: { "bookmarks-plus-mcp": "dist/index.js" }`.

**The two-tsconfig split is mandatory — do not copy the root's single-config pattern.** The root extension uses `rootDir: "src"` + `include: ["src/**/*.ts"]` (`tsconfig.json:7`, `:14`). That pattern cannot serve both requirements here at once: the `bin` entry must land at exactly `dist/index.js` (which needs `rootDir: "src"`), but test files live outside `src/` and TypeScript refuses to compile files outside `rootDir`. One config gives you either a broken `bin` path or uncompilable tests.

| File | `rootDir` | `include` | `outDir` | Produces |
|---|---|---|---|---|
| `tsconfig.json` | — | — | — | shared `compilerOptions` only; both configs `extends` it |
| `tsconfig.build.json` | `"src"` | `["src/**/*.ts"]` | `dist` | `dist/index.js` ← the `bin` target |
| `tsconfig.test.json` | `"."` | `["src/**/*.ts", "test/**/*.ts"]` | `dist` | `dist/src/…` + `dist/test/…` |

Scripts:

- `build` = `tsc -p tsconfig.build.json && node scripts/copy-schema.mjs`
- `test` = `tsc -p tsconfig.test.json && node scripts/copy-schema.mjs && node --test dist/test`
- `lint` = `eslint src test --ext ts`

The two configs write into the same `dist/`, so `build` and `test` produce different layouts there. Make `build` and the `prepublishOnly` hook run `rimraf dist` (or `node -e "fs.rmSync('dist',{recursive:true,force:true})"`) first, so a publish never ships a `dist/` left over from a test run. Test fixtures are JSON, so `copy-schema.mjs` should also copy `test/fixtures/**` into `dist/test/fixtures/` — `tsc` does not copy non-TS files.

- [ ] **Step 1: Finish re-anchoring this plan's citations (do this first, before any code).**

  **The pull is already done and the bulk of this work is complete** — every behavior claim now cites a verified `src/*.ts:Lx` from the current tree, and the two debounce constants D3 depends on are confirmed (`src/bookmarkStore.ts:21` = 250, `src/extension.ts:26` = 150). What remains:

  - Sweep for any surviving `docs/superpowers/plans/2026-08-04-bookmark-descriptions-file-mirror.md:Lx` reference. Re-target **behavior claims** to `src/<file>.ts:Lx-Ly` and **design-rationale claims** (the LWW policy, the subordinate-mirror principle, the four mirror invariants, Q5's handoff) to `PR #54` / `#51`. CLAUDE.md is explicit that issues and PRs are durable and file paths are not.
  - **Decide the #51 plan file's fate and record it.** It closed with PR #54, so CLAUDE.md's lifecycle rule says delete it. If you keep it under the "lifecycle yields to persistence" carve-out, then *commit* it and state the keep-decision in the PR body. What is not acceptable is leaving this plan silently depending on an untracked file nobody decided about.

- [ ] **Step 2:** Write `package.json`, the **three** tsconfigs per the table above, and `.eslintrc.json` (with `"no-console": ["error", { "allow": ["error", "warn"] }]` — Global Constraint 1). Verify both configs compile before moving on: `npx tsc -p tsconfig.build.json --noEmit` and `npx tsc -p tsconfig.test.json --noEmit`.
- [ ] **Step 3:** Write `scripts/copy-schema.mjs` — copies `../schemas/bookmarks.schema.json` into `dist/`, and `test/fixtures/**` into `dist/test/fixtures/` when that directory exists. Fail loudly if the schema source is missing.
- [ ] **Step 4:** Add `mcp-server/node_modules/` and `mcp-server/dist/` to `.gitignore`.
- [ ] **Step 5: Create `.vscodeignore`.**

  There is **no `.vscodeignore` in this repo today** (verified: glob over the repo root returned no match, 2026-08-08). `unverified:` exactly what `vsce package --no-dependencies` (`package.json:79`) includes without one — but adding a second `node_modules` tree and a second `dist/` at the repo root is unambiguously the wrong direction for VSIX size.

  Verify empirically before and after: run `npx vsce ls` on `main`, record the output, add `.vscodeignore` covering at minimum `mcp-server/**`, `src/**`, `out/**`, `test/**`, `docs/**`, `.vscode-test/**`, `**/*.map`, then re-run `npx vsce ls` and diff. **Do not remove anything `contributes` references** — notably `schemas/bookmarks.schema.json` (used by `contributes.jsonValidation`) and `images/icon.png` (`package.json:14`) must stay in the package.
- [ ] **Step 6: Wire CI into the existing `test` job.**

  Add steps to the existing `test` job in `.github/workflows/ci.yml:13-32` — **not a new job**. A new job would not be a required status check until branch protection is updated, so the suite would run and block nothing. Appended steps (no `xvfb` needed; these do not launch VS Code):

  ```yaml
      - name: Install mcp-server dependencies
        working-directory: mcp-server
        run: npm ci

      - name: Lint mcp-server
        working-directory: mcp-server
        run: npm run lint

      - name: Test mcp-server
        working-directory: mcp-server
        run: npm test
  ```

  Use `working-directory:`, **not** `npm --prefix mcp-server` — `--prefix` behavior with `ci` varies across npm versions and can resolve the install target somewhere other than `mcp-server/node_modules`, which would fail Step 7's green-CI checkpoint confusingly before any tool code exists.

  Note `cache: npm` at `:26-27` keys off the root lockfile only; the `mcp-server` install will be uncached. Acceptable for a small dependency tree — do not add cache complexity now.

  **`.github/workflows/publish.yml` is intentionally not modified**, and is deliberately absent from this plan's `touches:` list. `mcp-server/` is not part of the VSIX artifact — it is excluded by the `.vscodeignore` added in Step 5, and it is not referenced from the root `package.json`, so it cannot affect the extension bundle. Its quality is gated by `ci.yml` on every PR, not by the VSIX release pipeline. This does mean a broken `mcp-server` would not block a VSIX release; that is the correct tradeoff while D5 defers npm-publishing the server. **If Q1 lands as "publish to npm", revisit this** — a published server needs its own release gate, and that is the point at which `publish.yml` (or a sibling workflow) comes into scope.
- [ ] **Step 7:** Commit. Confirm CI is green with an empty test directory before writing any tool logic.

---

## Task 2: `config.ts` — workspace path resolution

**Produces:** `resolveConfig(argv: string[], env: NodeJS.ProcessEnv): ServerConfig` where `ServerConfig = { workspacePath: string; mirrorPath: string; verifyDelayMs: number }`.

Precedence: positional `argv[2]` → `BOOKMARKS_MCP_WORKSPACE` env var → **fatal error to stderr and non-zero exit**. There is no auto-discovery (issue #52: "Workspace path supplied via MCP server config"). Both forms are attested in the wild — `obsidian-brain` uses an env var (`VAULT_PATH`), the canonical quickstart uses `args` (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:88`, `:90`); supporting both costs three lines.

`mirrorPath = path.join(workspacePath, '.vscode', 'bookmarks.json')` — the literal must match the extension's `MIRROR_RELATIVE_PATH` (`src/bookmarkMirror.ts:5`). `verifyDelayMs` from `BOOKMARKS_MCP_VERIFY_DELAY_MS`, default `400`.

- [ ] **Step 1:** Tests: positional wins over env; env used when no positional; neither → throws a named error; relative paths are resolved to absolute; `verifyDelayMs` parses, defaults, and accepts `0`; a non-numeric value is rejected rather than silently becoming `NaN`.
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** Run — pass. **Step 5:** Commit.

---

## Task 3: `mirrorFile.ts` — read and atomic write

**Produces:** `readMirror(path): Promise<string | undefined>` and `writeMirrorAtomic(path, content): Promise<void>`.

`readMirror` catches **`ENOENT` specifically** and returns `undefined`; any other error rethrows — the first-party `memory` server's pattern (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:58`, `:60`). It does **not** parse or validate; that is `contract.ts`.

`writeMirrorAtomic` mirrors `WorkspaceMirrorFile.write` (`src/bookmarkMirror.ts`): `mkdir -p` the directory, write `bookmarks.json.<uuid>.tmp` in that same directory, `rename` over the target, and on rename failure best-effort-unlink the temp file while **rethrowing the original error**.

- [ ] **Step 1:** Tests against `fs.mkdtemp()` temp dirs — missing file → `undefined`; existing file → exact contents; write creates a missing `.vscode/`; after a successful write no `*.tmp` remains; content round-trips byte-for-byte including the trailing newline; a directory that cannot be created surfaces the real error.
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** Run — pass. **Step 5:** Commit.

---

## Task 4: `contract.ts` — tolerant reads, canonical writes

This task implements the "must be strictly valid; may be invariant-imperfect" contract. **Re-read that section before starting.**

**Produces:**

- `parseMirror(raw: string | undefined): ParseResult` — `{ kind: 'empty' }` | `{ kind: 'ok'; data: BookmarkData }` | `{ kind: 'error'; message: string }`.
- `MAX_SUPPORTED_VERSION = 2`.
- `toCanonicalV2(data): BookmarkData` — the write-side shape.
- `serialize(data): string` — `JSON.stringify(data, null, 2) + '\n'` (Global Constraint 12).

`parseMirror` is **tolerant**: JSON parse failure → `error`; non-object → `error`; `version` not an integer, or `< 1`, or `> 2` → `error` whose message for the `> 2` case explicitly says the file was written by a newer extension and the MCP server needs upgrading; items/collections not arrays → `error`; an individual entry missing a required field or with a wrong type → `error` (matching the extension's all-or-nothing `isStrictBookmarkData` gate rather than silently dropping the user's data). **Unknown properties on any object are preserved and never cause rejection.**

- [ ] **Step 1: Write the fixtures** under `mcp-server/test/fixtures/`:
  - `v1-basic.json` — `version: 1`, two items, one collection, no `description` anywhere.
  - `v2-with-descriptions.json` — `version: 2`, descriptions on an item and a collection.
  - `v2-unknown-fields.json` — `version: 2` plus a `"color": "red"` on one item and a top-level `"generator": "some-other-tool"`. **This is the forward-compat fixture.**
  - `v3-future.json` — `version: 3`.
  - `malformed.json` — truncated JSON.
  - `not-an-object.json` — a bare JSON array.
  - `v2-invariant-violations.json` — dangling `collectionId`, duplicate `(uri, collectionId)`, non-contiguous `order`. Strictly valid; the extension repairs it.
- [ ] **Step 2: Write the failing tests.** Named tests that must exist:
  - `'undefined input yields an empty result, not an error'`
  - `'a v1 file parses and reports version 1'`
  - `'a v2 file with unknown fields parses and preserves them'` ← the AC's forward-compat requirement, and the check that guards against ajv-with-additionalProperties-false creeping in
  - `'a v3 file is rejected with a message telling the user to upgrade the MCP server'`
  - `'malformed JSON is rejected without throwing'`
  - `'a bare array is rejected'`
  - `'an item with a numeric uri rejects the whole payload'`
  - `'invariant violations parse successfully — repair is the extension\'s job'`
  - `'serialize output ends with exactly one newline'`
  - `'serialize round-trips a parsed fixture byte-for-byte'`
- [ ] **Step 3:** Run — fail. **Step 4:** Implement. **Step 5:** Run — pass. **Step 6:** Commit.

---

## Task 5: `list_bookmarks`

**Produces:** `createListHandler(config, deps)` and the tool registration metadata.

Input schema: no required parameters. The workspace path comes from server config, not from the caller (issue #52: "no auto-discovery"). Consider an optional `collectionId` filter — **out of scope for v1**, since the whole payload is small and cross-workspace search is explicitly out of scope.

Annotations per the `mcp-builder` reference (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:81`): `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

Output: collections (`id`, `name`, `order`, `description`) and items (`uri`, `type`, `collectionId`, `description`, `order`, `id`), plus the file's `version` and the resolved path. Prose framing matters — Claude should be told these are the user's *areas of interest*, which is the point of the issue.

- [ ] **Step 1: Write the failing tests.** Named tests:
  - `'a missing file returns an empty result, not an error'`
  - `'a v1 fixture lists items with no descriptions'`
  - `'a v2 fixture lists descriptions on items and collections'`
  - `'a v1 fixture is NOT rewritten to v2 by a list call'` ← asserts the file's mtime and bytes are unchanged after `list_bookmarks`. `readOnlyHint: true` must be true in fact, not just in the annotation.
  - `'a malformed file returns a clear tool error and leaves the file untouched'`
  - `'a v3 file returns the upgrade-the-server error'`
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** Run — pass. **Step 5:** Commit.

---

## Task 6: `add_bookmark` — read-modify-write with verification

The most subtle task. **Re-read decision D3 before starting.**

**Produces:** `createAddHandler(config, deps)` where `deps` injects `readMirror`, `writeMirrorAtomic`, a clock/sleep, and a uuid factory — all four so the race test is deterministic.

Input: `uri` (required, absolute), `type` (`'file' | 'folder'`, required), `collectionName` or `collectionId` (optional), `description` (optional). Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false` (`docs/research/2026-08-08-mcp-server-bookmarks-companion.md:81`).

**Algorithm:**

1. Read + `parseMirror`. `error` → return the tool error, **write nothing**. `empty` → start from `{ version: 2, items: [], collections: [] }`.
2. Resolve the target collection. Unknown `collectionId` → tool error listing the valid ones (do **not** silently write a dangling reference — the extension would ungroup it, producing a confusingly different result from what Claude was told). `collectionName` that does not exist → **Q2 below**; recommended default is a clear error, not implicit creation.
3. Reject an exact duplicate `(uri, collectionId)` with a clear message. The extension throws `DuplicateBookmarkError` before it persists (`src/bookmarkStore.ts:127-128`), so no write happens on the duplicate path there either.
4. Build the new item: `id` = fresh uuid, **`order` = the count of existing items sharing the same `collectionId`** — not `max(order) + 1`. The extension computes `const siblingCount = this.data.items.filter((i) => i.collectionId === collectionId).length;` then `order: siblingCount` (`src/bookmarkStore.ts:130`, `:136`). The two formulas agree on any contiguous zero-based file (which adoption guarantees), but issue #52 asks for "the same validation/dedup rules as the extension" — match it exactly rather than coincidentally. `description` trimmed with empty → omitted, matching `normalizeDescription` (`src/types.ts`, verified in the pulled tree). Append; leave every other entry byte-identical, unknown fields included.
5. `toCanonicalV2` → `serialize` → `writeMirrorAtomic`.
6. **Verify:** if `verifyDelayMs > 0`, sleep, re-read, re-parse, confirm the new `id` is present.
7. Absent → repeat steps 1-6 **once**.
8. Still absent → tool error: *"the bookmark was written but did not survive — VS Code is probably running and overwrote the file. Retry, or add it from the Bookmarks view."*
9. Present (or verification disabled) → success, reporting the id, resolved collection, and the file path.

- [ ] **Step 1: Write the failing tests.** Named tests:
  - `'adding to a missing file creates .vscode/ and the file with version 2'`
  - `'adding to a v1 file writes version 2 and preserves existing items'`
  - `'unknown fields on untouched items survive the write'` ← the forward-compat write guarantee
  - `'a new item gets order = max sibling order + 1'`
  - `'an exact duplicate (uri, collectionId) is rejected without writing'`
  - `'an unknown collectionId is rejected and lists the valid collections'`
  - `'a whitespace-only description is omitted, not stored as an empty string'`
  - `'a malformed file is never overwritten'`
  - `'the newly constructed item satisfies the JSON Schema'` — ajv against the **single new entry**, not the whole document. Validating the whole file here would fail on the preserved `color: "red"` from `v2-unknown-fields.json`, which is correct behavior, not a defect (Global Constraint 3).
  - `'a write that does not survive verification is retried exactly once'` ← inject a reader that returns pre-write content on the first verify, then post-write content
  - `'a write that fails verification twice returns the VS Code-overwrote error'`
  - `'verifyDelayMs = 0 skips verification entirely'`
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** Run — pass. **Step 5:** Commit.

---

## Task 7: `index.ts` — bootstrap and registration

- [ ] **Step 1:** Test that `createServer(config)` registers exactly `list_bookmarks` and `add_bookmark` with the expected annotations, without connecting a transport.
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement: parse config (fatal → `console.error` + `process.exit(1)`), build the server, register both tools with `registerTool` (never the deprecated `server.tool()` / `setRequestHandler` style, `docs/research/2026-08-08-mcp-server-bookmarks-companion.md:82`), connect the stdio transport. Add `#!/usr/bin/env node` for the `bin` entry.
- [ ] **Step 4:** Grep the whole of `mcp-server/src` for `console.log` — expect zero hits. Lint enforces it; check anyway.
- [ ] **Step 5:** Run — pass. **Step 6:** Commit.

---

## Task 8: Schema drift gate

The `isValidBookmarkCollection` divergence documented in the contract section proves this is needed.

- [ ] **Step 1:** Write `schemaDrift.test.ts` asserting:
  - `mcp-server/dist/bookmarks.schema.json` is byte-identical to `schemas/bookmarks.schema.json` (fails if the copy step is skipped or the authored file changes without a rebuild).
  - The schema's `properties.version.maximum` equals `MAX_SUPPORTED_VERSION` in `contract.ts`. **This is the important one** — if a future PR bumps the extension to v3 without touching the server, this test fails and names the reason.
  - Every fixture the tests treat as valid also validates against the schema via ajv (excluding `v2-unknown-fields.json`, which is *expected* to fail ajv because of `additionalProperties: false` — assert that expected failure explicitly, with a comment pointing at the read-tolerance rationale, so nobody "fixes" it later).
- [ ] **Step 2:** Run — fail. **Step 3:** Make it pass. **Step 4:** Commit.

---

## Task 9: README configuration guide + CHANGELOG

Issue #52 AC: "README section with Claude Desktop / Claude Code configuration instructions."

- [ ] **Step 1:** Add a `## Using bookmarks from Claude (MCP server)` section to `README.md`, immediately after the existing `## The .vscode/bookmarks.json mirror` section in `README.md` — that section already names "an MCP server" as the anticipated consumer, so this is its natural continuation.

  Must cover:
  - Build steps, as two lines the reader runs from the repo root — `cd mcp-server`, then `npm ci && npm run build`. Do not document the `npm --prefix` form; its `ci` behavior varies across npm versions (same reason Task 1 Step 6 uses `working-directory:`).
  - Claude Desktop `claude_desktop_config.json` block and the Claude Code equivalent, both with `"command": "node"` and an **absolute** path plus the workspace path argument.
  - What each tool does, and that `add_bookmark` cannot edit or remove (issue #52 Out of Scope).
  - **Limitations — do not soften these:**
    - Last write wins. If VS Code is running and you change bookmarks at the same moment, one change is lost. `add_bookmark` verifies its write and tells you when it did not survive; it cannot prevent it. (D3)
    - Single-folder workspaces only — in a multi-root workspace the extension disables the mirror, so the server's writes are never picked up. (D3, `src/bookmarkMirror.ts:22-34`)
    - One workspace per server entry. Cross-workspace search in one call is out of scope; configure multiple server entries.
    - The server reads the file fresh on every call; there are no push notifications.
- [ ] **Step 2:** Add a `[Unreleased] / Added` CHANGELOG entry. **Do not bump `package.json:5`** — this repo stamps the version at release time (commit `29301b1`), which is also how #51 / PR #54 handled it.
- [ ] **Step 3:** Commit.

---

## Task 10: Manual end-to-end verification

Not automatable, and the only thing that proves the deliverable.

- [ ] Build the server; register it in Claude Code against a real single-root workspace.
- [ ] With VS Code **closed**: `list_bookmarks` on a workspace with no `.vscode/bookmarks.json` → empty result, no error. `add_bookmark` → file created; open VS Code and confirm the bookmark appears in the tree.
- [ ] With VS Code **open**: `add_bookmark` → the bookmark appears in the Bookmarks view within a second, with its description on hover, **without any manual refresh** (this exercises the extension's watcher path end-to-end).
- [ ] Hand-corrupt `.vscode/bookmarks.json`; `list_bookmarks` → clear error; confirm the file is **still corrupt** afterwards (never overwritten).
- [ ] Hand-edit `version` to `3`; both tools → the upgrade-the-server error; file untouched.
- [ ] Check the "Bookmarks Plus" output channel for unexpected reject/normalize churn after a server write — repeated normalize notes would mean the server is emitting invariant-violating data more often than intended.

---

## Open Questions

Each has a stated default this plan already implements. None block implementation.

- **Q1 — Publish `mcp-server` to npm?** Default: **no** for #52 (D5). Publishing enables `npx bookmarks-plus-mcp`, which is a materially better config story, but adds a name reservation, a second release lane, and a server-vs-extension version-compatibility policy (`obsidian-brain` enforces lockstep `major.minor` with a preflight gate, `docs/research/2026-08-08-mcp-server-bookmarks-companion.md:50`). Recommend a follow-up issue.
- **Q2 — Should `add_bookmark` create a collection that does not exist?** Default: **no** — return an error listing the valid collections. Auto-creating means Claude can silently proliferate collections from typos, and collection management is not in #52's scope. A `create_collection` tool is a clean follow-up if the friction proves real.
- **Q3 — Is `BOOKMARKS_MCP_VERIFY_DELAY_MS = 400` the right default?** It is 250 + 150, derived from constants in a package this server deliberately does not depend on (D3). It could be too short on a loaded machine or a network drive, and it adds ~400 ms to every `add_bookmark`. Default: ship 400, document the derivation as a heuristic, revisit if the "did not survive" error shows up in practice.
- **Q4 — Should `list_bookmarks` report whether each `uri` still exists on disk?** The tree view already shows broken bookmarks as `missing`. Claude would arguably benefit from the same signal. Default: **no** — it turns a single file read into N stat calls and was not requested. Cheap to add later.
- **Q5 — Should the server expose bookmarks as MCP *resources* as well as tools?** Resources would let a client subscribe/browse rather than call a tool. Default: **tools only**, exactly as issue #52 specifies. Revisit only if a real client wants it.

---

## Follow-up issues to open

1. **Publish `bookmarks-plus-mcp` to npm** (Q1) — including the extension/server version-compatibility policy.
2. **`.vscodeignore` audit** — Task 1 Step 5 adds one because #52 makes its absence materially worse, but the VSIX has apparently been shipping `src/`, `out/`, and `docs/` since 1.0.0. Worth a dedicated look at what 1.0.0 actually shipped.
3. **Multi-root mirror support** — already identified as a follow-up during #51 / PR #54, deferred there by the single-root decision now shipped in `src/bookmarkMirror.ts:22-34`. It is now a *user-visible MCP limitation*, not just an extension gap, which raises its priority.

---

## Self-Review

**1. Acceptance-criteria coverage** — every criterion in issue #52 maps to at least one task:

| Acceptance criterion | Task |
|---|---|
| New `mcp-server/` package with `list_bookmarks` and `add_bookmark` | 1, 5, 6, 7 |
| Validation against `isValidBookmarkData` / schema version handling | 4 (tolerant read, `version > 2` hard stop), 8 (drift gate) |
| README configuration guide | 9 |
| Build/packaging for `mcp-server/` (own `package.json`) | 1 |
| Tests against fixture `bookmarks.json` files, including v1 forward-compat | 4 (`v1-basic.json`, `v2-unknown-fields.json`), 5, 6 |
| Workspace path from server config, no auto-discovery | 2 |
| Missing file → empty result; malformed → clear error | 4, 5 (named tests), Global Constraints 6-7 |
| Same validation/dedup rules as the extension | 6 (duplicate `(uri, collectionId)` rejection), plus the contract section's explanation of what the extension repairs |
| Out of scope: edit/remove, push notifications, cross-workspace search | Nothing in this plan implements any of the three; the README limitations section states all three |

**2. Router-brief decisions, all resolved:** SDK generation → D1 (v1.x, with an empirical gate for the one `unverified:` item). Package layout → D2 (standalone; answers #51's Q5 explicitly). Concurrent writes → D3 (LWW + verify + one retry + named error; locks rejected with reasons). Test strategy → D4 (`node --test`, no `@vscode/test-electron`).

**3. Citation check.** After the router's `git pull --ff-only`, every behavior claim in this plan was re-verified against the real post-#54 tree and now carries a genuine `src/*.ts:Lx` anchor — including the two constants D3's default delay depends on (`src/bookmarkStore.ts:21` = 250, `src/extension.ts:26` = 150, both confirmed, no longer `unverified:`) and the `order` formula (`src/bookmarkStore.ts:130`, `:136`, which corrected this plan's original `max(order)+1` to the extension's actual `siblingCount`). README claims cite `README.md` by section. The research report is cited by line range throughout. Local files #54 did not change (`package.json`, `tsconfig.json`, `.github/workflows/ci.yml`) are cited by `file:line`.

The untracked `docs/superpowers/plans/2026-08-04-bookmark-descriptions-file-mirror.md` is no longer cited by line anywhere. It survives only as the attributed source of the Q5 quotation, where the durable anchor is stated as #51 / PR #54. **Task 1 Step 1 remains** to sweep for any reference reintroduced during implementation and to decide that file's keep-or-delete fate.

One claim is explicitly marked `unverified:` — what `vsce package --no-dependencies` includes in the absence of a `.vscodeignore` (Task 1 Step 5), with `npx vsce ls` prescribed as the empirical check rather than a guess.

**6. Post-review corrections applied** (project-reviewer, 2026-08-08): Global Constraint 3 no longer contradicts Task 6's unknown-fields test — write-side schema validation is scoped to the newly constructed entry, never the whole document; the two-tsconfig split (`tsconfig.build.json` / `tsconfig.test.json`) is specified explicitly because the root's single `rootDir: "src"` pattern cannot serve both a `dist/index.js` bin target and out-of-`src` test files; `publish.yml`'s deliberate exclusion is stated with its rationale and its Q1 revisit trigger; `order` uses `siblingCount`; the fixture list is complete at 8; and the stale-checkout warning reflects that the pull is done.

**4. The one thing most likely to be got wrong during implementation:** using ajv against the bundled schema for the **read** path. It is the obvious move, the schema is right there, and it silently breaks the forward-compatibility AC because the schema sets `additionalProperties: false` while the published contract promises additive fields. Task 4's `'a v2 file with unknown fields parses and preserves them'` and Task 8's deliberately-expected ajv failure on `v2-unknown-fields.json` both exist to catch it. Do not "fix" that expected failure.

**5. Placeholder scan** — no `TBD`, `TODO`, or "handle appropriately" strings. Every task states its produced interfaces and its named tests. Manual steps (Task 0 Step 3, Task 10) list concrete, checkable observations.
