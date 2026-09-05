# VS Code-Native MCP Integration Design

**Status:** Proposed for review  
**Epic:** #124  
**Implementation issues:** #125, #126, #127, #128  
**Deferred follow-up:** #129

## Goal

Make the existing Bookmarks Plus MCP tools available to VS Code's MCP clients when the extension is installed, without requiring users to install or configure the separately published npm package. The first release keeps the current file-backed contract: the extension maintains `.vscode/bookmarks.json`, and the bundled MCP server reads and updates that mirror.

The work belongs to milestone `v1.5.0` and is sequenced as #125 → #126 → #127 → #128. Issue #129 is deliberately outside that milestone.

## Current implementation

- The extension has one esbuild entry point, producing `dist/extension.js`; its VSIX currently excludes the entire `mcp-server/` directory. (`esbuild.js:L6-L17`, `.vscodeignore:L1-L13`)
- Extension activation creates separate workspace and global stores. Only the workspace store receives a mirror, and workspace-folder changes already update the mirror-related environment state. (`src/extension.ts:L282-L300`, `src/extension.ts:L419-L437`)
- The mirror is enabled only for a single workspace folder and is stored at `.vscode/bookmarks.json`; no-folder and multi-root windows are explicitly disabled. (`src/bookmarkMirror.ts:L5-L12`, `src/bookmarkMirror.ts:L22-L43`)
- The existing MCP server already registers the list and add tools and serves them over stdio. (`mcp-server/src/index.ts:L40-L80`, `mcp-server/src/index.ts:L83-L98`)
- An explicit workspace path in `argv[2]` has the highest configuration precedence, and the server already understands disabled no-folder and multi-root states. (`mcp-server/src/config.ts:L26-L58`, `mcp-server/src/config.ts:L61-L95`)
- The extension currently declares VS Code `^1.85.0`, while native MCP server definition providers were introduced for extension authors in VS Code 1.101. (`package.json:L11-L16`; [VS Code 1.101 release notes](https://code.visualstudio.com/updates/v1_101), fetched 2026-09-04)
- The declared `@types/vscode` range is `^1.85.0`, which allows npm to resolve types newer than the runtime floor. (`package.json:L138-L145`, `package-lock.json:L850-L858`)

## Scope

### Included

- Bundle the existing MCP server and its runtime dependencies into the VSIX as a self-contained JavaScript artifact.
- Register one VS Code MCP server definition provider using the native extension API.
- Start the bundled server over stdio for a single-root workspace and pass the workspace folder explicitly.
- Preserve the current `list_bookmarks` and `add_bookmark` behavior and mirror-file contract.
- Raise the minimum supported VS Code version to `^1.101.0` and pin the VS Code type package to `1.101.0`.
- Test source builds, VSIX contents, and an installed/package-level MCP handshake on Windows and Linux.
- Update user and contributor documentation for the native path.

### Not included

- Global bookmarks. The global store is backed by `context.globalState` and has no mirror today. (`src/extension.ts:L295-L300`)
- Multi-root workspace support. The current mirror and server intentionally disable that state. (`src/bookmarkMirror.ts:L22-L43`, `mcp-server/src/config.ts:L69-L91`; tracked separately by #62)
- A live IPC bridge into the running extension host, real-time push notifications, or broader tool additions. Those require a separate security and lifecycle design and are tracked by #129.
- Replacing the separately distributable npm package tracked by #66. The npm and VSIX delivery paths reuse the same server source but remain independently releasable.

## Design

### 1. Build and package one additional entry point

Extend the root build so it produces both:

- existing extension host bundle: `dist/extension.js` (CommonJS);
- proposed MCP runtime bundle: `dist/bookmarks-plus-mcp.mjs` (ES module, Node platform).

The MCP artifact is built from `mcp-server/src/index.ts` and bundles its runtime dependencies, including `@modelcontextprotocol/sdk` and `zod`. Raw `mcp-server/**`, tests, sources, and its nested `node_modules` remain excluded from the VSIX; only the compiled artifact under `dist/` ships. This preserves the current small package surface while removing a runtime npm-install dependency. The existing build currently has only the extension entry point, and the ignore file already excludes raw MCP sources. (`esbuild.js:L6-L17`, `.vscodeignore:L1-L13`, `mcp-server/package.json:L34-L36`)

Because the root packaging workflow installs only the root lockfile, add exact matching MCP build dependencies to the root `devDependencies` and lock them there. Keep the standalone package's production dependency declarations unchanged, and add a build-level assertion that the shared dependency versions match. This lets `npm ci && npm run package` remain sufficient at the repository root while preserving independent npm publication. (`package.json:L124-L145`, `mcp-server/package.json:L25-L45`, `.github/workflows/publish.yml:L35-L45`)

Bundling changes the MCP file's location relative to `package.json`. The implementation must make server version reporting explicit at build time or otherwise prevent `readPackageVersion()` from accidentally reading the extension package version after relocation. The current lookup walks parent directories from the running module. (`mcp-server/src/index.ts:L17-L38`)

### 2. Register a native provider from extension activation

Add the `contributes.mcpServerDefinitionProviders` declaration to `package.json`, then register the matching provider during `activate()` with `vscode.lm.registerMcpServerDefinitionProvider`. The provider returns an array containing one `vscode.McpStdioServerDefinition` that launches the bundled module with `process.execPath`, sets `ELECTRON_RUN_AS_NODE=1`, and passes the active workspace folder path as an explicit argument.

The provider ID in the contribution and registration must be identical. The registration disposable belongs in `context.subscriptions`. These are the documented provider mechanics and match Microsoft's extension sample. ([VS Code MCP extension guide](https://code.visualstudio.com/api/extension-guides/ai/mcp), fetched 2026-09-04; [Microsoft MCP extension sample](https://github.com/microsoft/vscode-extension-samples/tree/main/mcp-extension-sample), fetched 2026-09-04)

Provider code should be isolated from the rest of activation behind a small module whose dependencies can be substituted in unit tests. Activation should continue to initialize bookmarks even if provider construction cannot return a runnable definition; the failure should be visible through the existing Bookmarks Plus output channel.

### 3. Keep workspace behavior aligned with the mirror

For a single-root workspace, resolve the folder's filesystem path and pass it as `argv[2]`. This reuses the server's existing highest-precedence configuration path and avoids relying on environment mutation timing. (`mcp-server/src/config.ts:L26-L58`)

For no-folder or multi-root windows, the provider remains registered but returns an empty definition array and writes a concise diagnostic to the output channel. This matches the mirror's current availability rules and avoids advertising a server that can only respond with disabled errors. (`src/bookmarkMirror.ts:L22-L43`)

When workspace folders change, VS Code can ask the provider for fresh definitions through the provider's change event. The provider should fire that event after a folder change so a single-root folder swap updates the launched server's explicit path. The extension already listens for the same workspace event for mirror state. (`src/extension.ts:L419-L437`; [VS Code MCP extension guide](https://code.visualstudio.com/api/extension-guides/ai/mcp), fetched 2026-09-04)

### 4. Raise and align the API baseline

Change `engines.vscode` from `^1.85.0` to `^1.101.0`, the release that introduced MCP server definition provider APIs for extension authors. Pin `@types/vscode` to exactly `1.101.0` so compile-time API availability cannot silently drift above the declared runtime requirement. (`package.json:L11-L16`, `package.json:L138-L145`; [VS Code 1.101 release notes](https://code.visualstudio.com/updates/v1_101), fetched 2026-09-04)

## Runtime flow

1. VS Code activates Bookmarks Plus and initializes the existing workspace mirror.
2. The extension registers the contributed MCP provider.
3. VS Code requests server definitions for the current window.
4. In a single-root window, the provider returns a stdio definition pointing to the bundled MCP module and supplies the workspace path as the first server argument.
5. The MCP process resolves `.vscode/bookmarks.json`, registers the existing list/add tools, and communicates over stdio. (`mcp-server/src/config.ts:L46-L58`, `mcp-server/src/index.ts:L40-L98`)
6. Reads and writes continue through the mirror's existing reconciliation and atomic-write behavior; the extension remains the owner of VS Code state. (`src/bookmarkStore.ts:L283-L305`, `src/bookmarkMirror.ts:L55-L89`)

## Testing strategy

Issue #125 owns build-level tests that assert both bundles are produced and that the VSIX contains the MCP runtime but not raw server sources or nested dependencies.

Issue #126 owns unit tests for provider registration, executable/module arguments, single-root definitions, disabled states, folder-change refresh, disposal, and visible failure reporting.

Issue #127 owns packaged end-to-end coverage: build a VSIX, install or extract that exact artifact in an isolated test environment, start the shipped MCP entry point on Windows and Linux, perform `initialize` and `tools/list`, and verify the existing tools are returned. The current npm packaging test already demonstrates the JSON-RPC handshake shape and cross-platform child-process handling that can be reused. (`mcp-server/test/packaging.test.ts:L1-L15`, `mcp-server/test/packaging.test.ts:L73-L80`)

## Issue plan

1. **#125 — Bundle the Bookmarks Plus MCP server into the VSIX.** Add the second build artifact, resolve version/schema embedding, and assert package contents.
2. **#126 — Register the bundled server with VS Code's MCP provider API.** Raise the VS Code floor, align types, implement provider lifecycle, and cover single-root/disabled behavior. Depends on #125.
3. **#127 — Add packaged end-to-end coverage.** Prove the installed artifact launches and exposes tools on Windows and Linux. Depends on #125 and #126.
4. **#128 — Document and release the native integration.** Update README, contributor/release documentation, and release notes only after the packaged path is proven. Depends on #127.
5. **#129 — Add a live/global bookmark bridge.** Revisit transport, authentication, lifecycle, global storage, and multi-window semantics after the file-backed native path ships. Deferred.

## Acceptance boundary

Epic #124 is complete when #125 through #128 are closed, the packaged VSIX exposes the existing MCP tools through VS Code in a single-root workspace on Windows and Linux, unsupported workspace shapes fail clearly, the minimum version is `^1.101.0`, and documentation describes the installed experience. Closing #129 is not required.
