# Research: MCP server exposing VS Code bookmarks (issue #52)

## Idea

Build a Node/TypeScript `mcp-server/` package in the `vscode-bookmarks-plus` repo that exposes two MCP tools — `list_bookmarks` and `add_bookmark` — reading and writing `.vscode/bookmarks.json` directly (no live VS Code instance), configured via Claude Desktop/Code's own MCP server config with no auto-discovery.

## Requirements

1. Minimal stdio MCP server with 1-2 tools, using the official TypeScript SDK — server setup, tool schema definition, package.json/build shape, and how Claude Desktop/Code config points at it.
2. Prior art for file-backed MCP servers (local JSON data source): validation, error handling for malformed data, file-watching if any.
3. Precedent for a VS Code extension (or comparable editor extension) shipping a companion MCP server in the **same repo** vs. a fully separate repo, and the packaging structure used.
4. Documented pitfalls for a file-backed MCP server reading data that's concurrently written by another live process (here: the VS Code extension itself) — race conditions, stale reads, and how prior art handles (or fails to handle) them.

## Search axes used

- **Direct synonyms** — "MCP TypeScript SDK", "stdio server", "McpServer", "registerTool"
- **Problem-shape synonyms** — "file-backed MCP server", "JSON storage MCP", "local vault MCP server"
- **Adjacent domains** — browser-bookmark MCP servers (Chrome/Brave/Edge), note-taking app companion plugins (Obsidian vault + plugin pairs), the official first-party "memory" knowledge-graph server
- **Vendor-specific phrasing** — modelcontextprotocol.io quickstart/docs, Anthropic's `anthropics/skills` `mcp-builder` reference, VS Code's own `extension-guides/ai/mcp`
- **Negative axes** — MCP servers that require a *live* editor/browser process (HTTP/native-messaging bridges) are architecturally the opposite of what issue #52 asks for (file-only, works with the editor closed) and are noted as contrast, not candidates

## Important finding: two live SDK generations, not one

The official TypeScript SDK is mid-transition. Both generations are simultaneously live as of this research (fetched 2026-08-08); the planner needs to pick, this report doesn't:

