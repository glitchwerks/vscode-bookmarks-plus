# Bundle MCP Server into VSIX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship `dist/bookmarks-plus-mcp.mjs` as a self-contained, intentionally versioned MCP server inside the Bookmarks Plus VSIX, with regression coverage for its protocol behavior and archive contents. (`docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L45-L56`, #125)

**Architecture:** The root esbuild driver will create the existing CommonJS extension bundle and a second Node-targeted ESM bundle from the standalone MCP source. The root lockfile will pin the MCP runtime packages used during bundling, the build will compare those versions with the standalone package lock, and an esbuild define will inject the standalone server version so relocation under the extension cannot select the extension version. (`esbuild.js:L6-L17`, `mcp-server/package.json:L1-L4`, `mcp-server/package-lock.json:L211-L214`, `mcp-server/package-lock.json:L2833-L2836`, `mcp-server/src/index.ts:L17-L38`)

**Tech Stack:** Node.js 20, esbuild, TypeScript, Node's built-in test runner, `@modelcontextprotocol/sdk`, `zod`, `@vscode/vsce`, and `yauzl`. (`.github/workflows/ci.yml:L22-L32`, `package.json:L124-L150`, `mcp-server/package.json:L34-L44`)

**Spec:** `docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md`

## Global Constraints

