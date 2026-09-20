# Scoped MCP npm Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the standalone MCP server as the public `@glitchwerks/bookmarks-plus-mcp` package, then add a tag-driven npm trusted-publishing workflow that is independent from the VS Code extension release lane.

**Architecture:** Deliver the work in two implementation PRs separated by a mandatory manual bootstrap. Phase 1 changes the package identity, fixes cross-version test discovery, adds package-facing documentation, and is followed by the first 2FA-protected manual publish plus `mcp-v0.1.0` tag. Phase 2 adds a repository-owned release validator and least-privilege OIDC workflow; npm trusted-publisher configuration happens only after that workflow exists on `main`. The package keeps the existing mirror-based runtime and `bookmarks-plus-mcp` binary unchanged.

**Tech Stack:** Node.js 18+ package runtime; Node.js 20 test compatibility; Node.js 24 and npm 11 for publishing; TypeScript; Node test runner; Mocha; `js-yaml`; GitHub Actions; npm trusted publishing.

**Spec:** `docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md`

## Global Constraints

- Treat Issue #66 as the source of truth and keep it open until the public package, tag, workflow, trusted publisher, token restriction, and trust-list verification are complete. The approved bootstrap sequence is recorded in `docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L83-L140`.
- Before Phase 1 merges, the maintainer must create the npm account, enable publish 2FA, and create the free public `glitchwerks` organization. If that scope is unavailable, stop and revise the approved package identity; do not substitute another scope (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L85-L96`).
- Use a fresh worktree and branch from updated `main` for each implementation PR. Do not stack Phase 2 on the Phase 1 branch.
- Keep package version `0.1.0` independent from extension version `1.3.0`; compatibility is the supported mirror schema, not version equality (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L66-L81`).
- Keep the executable name `bookmarks-plus-mcp` and target `dist/index.js`; only the npm package name becomes scoped (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L68-L75`).
- Preserve the extension workflow's `vX.Y.Z` lane. The new workflow exclusively owns exact stable `mcp-vMAJOR.MINOR.PATCH` tags and creates no GitHub Release (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L142-L201`, `docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L271-L278`).
- Do not add a shared action, npm token, prerelease dist-tag lane, runtime behavior change, or new standalone MCP capability (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L271-L278`).
- The approved spec is committed and persistent: `git ls-tree HEAD -- docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md` returns blob `bb887a2521ad5220d14eacd456032ba350eb871b`.

---

## File Map

### Phase 1 — package release PR

- Create `mcp-server/scripts/run-tests.mjs`: recursively discover compiled test files and pass explicit paths to `node --test` on every supported Node version.
- Create `mcp-server/scripts/run-tests.test.mjs`: unit-test discovery, ordering, explicit arguments,
  real path-with-spaces execution, and empty-suite failure.
- Modify `mcp-server/package.json`: scoped package identity and cross-version test launcher wiring.
- Modify `mcp-server/package-lock.json`: synchronize the root package identity/version through npm, not hand editing.
- Modify `mcp-server/test/packageManifest.test.ts`: pin scoped name, retained bin, public-access publish command, and launcher wiring.
- Modify `mcp-server/scripts/verify-pack.mjs`: replace the deleted-plan citation with Issue #66 and PR #113.
- Modify `mcp-server/test/packaging.test.ts`: replace stale plan wording and keep the local generated-bin handshake.
- Create `mcp-server/CHANGELOG.md`: package-only `0.1.0` release notes.
- Modify `README.md`: add only the short public `npx` entry point.
- Modify `docs/mcp.md`: make npm installation primary for standalone clients while preserving scope/lifecycle guidance.
- Modify `mcp-server/README.md`: make public npm usage the npm-listing lead and retain source-build fallback and protocol details.
- Modify `docs/release-strategy.md`: document the independent MCP package lane and the manual first-release bootstrap.

### Phase 2 — trusted-publishing PR

- Create `mcp-server/scripts/validate-release.mjs`: pure validation plus CLI entry point for tag, manifest, and changelog agreement.
- Create `mcp-server/scripts/validate-release.test.mjs`: cover every validator rejection path.
- Modify `mcp-server/package.json`: run validator tests in the default suite and expose `verify-release`.
- Create `.github/workflows/publish-mcp.yml`: immutable-tag validation, parallel lint/package gates, and OIDC publish.
- Create `src/test/suite/publishMcpWorkflow.test.ts`: parse and pin the workflow's triggers, graph, permissions, and publish command.
- Modify `docs/release-strategy.md`: replace the bootstrap-only procedure with the recurring automated MCP release procedure and recovery path.

### Final lifecycle cleanup

- Delete this plan after all external gates pass and close Issue #66 through the cleanup PR. Preserve durable rationale in the approved spec and Issue #66.

---

## Task 0: Satisfy the npm Organization Prerequisite

**Files:** None.

- [ ] Sign in to the npm account that will maintain the package and enable 2FA for authorization and publishing.
- [ ] Create the free public npm organization named `glitchwerks`.
- [ ] Confirm the account can create a public package in that organization.
- [ ] Record confirmation on Issue #66; end the comment with the required Codex attribution when posted through automation.
- [ ] Stop here if `glitchwerks` cannot be created. Update the approved spec and re-approve the new scope before changing code.

**Gate:** Do not merge Phase 1 until the user confirms this task is complete. npm requires the organization/account before a scoped package can be published, and the first public scoped publish requires `--access public` ([npm organizations](https://docs.npmjs.com/creating-an-organization/) and [scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), fetched 2026-09-19; also summarized in `docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L68-L75` and `docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L85-L96`).

---

## Task 1: Replace Directory-Based Test Discovery

**Files:**
- Create: `mcp-server/scripts/run-tests.mjs`
- Create: `mcp-server/scripts/run-tests.test.mjs`
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/test/packageManifest.test.ts`

The current `node --test dist/test` works in Node 20 CI but fails on current Windows Node 22/24. The approved fix is explicit recursive discovery, not a quoted glob (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L39-L42`, `docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L98-L110`).

### Step 1: Write the failing launcher tests

- [ ] Create `mcp-server/scripts/run-tests.test.mjs` with these behaviors:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  buildNodeTestArguments,
  discoverTestFiles,
  runTests,
} from './run-tests.mjs';

test('discoverTestFiles recursively returns only .test.js files in stable order', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bookmarks-mcp-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'z.test.js'), '');
  writeFileSync(join(root, 'nested', 'a.test.js'), '');
  writeFileSync(join(root, 'nested', 'helper.js'), '');

  assert.deepEqual(
    discoverTestFiles(root).map((file) => relative(root, file).replaceAll('\\', '/')),
    ['nested/a.test.js', 'z.test.js'],
  );
});

test('buildNodeTestArguments passes each file as an explicit argument', () => {
  assert.deepEqual(
    buildNodeTestArguments(['C:/suite/a.test.js', 'C:/suite/b.test.js']),
    ['--test', 'C:/suite/a.test.js', 'C:/suite/b.test.js'],
  );
});

test('runTests executes a test file whose root and name contain spaces', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bookmarks mcp launcher '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'passes with spaces.test.js'),
    "import test from 'node:test';\ntest('passes', () => {});\n",
  );

  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(runTests(root), 0);
  } finally {
    if (testContext === undefined) {
      delete process.env.NODE_TEST_CONTEXT;
    } else {
      process.env.NODE_TEST_CONTEXT = testContext;
    }
  }
});

test('discoverTestFiles rejects an empty suite', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bookmarks-mcp-empty-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => discoverTestFiles(root), /no \.test\.js files/i);
});
```

- [ ] Run `node --test scripts/run-tests.test.mjs` from `mcp-server/`.
- [ ] Verify it fails because `scripts/run-tests.mjs` does not exist.

### Step 2: Implement the launcher

- [ ] Create `mcp-server/scripts/run-tests.mjs`:

```js
#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function discoverTestFiles(rootDirectory) {
  const root = resolve(rootDirectory);
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        files.push(path);
      }
    }
  }

  visit(root);
  files.sort();
  if (files.length === 0) {
    throw new Error(`No .test.js files found under ${root}`);
  }
  return files;
}

export function buildNodeTestArguments(testFiles) {
  return ['--test', ...testFiles];
}

export function runTests(testRoot = resolve('dist', 'test')) {
  const result = spawnSync(
    process.execPath,
    buildNodeTestArguments(discoverTestFiles(testRoot)),
    { stdio: 'inherit' },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runTests();
  } catch (error) {
    console.error(`run-tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
```

- [ ] Run `node --test scripts/run-tests.test.mjs`; verify 4 tests pass, including a real
  `runTests()` invocation for a temporary root and `.test.js` filename containing spaces.

### Step 3: Pin package-script wiring before changing it

- [ ] Replace the final quoted-glob/directory assertion in `mcp-server/test/packageManifest.test.ts` with:

```ts
test('the `test` script uses the cross-version explicit-file launcher', () => {
  const testScript = readManifest().scripts?.test ?? '';
  assert.match(testScript, /node --test scripts\/run-tests\.test\.mjs/);
  assert.match(testScript, /node scripts\/run-tests\.mjs/);
  assert.doesNotMatch(testScript, /node --test dist\/test(?:\s|$)/);
  assert.doesNotMatch(testScript, /dist\/test\/.*\*/);
});
```

- [ ] Compile and run only the manifest test using:

```powershell
npm run build
npx tsc -p tsconfig.test.json
node scripts/copy-test-fixtures.mjs
node --test dist/test/packageManifest.test.js
```

- [ ] Verify the new wiring assertion fails against the old `package.json`.

### Step 4: Wire the launcher into the default test command

- [ ] Change `mcp-server/package.json`'s test script to this exact command:

```json
"test": "tsc -p tsconfig.test.json && node scripts/copy-schema.mjs && node scripts/copy-test-fixtures.mjs && node --test scripts/run-tests.test.mjs && node scripts/run-tests.mjs"
```

- [ ] Run `npm test` from `mcp-server/` on the local current Node release.
- [ ] Verify the launcher unit tests pass, every compiled `*.test.js` file runs, and `packaging.test.js` self-skips outside `test:packaging`.
- [ ] Commit:

```text
test: make MCP test discovery cross-version (#66)
```

---

## Task 2: Rename and Pin the Public Package Contract

**Files:**
- Modify: `mcp-server/test/packageManifest.test.ts`
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/package-lock.json`

### Step 1: Add failing manifest assertions

- [ ] Add `name` and `bin` to `PackageManifest`:

```ts
name?: string;
bin?: Record<string, string>;
```

- [ ] Add these tests before changing the manifest:

```ts
test('package uses the approved public npm scope', () => {
  assert.equal(readManifest().name, '@glitchwerks/bookmarks-plus-mcp');
});

test('scoping the package does not rename the executable', () => {
  assert.deepEqual(readManifest().bin, {
    'bookmarks-plus-mcp': 'dist/index.js',
  });
});

test('the first package release remains independently versioned at 0.1.0', () => {
  assert.equal(readManifest().version, '0.1.0');
});
```

- [ ] Run the compiled `packageManifest.test.js` as in Task 1 and verify only the new package-name assertion fails.

### Step 2: Change the package identity and regenerate lock metadata

- [ ] Change only `mcp-server/package.json`'s `name` to:

```json
"name": "@glitchwerks/bookmarks-plus-mcp"
```

- [ ] From `mcp-server/`, run `npm install --package-lock-only --ignore-scripts` so both top-level lockfile package records become `@glitchwerks/bookmarks-plus-mcp` at `0.1.0`.
- [ ] Inspect `git diff -- mcp-server/package-lock.json` and confirm dependency resolutions did not change unexpectedly.
- [ ] Run `npm test`, `npm run build`, and `npm run verify-pack` from `mcp-server/`.
- [ ] Run `npm pack --dry-run --json` and confirm the JSON reports package name `@glitchwerks/bookmarks-plus-mcp`, version `0.1.0`, includes `dist/index.js` and the schema, and excludes `dist/test/`.
- [ ] Commit:

```text
feat: scope the standalone MCP package (#66)
```

---

## Task 3: Add Package Release Notes and Public Setup Documentation

**Files:**
- Create: `mcp-server/CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/mcp.md`
- Modify: `mcp-server/README.md`
- Modify: `docs/release-strategy.md`
- Modify: `mcp-server/scripts/verify-pack.mjs`
- Modify: `mcp-server/test/packaging.test.ts`

The documentation split is fixed by the approved design: the root README stays high-level, `docs/mcp.md` owns integration guidance, the package README leads with public installation, and `docs/release-strategy.md` owns maintainer release mechanics (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L203-L215`).

### Step 1: Add the package changelog

- [ ] Create `mcp-server/CHANGELOG.md`:

```markdown
# Changelog

All notable changes to `@glitchwerks/bookmarks-plus-mcp` are documented in this file.

## [Unreleased]

## [0.1.0] — 2026-09-19

### Added

- First public release of the standalone Bookmarks Plus MCP server.
- `list_bookmarks` and `add_bookmark` for one workspace's `.vscode/bookmarks.json` mirror.
- Automatic workspace resolution for Bookmarks Plus terminals and Claude Code, plus an explicit
  workspace path for clients such as Claude Desktop.
- Package-content verification and a real installed-package MCP handshake on Linux and Windows.
- Reads mirror schema versions through `2` and refuses newer schemas.

See Issue #66 and PR #113 for the release and packaging history.
```

### Step 2: Make public npm usage the supported default

- [ ] Add this concise sentence to the root README's AI integration section:

```markdown
External MCP clients can run the standalone server with
`npx -y @glitchwerks/bookmarks-plus-mcp`; see [MCP integrations](docs/mcp.md) for configuration.
```

- [ ] Replace `docs/mcp.md`'s standalone introduction with public-package-first guidance:

````markdown
## Standalone MCP clients

Run the public package without a global install:

```sh
npx -y @glitchwerks/bookmarks-plus-mcp [workspace-path]
```

The standalone server reads and writes one workspace root's `.vscode/bookmarks.json` mirror and
works whether or not VS Code is running. It resolves the workspace from an explicit argument,
`BOOKMARKS_PLUS_WORKSPACE`, `CLAUDE_PROJECT_DIR`, or the legacy `BOOKMARKS_MCP_WORKSPACE`, in that
order. Because Global, Detached, and Unassigned data is not mirrored, those scopes are unavailable
to standalone clients.

See the [standalone server README](../mcp-server/README.md) for Claude Code and Claude Desktop
configuration, source-build fallback, result shapes, and concurrency limitations.
````

- [ ] Change `mcp-server/README.md`'s title to `# @glitchwerks/bookmarks-plus-mcp` and insert this before the source-build fallback:

````markdown
## Run the public package

No global install is required:

```sh
npx -y @glitchwerks/bookmarks-plus-mcp [workspace-path]
```

The npm package and VS Code extension have independent versions. Compatibility is defined by the
mirror schema: version `0.1.0` reads schema versions through `2` and refuses newer versions.
````

- [ ] Rename the existing `Build from source` section to `Source-build fallback` and update every client configuration:
  - public examples use command `npx` and begin args with `-y`, `@glitchwerks/bookmarks-plus-mcp`;
  - Claude Code omits the workspace argument so `CLAUDE_PROJECT_DIR` resolves it;
  - Claude Desktop supplies its explicit workspace path as the final argument;
  - source checkout examples remain, but are explicitly labeled as fallback/development configurations.

### Step 3: Document the Phase 1 release procedure

- [ ] Add an `## Standalone MCP package` section to `docs/release-strategy.md` that records:
  - independent SemVer and `mcp-vX.Y.Z` tags;
  - package changelog ownership;
  - exact Phase 1 verification commands;
  - `npm publish --access public` for the first manual publish;
  - public registry and cold-install handshake checks;
  - tag creation only after those checks pass;
  - the fact that the automation workflow intentionally does not exist during the first tag push.

- [ ] Use this command block for the local release gate:

```bash
cd mcp-server
npm ci
npm run lint
npm test
npm run build
npm run verify-pack
npm run test:packaging
npm publish --access public
```

The public publish command is required for the first scoped release ([npm scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), fetched 2026-09-19).

### Step 4: Remove deleted-plan references

- [ ] Replace the exact deleted-plan path in `mcp-server/scripts/verify-pack.mjs` with `Issue #66 and PR #113`.
- [ ] Replace `original implementation plan` wording in `mcp-server/test/packaging.test.ts` with durable `Issue #66 / PR #113` references.
- [ ] Update `mcp-server/test/packaging.test.ts`'s default-suite comment to say that
  `scripts/run-tests.mjs` explicitly discovers the compiled file and the lifecycle guard is what
  keeps the network-dependent body skipped during the default run; remove the obsolete glob text.
- [ ] Run:

```powershell
rg -n "2026-08-30-publish-mcp-server-to-npm|original implementation plan" mcp-server README.md docs
```

- [ ] Verify no committed file references the deleted plan.

### Step 5: Verify documentation-backed behavior

- [ ] Run `npm test` from `mcp-server/`; the existing packaging test parses public JSON examples and will catch stale result shapes.
- [ ] Run `npm run test:packaging` from `mcp-server/` and verify the generated `bookmarks-plus-mcp` binary completes `initialize` and `tools/list`.
- [ ] Review all public examples for the exact package string `@glitchwerks/bookmarks-plus-mcp` and exact binary `bookmarks-plus-mcp`.
- [ ] Commit:

```text
docs: document the public MCP package (#66)
```

---

## Task 4: Verify and Merge Phase 1

**Files:** All Phase 1 files.

- [ ] Run from the repository root:

```powershell
npm run lint
npm test
npm run test:mcp-bundle
```

- [ ] Run from `mcp-server/`:

```powershell
npm ci
npm run lint
npm test
npm run build
npm run verify-pack
npm run test:packaging
```

- [ ] Run `git diff main...HEAD --stat` and reconcile every Phase 1 deliverable in the File Map.
- [ ] For every path mentioned by a changed committed doc or script, verify it exists with `git ls-tree HEAD -- <path>`.
- [ ] Search for placeholders: `rg -n "TODO|TBD|PLACEHOLDER|coming later"` across changed files; resolve any release-related matches.
- [ ] Push only after confirming the PR is open, create the Phase 1 PR, and include `Refs #66` rather than closing the issue.
- [ ] Before merge, inspect all live review comments, requested changes, review requests, CodeRabbit output, and CI on the exact head commit.
- [ ] Merge only when all actionable feedback is addressed and all checks pass.

---

## Task 5: Perform the Manual First Publish and Tag

**Files:** None. Operate from a clean checkout of merged `main`.

- [ ] Pull the merged Phase 1 commit on `main` and record its full SHA as `PUBLISH_COMMIT`.
- [ ] From `mcp-server/`, repeat the complete release gate from Task 4.
- [ ] Confirm `npm whoami` is the intended publishing account and 2FA is active.
- [ ] Run the first publish:

```bash
npm publish --access public
```

- [ ] Confirm the registry version:

```bash
npm view @glitchwerks/bookmarks-plus-mcp@0.1.0 version
```

- [ ] In a new temporary directory, create a minimal private `package.json`, install `@glitchwerks/bookmarks-plus-mcp@0.1.0`, and start the generated local `bookmarks-plus-mcp` binary against a temporary workspace mirror.
- [ ] Send `initialize` and `tools/list`; verify both `list_bookmarks` and `add_bookmark` are returned. This is the public-registry version of the local handshake already covered by `mcp-server/test/packaging.test.ts` (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L232-L237`).
- [ ] Create `mcp-v0.1.0` on exactly `PUBLISH_COMMIT`, verify `git rev-parse mcp-v0.1.0^{commit}` equals it, and push the tag.
- [ ] Confirm no npm publish workflow runs, because Phase 2 intentionally has not merged yet.
- [ ] Record the package URL, registry check, smoke result, tag SHA, and tag verification on Issue #66.

**Gate:** Stop after this task. Start Phase 2 only after the user confirms Phase 1 merged, `0.1.0` is public, the public handshake passed, and `mcp-v0.1.0` points to the published commit.

---

## Task 6: Add a Deterministic MCP Release Validator

**Files:**
- Create: `mcp-server/scripts/validate-release.mjs`
- Create: `mcp-server/scripts/validate-release.test.mjs`
- Modify: `mcp-server/package.json`

### Step 1: Write failing validator tests

- [ ] Create `mcp-server/scripts/validate-release.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from './validate-release.mjs';

const valid = {
  tag: 'mcp-v0.1.0',
  manifest: { name: '@glitchwerks/bookmarks-plus-mcp', version: '0.1.0' },
  changelogText: '## [0.1.0] — 2026-09-19\n',
};

test('accepts an exact stable tag with matching package metadata and changelog', () => {
  assert.equal(validateRelease(valid), '0.1.0');
});

for (const tag of ['v0.1.0', 'mcp-v0.1', 'mcp-v01.1.0', 'mcp-v0.1.0-beta.1']) {
  test(`rejects malformed tag ${tag}`, () => {
    assert.throws(() => validateRelease({ ...valid, tag }), /tag/i);
  });
}

test('rejects a different package name', () => {
  assert.throws(
    () => validateRelease({ ...valid, manifest: { ...valid.manifest, name: 'bookmarks-plus-mcp' } }),
    /package name/i,
  );
});

test('rejects a manifest version that differs from the tag', () => {
  assert.throws(
    () => validateRelease({ ...valid, manifest: { ...valid.manifest, version: '0.1.1' } }),
    /version/i,
  );
});

test('rejects a missing changelog heading', () => {
  assert.throws(
    () => validateRelease({ ...valid, changelogText: '## [Unreleased]\n' }),
    /changelog/i,
  );
});
```

- [ ] Run `node --test scripts/validate-release.test.mjs` from `mcp-server/` and verify it fails because the implementation does not exist.

### Step 2: Implement the pure validator and CLI

- [ ] Create `mcp-server/scripts/validate-release.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE_NAME = '@glitchwerks/bookmarks-plus-mcp';
const TAG_PATTERN = /^mcp-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export function validateRelease({ tag, manifest, changelogText }) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must match mcp-vMAJOR.MINOR.PATCH`);
  }

  const version = match[1];
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`Package name must be ${EXPECTED_PACKAGE_NAME}; got ${manifest.name}`);
  }
  if (manifest.version !== version) {
    throw new Error(`Manifest version ${manifest.version} does not match tag version ${version}`);
  }

  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## \\[${escapedVersion}\\] — \\d{4}-\\d{2}-\\d{2}$`, 'm');
  if (!heading.test(changelogText)) {
    throw new Error(`Changelog is missing a dated heading for ${version}`);
  }
  return version;
}

export function validateCurrentRelease(rootDirectory = process.cwd()) {
  const tag = process.env.MCP_RELEASE_TAG ?? '';
  const manifest = JSON.parse(readFileSync(resolve(rootDirectory, 'package.json'), 'utf8'));
  const changelogText = readFileSync(resolve(rootDirectory, 'CHANGELOG.md'), 'utf8');
  return validateRelease({ tag, manifest, changelogText });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = validateCurrentRelease();
    console.log(`validate-release: OK (${EXPECTED_PACKAGE_NAME}@${version})`);
  } catch (error) {
    console.error(`validate-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
```

- [ ] Run `node --test scripts/validate-release.test.mjs`; verify all cases pass.

### Step 3: Wire validator tests and command

- [ ] Add this script:

```json
"verify-release": "node scripts/validate-release.mjs"
```

- [ ] Update the test script so the two script-level test files are explicit:

```json
"test": "tsc -p tsconfig.test.json && node scripts/copy-schema.mjs && node scripts/copy-test-fixtures.mjs && node --test scripts/run-tests.test.mjs scripts/validate-release.test.mjs && node scripts/run-tests.mjs"
```

- [ ] Add manifest-test assertions for `verify-release` and both script-level tests.
- [ ] Run `npm test`.
- [ ] Run the valid CLI path:

```powershell
$env:MCP_RELEASE_TAG='mcp-v0.1.0'
npm run verify-release
Remove-Item Env:MCP_RELEASE_TAG
```

- [ ] Run once with `mcp-v0.1.1` and verify it fails before restoring/removing the environment variable.
- [ ] Commit:

```text
test: validate MCP release metadata (#66)
```

---

## Task 7: Add Parser-Backed Workflow Contract Tests

**Files:**
- Create: `src/test/suite/publishMcpWorkflow.test.ts`

### Step 1: Write the test against the absent workflow

- [ ] Create `src/test/suite/publishMcpWorkflow.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  permissions?: { contents?: string; 'id-token'?: string };
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  'continue-on-error'?: boolean;
}

interface McpPublishWorkflow {
  permissions?: { contents?: string; 'id-token'?: string };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  on?: {
    push?: { tags?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> };
  };
  jobs?: Record<string, WorkflowJob>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { load } = require('js-yaml') as { load: (source: string) => McpPublishWorkflow };
const workflowPath = path.resolve(__dirname, '../../../.github/workflows/publish-mcp.yml');
const workflow = load(fs.readFileSync(workflowPath, 'utf8'));
const immutableCommit = '${{ needs.resolve-release.outputs.commit }}';

function getJob(name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  assert.ok(job, `MCP publish workflow must define the ${name} job`);
  return job;
}

function getStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert.ok(step, `job must define the ${name} step`);
  return step;
}

suite('MCP package publish workflow (#66)', () => {
  test('owns only the MCP tag lane and supports explicit-tag retries', () => {
    assert.deepStrictEqual(workflow.on?.push?.tags, ['mcp-v*.*.*']);
    assert.strictEqual(workflow.on?.workflow_dispatch?.inputs?.tag?.required, true);
    assert.strictEqual(
      workflow.concurrency?.group,
      'publish-mcp-${{ inputs.tag || github.ref_name }}'
    );
    assert.strictEqual(workflow.concurrency?.['cancel-in-progress'], false);
  });

  test('resolves one immutable tag commit', () => {
    const resolver = getJob('resolve-release');
    const checkout = getStep(resolver, 'Checkout selected release');
    const resolve = getStep(resolver, 'Resolve immutable release commit');
    assert.strictEqual(
      checkout.with?.ref,
      "${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.sha }}"
    );
    assert.strictEqual(checkout.with?.['fetch-depth'], 0);
    assert.strictEqual(checkout.with?.['persist-credentials'], false);
    assert.strictEqual(resolve.id, 'release');
    assert.match(resolve.run ?? '', /git rev-parse HEAD/);
    assert.strictEqual(resolver.outputs?.commit, '${{ steps.release.outputs.commit }}');
    assert.strictEqual(resolver.outputs?.tag, '${{ steps.release.outputs.tag }}');
  });

  test('gates publishing on lint and package verification of the immutable commit', () => {
    for (const jobName of ['lint', 'test-package']) {
      const job = getJob(jobName);
      assert.deepStrictEqual(job.needs, ['resolve-release']);
      assert.strictEqual(getStep(job, 'Checkout').with?.ref, immutableCommit);
      assert.strictEqual(getStep(job, 'Checkout').with?.['persist-credentials'], false);
      const setup = getStep(job, 'Setup Node');
      assert.strictEqual(setup.with?.['node-version'], 24);
      assert.strictEqual(setup.with?.cache, undefined);
      assert.strictEqual(getStep(job, 'Use current npm 11').run, 'npm install --global npm@11');
    }

    const packageJob = getJob('test-package');
    for (const step of [
      'Validate release metadata',
      'Test',
      'Build',
      'Verify pack contents',
      'Test installed package',
    ]) {
      assert.strictEqual(getStep(packageJob, step)['working-directory'], 'mcp-server');
    }
    assert.strictEqual(
      getStep(packageJob, 'Validate release metadata').env?.MCP_RELEASE_TAG,
      '${{ needs.resolve-release.outputs.tag }}'
    );
    assert.strictEqual(
      getStep(packageJob, 'Validate release metadata').run,
      'npm run verify-release'
    );

    const publish = getJob('publish');
    assert.deepStrictEqual(
      [...(publish.needs as string[])].sort(),
      ['lint', 'resolve-release', 'test-package']
    );
    assert.strictEqual(getStep(publish, 'Checkout').with?.ref, immutableCommit);
  });

  test('grants OIDC only to the publish job and never requests content writes', () => {
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' });
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      assert.notStrictEqual(job.permissions?.contents, 'write');
      assert.strictEqual(job.permissions?.['id-token'], name === 'publish' ? 'write' : undefined);
    }
  });

  test('publishes publicly from mcp-server without a token or GitHub Release', () => {
    const publish = getJob('publish');
    const setup = getStep(publish, 'Setup Node');
    assert.strictEqual(setup.with?.['node-version'], 24);
    assert.strictEqual(setup.with?.cache, undefined);
    assert.strictEqual(getStep(publish, 'Use current npm 11').run, 'npm install --global npm@11');
    assert.strictEqual(
      getStep(publish, 'Revalidate release metadata').env?.MCP_RELEASE_TAG,
      '${{ needs.resolve-release.outputs.tag }}'
    );
    assert.strictEqual(
      getStep(publish, 'Revalidate release metadata').run,
      'npm run verify-release'
    );
    const publishStep = getStep(publish, 'Publish');
    assert.strictEqual(publishStep['working-directory'], 'mcp-server');
    assert.strictEqual(publishStep.run, 'npm publish --access public');

    const source = fs.readFileSync(workflowPath, 'utf8');
    assert.doesNotMatch(source, /NODE_AUTH_TOKEN|secrets\..*NPM/i);
    assert.doesNotMatch(source, /action-gh-release|gh release/i);
  });

  test('does not permit failed jobs or steps to be bypassed', () => {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      assert.notStrictEqual(job['continue-on-error'], true, jobName);
      assert.notStrictEqual(job.if, 'always()', jobName);
      for (const step of job.steps ?? []) {
        assert.notStrictEqual(step['continue-on-error'], true, `${jobName}/${step.name}`);
        assert.notStrictEqual(step.if, 'always()', `${jobName}/${step.name}`);
      }
    }
  });
});
```

- [ ] Run the repository test suite and verify the new suite fails because `.github/workflows/publish-mcp.yml` is absent.

---

## Task 8: Implement the Trusted-Publishing Workflow

**Files:**
- Create: `.github/workflows/publish-mcp.yml`
- Modify: `src/test/suite/publishMcpWorkflow.test.ts` only if the first test exposed a type/parsing issue, never to weaken a security assertion.

GitHub Actions trusted publishing requires the exact workflow filename configured on npm and `id-token: write`; npm recommends a current npm CLI and automatically emits provenance for public packages from public repositories ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), fetched 2026-09-19; approved tuple at `docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L122-L140`).

### Step 1: Create the workflow

- [ ] Create `.github/workflows/publish-mcp.yml` with this job graph and commands:

```yaml
name: Publish MCP package

on:
  push:
    tags:
      - 'mcp-v*.*.*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing MCP package tag to publish (for example, mcp-v0.1.1)'
        required: true

permissions:
  contents: read

concurrency:
  group: publish-mcp-${{ inputs.tag || github.ref_name }}
  cancel-in-progress: false

jobs:
  resolve-release:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      commit: ${{ steps.release.outputs.commit }}
      tag: ${{ steps.release.outputs.tag }}
    steps:
      - name: Checkout selected release
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          ref: ${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Resolve immutable release commit
        id: release
        shell: bash
        env:
          TAG_NAME: ${{ inputs.tag || github.ref_name }}
        run: |
          echo "commit=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
          echo "tag=$TAG_NAME" >> "$GITHUB_OUTPUT"

  lint:
    needs: [resolve-release]
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          ref: ${{ needs.resolve-release.outputs.commit }}
          persist-credentials: false
      - name: Setup Node
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 24
      - name: Use current npm 11
        run: npm install --global npm@11
      - name: Install
        working-directory: mcp-server
        run: npm ci
      - name: Lint
        working-directory: mcp-server
        run: npm run lint

  test-package:
    needs: [resolve-release]
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          ref: ${{ needs.resolve-release.outputs.commit }}
          persist-credentials: false
      - name: Setup Node
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 24
      - name: Use current npm 11
        run: npm install --global npm@11
      - name: Install
        working-directory: mcp-server
        run: npm ci
      - name: Validate release metadata
        working-directory: mcp-server
        env:
          MCP_RELEASE_TAG: ${{ needs.resolve-release.outputs.tag }}
        run: npm run verify-release
      - name: Test
        working-directory: mcp-server
        run: npm test
      - name: Build
        working-directory: mcp-server
        run: npm run build
      - name: Verify pack contents
        working-directory: mcp-server
        run: npm run verify-pack
      - name: Test installed package
        working-directory: mcp-server
        run: npm run test:packaging

  publish:
    needs: [resolve-release, lint, test-package]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          ref: ${{ needs.resolve-release.outputs.commit }}
          persist-credentials: false
      - name: Setup Node
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 24
      - name: Use current npm 11
        run: npm install --global npm@11
      - name: Install
        working-directory: mcp-server
        run: npm ci
      - name: Revalidate release metadata
        working-directory: mcp-server
        env:
          MCP_RELEASE_TAG: ${{ needs.resolve-release.outputs.tag }}
        run: npm run verify-release
      - name: Publish
        working-directory: mcp-server
        run: npm publish --access public
```

### Step 2: Prove the workflow contract

- [ ] Run the focused compiled workflow test if supported by the existing test harness; otherwise run the full root `npm test`.
- [ ] Verify every Task 7 assertion passes.
- [ ] Run `npm test` from `mcp-server/` under local Node 24 and verify the cross-version launcher still passes.
- [ ] Inspect the YAML for an absent `NODE_AUTH_TOKEN`, absent repository secret dependency, absent cache, and absent GitHub Release action.
- [ ] Commit:

```text
ci: publish MCP package with trusted npm OIDC (#66)
```

---

## Task 9: Document the Recurring MCP Release Lane

**Files:**
- Modify: `docs/release-strategy.md`

- [ ] Keep the extension odd/even release procedure unchanged.
- [ ] Update the MCP package section to state that after bootstrap:
  1. package version and `mcp-server/CHANGELOG.md` are updated in a normal PR;
  2. the complete local MCP gate runs;
  3. after merge, `mcp-vX.Y.Z` is created on the intended `main` commit;
  4. pushing the tag starts `Publish MCP package`;
  5. the workflow validates the immutable tag commit, lints/tests/packages it, and publishes through OIDC;
  6. manual dispatch accepts only an existing tag and is for failures before publication;
  7. a retry after successful publication can fail because npm versions are immutable.
- [ ] Add the one-time trusted-publisher setup tuple exactly:

```text
Owner: glitchwerks
Repository: vscode-bookmarks-plus
Workflow filename: publish-mcp.yml
Environment: none
Allowed action: publish
```

- [ ] State that traditional publish tokens must be disallowed only after OIDC is verified, and document `npm trust list @glitchwerks/bookmarks-plus-mcp` as the verification command. `npm trust list` requires an authenticated current npm CLI and an existing package ([npm trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/), fetched 2026-09-19).
- [ ] Commit:

```text
docs: add the automated MCP release lane (#66)
```

---

## Task 10: Verify and Merge Phase 2

**Files:** All Phase 2 files.

- [ ] Run the root lint/test/bundle gate from Task 4.
- [ ] Run the full `mcp-server/` gate from Task 4 on Node 24/current npm 11.
- [ ] Run `MCP_RELEASE_TAG=mcp-v0.1.0 npm run verify-release` in a compatible shell and verify success without publishing.
- [ ] Run `git diff main...HEAD --stat` and reconcile every Phase 2 deliverable in the File Map.
- [ ] Verify references from changed committed files exist in `git ls-tree HEAD`.
- [ ] Scan changed files for placeholders and for forbidden `NODE_AUTH_TOKEN`, `npm_token`, `secrets.*NPM*`, or GitHub Release actions.
- [ ] Create the Phase 2 PR with `Refs #66`, not `Closes #66`, because npm trust configuration cannot happen before the workflow exists on `main` (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L122-L140`).
- [ ] Before merge, inspect all live reviews, review requests, CodeRabbit output, and CI on the exact head commit.
- [ ] Merge only after all actionable feedback is addressed and all checks pass.

---

## Task 11: Configure and Verify npm Trusted Publishing

**Files:** None.

- [ ] In npm package settings for `@glitchwerks/bookmarks-plus-mcp`, add the trusted publisher with the exact tuple from Task 9. The owner, repository, and workflow filename are case-sensitive ([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), fetched 2026-09-19).
- [ ] Select direct publish permission and no GitHub environment.
- [ ] Disallow traditional publish tokens only after the trusted publisher is saved.
- [ ] Authenticate with npm 11.15 or later and run:

```bash
npm trust list @glitchwerks/bookmarks-plus-mcp
```

- [ ] Verify the result names `glitchwerks/vscode-bookmarks-plus` and `publish-mcp.yml`.
- [ ] Record the successful trust-list result and package-setting confirmation on Issue #66 without exposing credentials.

**Gate:** Do not create a new package version merely to test OIDC. The next real `mcp-vX.Y.Z` release will exercise publication; the trust-list check is the bootstrap acceptance gate approved in the spec (`docs/superpowers/specs/2026-09-19-scoped-mcp-npm-release-design.md:L249-L253`).

---

## Task 12: Close Issue #66 and Remove the Completed Plan

**Files:**
- Delete: `docs/superpowers/plans/2026-09-19-scoped-mcp-npm-release.md`

- [ ] Confirm all of these durable artifacts exist before deleting the plan:
  - approved design spec;
  - Phase 1 and Phase 2 PRs;
  - public npm package `0.1.0`;
  - `mcp-v0.1.0` tag at the published commit;
  - Issue #66 comments recording the manual publish/handshake and trust-list verification;
  - recurring release instructions in `docs/release-strategy.md`.
- [ ] Create a fresh cleanup branch/worktree from updated `main`.
- [ ] Delete this plan. Do not delete the approved spec.
- [ ] Search committed files for this plan path and redirect any references to Issue #66, the implementation PRs, or the approved spec.
- [ ] Create a small cleanup PR whose body contains `Closes #66` and the required Codex attribution.
- [ ] Merge after the deletion/checks pass; verify Issue #66 auto-closes.

---

## Final Self-Review

- [ ] **Spec coverage:** Map every approved design section to Tasks 0–12, especially the two-phase stop gate, independent SemVer, exact scope/binary, public first publish, immutable tags, OIDC permissions, documentation split, and no GitHub Release.
- [ ] **Placeholder scan:** Run `rg -n "TODO|TBD|PLACEHOLDER|<version>|X\.Y\.Z" docs/superpowers/plans/2026-09-19-scoped-mcp-npm-release.md`; retain `X.Y.Z` only where it intentionally documents the generic release form.
- [ ] **Type consistency:** Compile both TypeScript projects and run the JS unit tests. Confirm workflow-test interfaces match the YAML keys and release-validator inputs match `package.json`/`CHANGELOG.md` shapes.
- [ ] **Security review:** Confirm only the publish job receives `id-token: write`, no npm token is present, all jobs use immutable checkout commits, and no failed gate can be bypassed.
- [ ] **Artifact persistence:** Run `git diff main...HEAD --stat`, `git ls-tree HEAD` checks for referenced paths, and ensure the new changelog, scripts, tests, workflow, and docs are committed rather than worktree-only.