- **`@modelcontextprotocol/sdk` v1.30.0** (registry: `https://registry.npmjs.org/@modelcontextprotocol/sdk/latest`, fetched 2026-08-08) — the classic, widely-adopted API: `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`, `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"`, `new McpServer(...)`, `server.registerTool(name, config, handler)`, `await server.connect(new StdioServerTransport())`. `inputSchema` here is a **bare object of Zod fields**, e.g. `{ a: z.number() }` — *not* `z.object({...})`.
  - Confirmed still in first-party use on `main`: `modelcontextprotocol/servers` `src/memory/index.ts` (commit `76d64c822f5125032f89eb71dbdb94e42b434821`, https://github.com/modelcontextprotocol/servers/blob/76d64c822f5125032f89eb71dbdb94e42b434821/src/memory/index.ts) imports exactly this v1.x API.
  - Also pinned by Anthropic's own server-building guidance: `anthropics/skills` `skills/mcp-builder/reference/node_mcp_server.md` (commit `f17010c9bb483898c1d9c9f42dde2b3a98889434`, https://github.com/anthropics/skills/blob/f17010c9bb483898c1d9c9f42dde2b3a98889434/skills/mcp-builder/reference/node_mcp_server.md) — pins `@modelcontextprotocol/sdk: ^1.6.1`, and explicitly says use `registerTool`/`registerResource`/`registerPrompt`, not the older `server.tool()` / manual `setRequestHandler`.
  - Also the pattern used by `infinitepi-io/bookmark-manager-mcp` (`@modelcontextprotocol/sdk: ^1.13.2`) and `wickes1/chromium-bookmarks-mcp` (`@modelcontextprotocol/sdk: ^1.29.0`) — see below.
- **`@modelcontextprotocol/server` v2.0.0** (registry: `https://registry.npmjs.org/@modelcontextprotocol/server/latest`, fetched 2026-08-08; depends on `@modelcontextprotocol/core@2.0.0` and `zod@^4.2.0`) — this is what the *current* official quickstart teaches (spec version 2026-07-28). Two distinct shapes were found for it, from two different official pages, and they are **not the same idiom** — report both verbatim rather than flattening:
  - `typescript-sdk/docs/get-started/first-server.md` (repo `modelcontextprotocol/typescript-sdk`, commit `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`, fetched 2026-08-08 via WebFetch of https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md) — factory pattern: `import { McpServer } from '@modelcontextprotocol/server'`, `import { serveStdio } from '@modelcontextprotocol/server/stdio'`, `import * as z from 'zod/v4'`, `inputSchema: z.object({...})`, and `void serveStdio(createServer)` where `createServer` returns a fresh `McpServer` per connection.
  - `modelcontextprotocol.io/quickstart/server` (TypeScript tab, fetched 2026-08-08) — a *different* v2 idiom: `import { McpServer } from "@modelcontextprotocol/server"`, `import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"`, `import { z } from "zod"`, `server.registerTool(name, { description, inputSchema: z.object({...}) }, handler)`, then `const transport = new StdioServerTransport(); await server.connect(transport);` — i.e. the v1-style `connect(transport)` call, but on the v2 package.
- **`unverified:`** whether Claude Desktop or Claude Code impose a minimum MCP protocol-version floor that would force one generation over the other for this use case. Not found in the sources fetched; flagged in Open Questions rather than guessed at.

## Shortlist (ranked by expected value)

### 1. `wickes1/chromium-bookmarks-mcp` — same-repo monorepo: browser extension + independently-published companion MCP server

- **URL:** https://github.com/wickes1/chromium-bookmarks-mcp (commit `66e045c5436649b00c8df8b1a97220e1772be1fd`, fetched 2026-08-08)
- **Relevance:** addresses requirement 3 directly — this is the closest same-repo precedent found. Root `package.json` declares `"workspaces": ["packages/*", "apps/*"]` (Bun workspaces, but npm-workspace-compatible syntax) with `apps/extension/` (the browser extension, WXT+TypeScript) and `apps/mcp-server/` (the MCP server) as siblings, plus a shared `packages/shared/` for cross-package types. `apps/mcp-server/package.json` is its own independently-versioned, independently-published unit: `"name": "chromium-bookmarks-mcp"`, `"bin": {"chromium-bookmarks-mcp": "dist/index.js"}`, its own `build`/`prepublishOnly` scripts, and a runtime `dependencies` block (`@modelcontextprotocol/sdk: ^1.29.0`, `zod: ^3.24.0`) separate from the extension's deps. The shared-types package is a `devDependency` only (`workspace:*`) because it's inlined into `dist` at build time — a real footgun the maintainers hit and fixed (see the cited commit message: shared package was wrongly left in runtime `dependencies`, causing `npm install` to 404 on the private workspace package).
- **Maturity:** actively maintained, pushed 2026-06-17, published to npm as `chromium-bookmarks-mcp`, Chrome Web Store listed, MIT license.
- **Worth borrowing:** the workspace layout (`apps/<extension>`, `apps/mcp-server`, optional `packages/shared`) and the specific lesson in the cited commit — a shared/internal package must be a **devDependency**, not a runtime dependency, if it's bundled into the published server's `dist` at build time.
- **What to avoid:** this project's core architecture — talking to a *live* browser via native messaging + localhost HTTP bridge rather than reading a file — is the opposite of what issue #52 wants (server must work with VS Code closed, "no auto-discovery... there isn't one outside VS Code"). Don't borrow the live-bridge transport pattern, only the repo/package layout.
- **Lift effort:** study-only (structure and lesson, not code).

### 2. `sweir1/obsidian-brain` + `sweir1/obsidian-brain-plugin` — separate-repo companion pair with lockstep versioning

- **URL:** https://github.com/sweir1/obsidian-brain (commit `bcc97e2406232cb552e55f5432e8b8610a811ba7`, fetched 2026-08-08) and https://github.com/sweir1/obsidian-brain-plugin (commit `633cc225ee882e5a4cc92d5b44b70e750b22493e`, fetched 2026-08-08)
- **Relevance:** addresses requirement 3 (contrasting pattern: separate repos, not a monorepo) and directly informs requirement 4. The MCP server ("obsidian-brain") is designed to work **without the editor running at all** — "unlike Local REST API-based servers, obsidian-brain reads `.md` files directly from disk. Obsidian can be closed; your vault is just a folder." — exactly the constraint issue #52 states ("there isn't one [workspace] outside VS Code"). The optional plugin only adds tools that need *live* editor state (`active_note`, `dataview_query`) unavailable from disk; core file-reading tools work with or without it.
- **Maturity:** obsidian-brain is actively released (v1.7.24, 2026-05-16 per its own changelog), Apache-2.0, single maintainer. Plugin repo release-commit (`633cc22`) states explicitly: "Paired bump to match obsidian-brain server v1.7.0... Required by the server's check-plugin preflight gate (major.minor must match)."
- **Worth borrowing:** the lockstep major.minor versioning discipline between the two repos (with an enforced preflight compatibility gate), and the design principle of splitting into "disk-readable, works standalone" tools vs. "live-editor-only, degrades gracefully when absent" tools — directly applicable to how `list_bookmarks`/`add_bookmark` should behave when the extension isn't running (per issue #52's file-mirror design, this is already the intended shape, so this confirms rather than changes anything).
- **What to avoid:** obsidian-brain's data layer is a SQLite index built by indexing `.md` files with a `chokidar` file watcher (`docs/watching.md`) — this is a heavier design than issue #52 needs (poll/re-read on each tool call is explicitly acceptable for v1 per the issue's Out of Scope). Don't over-borrow the watcher/index machinery; its debounce values (3s per-file, 60s graph-wide) and troubleshooting doc are useful only as evidence of the underlying problem class (see Pitfalls below), not as an architecture to copy.
- **Lift effort:** study-only (versioning convention + design principle).