- Preserve `dist/extension.js` as the CommonJS extension entry point and add `dist/bookmarks-plus-mcp.mjs` as a Node ESM entry point. (`package.json:L15-L16`, `docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L45-L52`)
- Keep `mcp-server/**`, sources, tests, and nested dependencies out of the VSIX; ship the compiled artifact under `dist/`. (`.vscodeignore:L5-L13`, `docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L52-L54`)
- Preserve the standalone `mcp-server/` build, package, tests, and production dependency declarations. (`mcp-server/package.json:L21-L45`, #125)
- Do not register the VS Code MCP provider or raise the VS Code API floor in this issue; those changes belong to #126. (`docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L58-L76`, `docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L95-L100`)
- Keep the test process and path handling portable across Windows and Linux; the existing server packaging test documents the cross-platform child-process constraints. (`mcp-server/test/packaging.test.ts:L73-L98`, #125)
- Verify every artifact path named by committed files with `git ls-tree HEAD -- <path>` before the PR is declared complete. (#125)

---

### Task 1: Build and smoke-test the self-contained MCP bundle

**Files:**

- Create: `scripts/test-bundled-mcp.mjs`
- Modify: `esbuild.js:1-32`
- Modify: `mcp-server/src/index.ts:17-47`
- Modify: `package.json:124-151`
- Modify: `package-lock.json`
- Test: `scripts/test-bundled-mcp.mjs`

**Interfaces:**

- Consumes: `mcp-server/src/index.ts` as the ESM entry point and the resolved versions at `mcp-server/package-lock.json` keys `packages["node_modules/@modelcontextprotocol/sdk"].version` and `packages["node_modules/zod"].version`. (`mcp-server/src/index.ts:L1-L12`, `mcp-server/package-lock.json:L211-L214`, `mcp-server/package-lock.json:L2833-L2836`)
- Produces: `dist/bookmarks-plus-mcp.mjs`; the compile-time string `__BOOKMARKS_PLUS_MCP_VERSION__`; and the npm command `npm run test:mcp-bundle`.

- [ ] **Step 1: Write the failing bundle smoke test**

Create `scripts/test-bundled-mcp.mjs` with Node-test cases that run the production build, copy only `dist/bookmarks-plus-mcp.mjs` to a temporary directory, start it with `process.execPath`, exchange newline-delimited `initialize`, `notifications/initialized`, and `tools/list` messages, and assert:

```js
assert.equal(initialize.result.serverInfo.name, 'bookmarks-plus-mcp');
assert.equal(initialize.result.serverInfo.version, mcpPackage.version);
assert.deepEqual(
  tools.result.tools.map(({ name }) => name).sort(),
  ['add_bookmark', 'list_bookmarks'],
);
assert.equal(existsSync(join(bundleDir, 'node_modules')), false);
```

Use `spawn(process.execPath, [copiedBundle, workspaceDir], { stdio: ['pipe', 'pipe', 'pipe'] })`, an explicit timeout, EOF-based shutdown, and retrying temporary-directory cleanup. This avoids the shell and `.cmd` shim differences documented by the standalone packaging test while exercising the same MCP framing. (`mcp-server/test/packaging.test.ts:L145-L225`, `mcp-server/test/packaging.test.ts:L342-L398`)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/test-bundled-mcp.mjs`

Expected: FAIL because `npm run package` does not yet emit `dist/bookmarks-plus-mcp.mjs`; the current build has only `dist/extension.js`. (`esbuild.js:L6-L17`)

- [ ] **Step 3: Pin the bundle-time runtime dependencies**

Add these exact root development dependencies and regenerate the root lockfile:

```json
"@modelcontextprotocol/sdk": "1.30.0",
"zod": "4.4.3"
```

These values match the standalone lockfile's resolved versions. (`mcp-server/package-lock.json:L211-L214`, `mcp-server/package-lock.json:L2833-L2836`)

- [ ] **Step 4: Make server version selection explicit**

Declare the build-time value in `mcp-server/src/index.ts` and prefer it before the standalone package lookup:

```ts
declare const __BOOKMARKS_PLUS_MCP_VERSION__: string | undefined;

function readPackageVersion(): string {
  if (typeof __BOOKMARKS_PLUS_MCP_VERSION__ === 'string') {
    return __BOOKMARKS_PLUS_MCP_VERSION__;
  }
  // Existing standalone package.json walk remains unchanged below.
}
```

The fallback preserves the standalone server's current lookup, while esbuild replaces the identifier in the VSIX artifact. (`mcp-server/src/index.ts:L17-L38`, `docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L54-L56`)

- [ ] **Step 5: Add the second esbuild context and dependency-version assertion**

Refactor `esbuild.js` around two build configurations:

```js
const buildConfigs = [
  {
    entryPoints: ['src/extension.ts'],
    format: 'cjs',
    outfile: 'dist/extension.js',
    external: ['vscode'],
  },
  {
    entryPoints: ['mcp-server/src/index.ts'],
    format: 'esm',
    outfile: 'dist/bookmarks-plus-mcp.mjs',
    define: {
      __BOOKMARKS_PLUS_MCP_VERSION__: JSON.stringify(mcpPackage.version),
    },
  },
];
```

Before creating contexts, compare each root installed/locked version of `@modelcontextprotocol/sdk` and `zod` with the corresponding standalone lockfile version and throw a named error on mismatch. Rebuild and dispose both contexts for compile/package; rebuild and watch both contexts for watch mode. The root build currently installs only root dependencies, so both packages must be declared at the root for a clean root build. (`package.json:L124-L150`, `.github/workflows/ci.yml:L28-L32`, `docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L54-L56`)

- [ ] **Step 6: Wire and pass the bundle smoke test**

Add:

```json
"test:mcp-bundle": "node --test scripts/test-bundled-mcp.mjs"
```

Run: `npm run test:mcp-bundle`

Expected: PASS; both build artifacts exist, a copied MCP bundle starts without adjacent dependencies, reports version `0.1.0`, and lists `add_bookmark` and `list_bookmarks`. (`mcp-server/package.json:L1-L4`, `mcp-server/src/index.ts:L40-L80`, #125)

- [ ] **Step 7: Confirm the standalone package remains valid**

Run: `npm --prefix mcp-server run lint`

Run: `npm --prefix mcp-server run build`

Run on CI's Node 20 runtime: `npm --prefix mcp-server test`

Expected: all commands pass; the standalone dependency declarations and emitted npm entry point remain unchanged. (`mcp-server/package.json:L21-L45`, `.github/workflows/ci.yml:L52-L95`)

- [ ] **Step 8: Commit the build slice**

```bash
git add esbuild.js mcp-server/src/index.ts package.json package-lock.json scripts/test-bundled-mcp.mjs
git commit -m "feat: bundle MCP server with extension"
```

### Task 2: Inspect the real VSIX and enforce the regression in CI

**Files:**

- Modify: `scripts/test-bundled-mcp.mjs`
- Modify: `package.json:138-151`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml:28-33`
- Test: `scripts/test-bundled-mcp.mjs`

**Interfaces:**

- Consumes: `dist/bookmarks-plus-mcp.mjs` and `npm run test:mcp-bundle` from Task 1.
- Produces: VSIX entry assertions over a real archive created by `@vscode/vsce`, using `yauzl` as an explicitly declared test dependency; the existing CI `test` job runs the regression after root installation. (`package.json:L124-L150`, `.github/workflows/ci.yml:L13-L32`)

- [ ] **Step 1: Write the failing archive-content test**

Extend `scripts/test-bundled-mcp.mjs` to call:

```js
await createVSIX({
  cwd: repoRoot,
  packagePath: vsixPath,
  dependencies: false,
});
```

Open that exact VSIX with `yauzl`, collect normalized archive entry names, and assert:

```js
assert.ok(entries.includes('extension/dist/extension.js'));
assert.ok(entries.includes('extension/dist/bookmarks-plus-mcp.mjs'));
assert.equal(entries.some((entry) => entry.startsWith('extension/mcp-server/')), false);
assert.equal(entries.some((entry) => entry.includes('/node_modules/')), false);
assert.equal(rootPackage.devDependencies.yauzl, '2.10.0');
```

The archive test must inspect the created ZIP rather than infer contents from `.vscodeignore`; the ignore file excludes raw server content while leaving `dist/` eligible for packaging. (`.vscodeignore:L5-L15`, #125)

- [ ] **Step 2: Run the archive test to verify its dependency contract fails**

Run after importing `yauzl` and asserting its root manifest declaration but before declaring it: `npm run test:mcp-bundle`

Expected: FAIL because `package.json` does not directly declare `yauzl`, even if the current install happens to expose it transitively through `@vscode/vsce`. (`package.json:L138-L150`)

- [ ] **Step 3: Declare the archive reader directly**

Add the exact root development dependency and regenerate the lockfile:

```json
"yauzl": "2.10.0"
```

The test will use `lazyEntries: true`, reject ZIP open/read errors, close after `end`, and delete the temporary VSIX during the shared cleanup hook.

- [ ] **Step 4: Run the complete packaging regression**

Run: `npm run test:mcp-bundle`

Expected: PASS for build output, isolated MCP initialization/tool listing, explicit server version, and real VSIX entries. (#125)

- [ ] **Step 5: Add the existing job's blocking CI step**

Add this step after the current root test step:

```yaml
      - name: Test bundled MCP server and VSIX contents
        run: npm run test:mcp-bundle
```

This retains the existing `test` check identity and its read-only permissions while making the new regression part of the root CI gate. (`.github/workflows/ci.yml:L13-L32`)

- [ ] **Step 6: Run root verification**

Run: `npm run lint`

Run: `npm run compile-tests`

Run: `npm run package`

Run: `npm run test:mcp-bundle`

Expected: all commands pass and the package test inspects a freshly created VSIX. (`package.json:L124-L150`, #125)

- [ ] **Step 7: Commit the packaging/CI slice**

```bash
git add scripts/test-bundled-mcp.mjs package.json package-lock.json .github/workflows/ci.yml
git commit -m "test: verify bundled MCP VSIX contents"
```

### Task 3: Final compatibility and persistence audit

**Files:**

- Verify only: all files changed by Tasks 1-2

**Interfaces:**

- Consumes: both Task 1 and Task 2 commits.
- Produces: a verified branch ready for a pull request into `feature-124-vscode-native-mcp`, the epic's primary feature branch. (#124, #125)

- [ ] **Step 1: Run the fresh root suite**

Run: `npm test`

Expected on Node 20: the extension's compiled test suite passes after rebuilding both bundles. (`package.json:L124-L133`, `.github/workflows/ci.yml:L22-L32`)

- [ ] **Step 2: Run the fresh standalone MCP suite**

Run: `npm --prefix mcp-server test`

Expected on Node 20: the standalone MCP unit suite passes, including its default packaging-test self-skip. (`mcp-server/package.json:L25-L32`, `mcp-server/test/packaging.test.ts:L235-L269`)

- [ ] **Step 3: Inspect the branch deliverables**

Run: `git diff feature-124-vscode-native-mcp...HEAD --stat`

Expected: build driver, injected-version source, root manifest/lock, packaging smoke test, CI workflow, and this implementation plan are present; no provider-registration files are present. (`docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md:L95-L100`)

- [ ] **Step 4: Verify referenced artifact persistence**

Run after committing:

```bash
git ls-tree HEAD -- esbuild.js
git ls-tree HEAD -- mcp-server/src/index.ts
git ls-tree HEAD -- scripts/test-bundled-mcp.mjs
git ls-tree HEAD -- docs/superpowers/specs/2026-09-04-vscode-native-mcp-integration-design.md
git ls-tree HEAD -- docs/superpowers/plans/2026-09-04-bundle-mcp-server-into-vsix.md
```

Expected: each command prints a tracked blob. The generated `dist/` files and temporary VSIX are intentionally build outputs, so persistence is guaranteed by their tracked build source and regression test rather than committing generated files. (`.gitignore:L1-L8`, `esbuild.js:L6-L17`, #125)

- [ ] **Step 5: Review branch diff and commit any verification-only adjustment**

Run: `git status --short`

Expected: clean. If verification required a source adjustment, repeat the relevant failing test first, apply the smallest correction, rerun the affected and full checks, and commit that correction with a focused Conventional Commit message.