### 3. `modelcontextprotocol/servers` `src/memory` — first-party file-backed MCP server (JSON Lines knowledge graph)

- **URL:** https://github.com/modelcontextprotocol/servers/blob/76d64c822f5125032f89eb71dbdb94e42b434821/src/memory/index.ts (commit `76d64c822f5125032f89eb71dbdb94e42b434821`, fetched 2026-08-08)
- **Relevance:** addresses requirement 2 (validation/error-handling shape) and is the closest first-party analogue to "missing file → empty result" from issue #52's acceptance criteria. `loadGraph()` catches `ENOENT` specifically and returns an empty `{entities: [], relations: []}` structure; any other error is rethrown rather than swallowed.
- **Maturity:** first-party (`modelcontextprotocol` org), actively maintained, `main` branch, MIT-equivalent (org license).
- **Worth borrowing:** the `ENOENT`-specific catch (`error instanceof Error && 'code' in error && error.code === "ENOENT"`) as the pattern for "missing file → empty result, not an error" — matches issue #52's AC almost exactly. Also the backward-compat migration shim (`ensureMemoryFilePath`, renaming a legacy `memory.json` to `memory.jsonl` on first run) as *a* precedent for file-level migration handling — see the explicit caveat below on why this is a weaker match for issue #52's actual need.
- **What to avoid:** `saveGraph()` does a full unlocked read-modify-write-whole-file cycle (`loadGraph()` → mutate in memory → `fs.writeFile()`) with **no file lock, no atomic rename, no optimistic-concurrency check**. This is the same category of race issue #52's `add_bookmark` needs to worry about (VS Code extension writing the same file concurrently), and the first-party reference implementation does not solve it — see "No prior art found" below.
- **Lift effort:** port-one-module (the ENOENT-catch pattern is small and directly reusable as a description of intended behavior, not literal code given the different SDK/language shape of `BookmarkStore`).

### 4. `infinitepi-io/bookmark-manager-mcp` — file-backed MCP bookmark server (anti-pattern reference)

- **URL:** https://github.com/infinitepi-io/bookmark-manager-mcp/blob/main/src/index.ts (commit `01dee315a96235ba1214dedc1fd0d1e3a10e10f6`, fetched 2026-08-08)
- **Relevance:** addresses requirement 2, but mainly as a **negative example** — closest domain match (bookmark JSON file + MCP server) doing several things issue #52 explicitly wants avoided.
- **Maturity:** small single-maintainer project, MseeP-verified, Apache-2.0, `@modelcontextprotocol/sdk: ^1.13.2`.
- **Worth borrowing:** nothing structural; useful only as a concrete "don't do this" citation.
- **What to avoid (concrete anti-patterns):**
  1. `loadBookmarks()`'s `catch` block treats **any** read failure — not just "file missing" — as "no bookmarks yet," and immediately overwrites the file with hardcoded defaults (`await saveBookmarks(defaultBookmarks)`). A malformed/corrupted `bookmarks.json` is silently destroyed and replaced. Issue #52's AC explicitly wants the opposite: "malformed file → clear error (not a crash)."
  2. Bookmarks are loaded into an **in-memory array once at module load** (`const bookmarks: Bookmark[] = await loadBookmarks()`) and then mutated/persisted from that stale in-memory copy on every `add` call. If bookmarks.json changes externally between tool calls (exactly the situation with the VS Code extension writing the file), the next `add` overwrites the external change with the stale in-memory state plus the new bookmark. This is a direct, concrete instance of the stale-read pitfall in requirement 4.
  3. No dedup logic on add — pushes unconditionally, unlike issue #52's explicit dedup-by-uri+collectionId requirement.
- **Lift effort:** n/a (reference for what to avoid, not what to reuse).

### 5. Anthropic `mcp-builder` skill — Node/TypeScript MCP server reference guide

- **URL:** https://github.com/anthropics/skills/blob/f17010c9bb483898c1d9c9f42dde2b3a98889434/skills/mcp-builder/reference/node_mcp_server.md (commit `f17010c9bb483898c1d9c9f42dde2b3a98889434`, fetched 2026-08-08)
- **Relevance:** addresses requirement 1 fully — project structure, `package.json`/`tsconfig.json` shapes, Zod schema conventions (`.strict()`, `.describe()`), tool-naming conventions (`snake_case`, `{service}_verb_noun`), annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`), and a full worked example server.
- **Maturity:** first-party Anthropic skill, actively maintained (last relevant commit 2026-08-05 per repo history), pinned to `@modelcontextprotocol/sdk: ^1.6.1`.
- **Worth borrowing:** the annotations block per tool (`list_bookmarks` would be `readOnlyHint: true, destructiveHint: false, idempotentHint: true`; `add_bookmark` would be `readOnlyHint: false, destructiveHint: false, idempotentHint: false` given issue #52's explicit non-goal of edit/delete) and the `package.json`/`tsconfig.json` skeletons shown (ES2022 target, `Node16` module resolution, `type: module`, `dist/index.js` entry).
- **What to avoid:** the guide's own `IMPORTANT` callout — don't use the deprecated `server.tool()` or manual `setRequestHandler(ListToolsRequestSchema, ...)` registration style; use `registerTool`/`registerResource`/`registerPrompt` only.
- **Lift effort:** drop-in (as a style/structure reference, not a code dependency).

### 6. `modelcontextprotocol.io` quickstart — canonical Claude Desktop config wiring

- **URL:** https://modelcontextprotocol.io/quickstart/server (fetched 2026-08-08, TypeScript tab, spec `2026-07-28`)
- **Relevance:** addresses the config-wiring half of requirement 1. Shows the `claude_desktop_config.json` `mcpServers` block shape: `{"mcpServers": {"<name>": {"command": "node", "args": ["/absolute/path/to/build/index.js"]}}}` (or `"command": "npx", "args": [...]` for a published package, as used by `chromium-bookmarks-mcp` and `obsidian-brain` above). Confirms the workspace-path-as-arg-or-env pattern issue #52 wants (`obsidian-brain` uses `"env": {"VAULT_PATH": "..."}`; a bookmarks server could equivalently take the workspace path as a CLI arg or env var).
- **Maturity:** official, canonical, current.
- **Worth borrowing:** the env-var-for-target-path convention (`VAULT_PATH` in obsidian-brain) as one concrete precedent for how issue #52's "workspace path is supplied via MCP server config/args" requirement is commonly expressed in the wild.
- **What to avoid:** the logging rule stated on this page and repeated across every language tab — **never write to stdout on a stdio server** (`console.log`/`print`/`puts` corrupt the JSON-RPC stream); always log to stderr (`console.error`) or a file. This is a near-universal first bug in naive implementations and worth calling out explicitly since it's easy to trip during ad hoc debugging (`console.log` left in a handler).
- **Lift effort:** drop-in (documentation reference).

## No prior art found

- **Concurrent read-modify-write safety against a live external writer (VS Code extension writing `.vscode/bookmarks.json` while the MCP server is also reading/writing it).** Searched: the first-party `memory` server (#3 above), `infinitepi-io/bookmark-manager-mcp` (#4), `obsidian-brain`'s watcher/troubleshooting docs, and `wickes1/chromium-bookmarks-mcp`. None solve this for the "two independent processes writing the same file" case:
  - The first-party `memory` server does an unlocked full-file rewrite with no atomic rename and no lock — same race class, unaddressed.
  - `infinitepi-io/bookmark-manager-mcp` makes it *worse* by caching in memory and blind-overwriting on any read error.
  - `chromium-bookmarks-mcp` sidesteps the problem entirely by never touching the file — it talks to the live browser process instead, treating the browser as the single source of truth. That escape hatch is explicitly closed by issue #52 (must work without a live VS Code instance), so it isn't an available option here.
  - `obsidian-brain`'s `docs/troubleshooting.md` ("Index stale after a manual edit outside Claude") documents the same *symptom* (an external editor writes the file, the server's cached view goes stale) but its fix is "re-run the indexer" — a workable mitigation for a read-heavy semantic-search cache, not a solution for a concurrent-write scenario where the MCP server itself also writes (`add_bookmark`). Issue #52 sidesteps the staleness half by mandating poll/re-read-per-call rather than caching (Out of Scope: "Live push notifications... poll/re-read on each tool call is acceptable for v1") — but this only addresses stale *reads*, not the write race on `add_bookmark` (server reads current file, computes next `order`/dedup, writes back — if the extension writes in between, one write is lost). No candidate in this search solves that. Expect original design work here (e.g., read-verify-write retry, or accepting last-writer-wins as a documented v1 limitation) — that decision belongs to the planner, not this report.
- **Schema-version forward-compatibility for a JSON data file (v1 fixture reading cleanly under v2-aware code), matching issue #52's "reads validate against schema version... forward-compat" AC.** The closest thing found is the first-party `memory` server's `memory.json` → `memory.jsonl` migration — but that is a **file-extension/format** migration (JSON array to JSON-Lines), not a **schema-version-within-the-same-format** migration (v1 bookmarks shape vs. v2 with descriptions). No candidate demonstrates the latter. Expect original design work here.

## Note on a plausible-but-wrong axis-3 candidate

VS Code's own extension API — `vscode.lm.registerMcpServerDefinitionProvider` (https://code.visualstudio.com/api/extension-guides/ai/mcp, fetched 2026-08-08) and the bundled-into-VSIX pattern described in Ken Muse's blog post (https://www.kenmuse.com/blog/adding-mcp-server-to-vs-code-extension/, fetched 2026-08-08) — is a well-documented way for a VS Code extension to ship an MCP server. **It does not fit issue #52.** That mechanism registers an MCP server for VS Code's *own* AI features (Copilot Chat inside VS Code) and only runs while the extension is active inside a running VS Code instance. Issue #52 wants Claude Desktop/Claude Code (external processes, outside VS Code) to spawn the server directly via their own `mcpServers` config, with no VS Code instance required. Flagging this explicitly so the planner doesn't reach for `vscode.lm.registerMcpServerDefinitionProvider` by pattern-matching on "VS Code extension + MCP" searches — it solves a different problem.

## Recommended handoff

- `project-planner` — should design `mcp-server/`'s package layout after candidate #1 (`chromium-bookmarks-mcp`'s `apps/mcp-server`-as-independent-subpackage shape, adapted to this repo's existing layout) and its tool/schema/annotation conventions after candidate #5 (Anthropic's `mcp-builder` reference). The planner must make the SDK-generation call (`@modelcontextprotocol/sdk` v1.x vs. `@modelcontextprotocol/server` v2.x) explicitly — this report deliberately does not pick.
- `project-planner` — should treat the two "No prior art found" items (concurrent write race, schema-version migration) as design decisions requiring explicit tradeoff documentation in the plan, not gaps to silently paper over — no existing implementation solves either cleanly.
- `user` — should be asked, during planning, whether last-writer-wins on `add_bookmark` (matching the first-party `memory` server's unaddressed race) is an acceptable v1 limitation, since no prior art offers a better default.

## Open questions

- `unverified:` whether Claude Desktop and/or Claude Code enforce a minimum MCP protocol version that would force a choice between `@modelcontextprotocol/sdk` v1.x and `@modelcontextprotocol/server` v2.x for this server to actually connect. Not established by any source fetched in this research; needs a direct check against current Claude Desktop/Code release notes or a smoke test before the planner commits to one SDK generation.
- Whether `vscode-bookmarks-plus`'s existing root `package.json` already uses npm workspaces (relevant to whether candidate #1's workspace layout is a natural fit or a new convention for this repo) — not checked in this research pass; an `Explore` pass over the repo root would answer it quickly.
