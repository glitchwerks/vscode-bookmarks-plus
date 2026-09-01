import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same import.meta.url -> directory pattern established in contract.test.ts /
// schemaDrift.test.ts / copySchema.test.ts. This compiled test file lives at
// dist/test/verifyPack.test.js, so mcp-server root is two directories up
// (dist/test -> dist -> mcp-server) and the repo root (for schemas/) is one
// further up still.
const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = join(here, '..', '..');
const repoRoot = join(mcpServerRoot, '..');

// ---------------------------------------------------------------------------
// Issue #66 / T2 (plan `docs/superpowers/plans/2026-08-30-publish-mcp-server-to-npm.md`,
// §6 T2, constraint 3.1): mcp-server/scripts/verify-pack.mjs is a permanent,
// CI-invocable regression guard. It must run `npm pack --json` and assert
// the resulting file list (a) contains dist/index.js and
// dist/bookmarks.schema.json, and (b) excludes everything under dist/test.
// The script does not exist yet -- every test below is a FROZEN, black-box
// contract for it: it invokes the not-yet-written script as a subprocess and
// only ever inspects its exit code and combined stdout/stderr.
//
// Two of the plan's own §2.1/§3.1 "verified facts" did NOT reproduce
// empirically against this real repo (npm 11.9.0, Windows) while authoring
// this file, and the scenarios below are built against the *actual*,
// empirically-confirmed behavior rather than the plan's original prose:
//
//   1. "With no `files` and no `.npmignore`, npm falls back to `.gitignore`
//      semantics, and dist/ is gitignored -- the tarball would omit exactly
//      the directory bin points at." FALSE for this layout: `npm pack`
//      (invoked with `cwd` set to the package directory, as verify-pack.mjs
//      must do) only consults a `.gitignore` literally present *at the
//      package root* (mcp-server/.gitignore, which does not exist -- only
//      the monorepo root's does, and npm never climbs to an ancestor's
//      .gitignore for this fallback). Deleting the `files` key entirely does
//      not exclude anything here -- confirmed twice against the real,
//      unmodified worktree with `files` deleted via `git restore` afterward:
//      dist came back in the pack listing in full both times.
//   2. Separately: npm ALWAYS force-includes whatever `bin` points at,
//      regardless of what `files` says -- confirmed with `files: []` and
//      with `files: ["README.md"]`, both of which still shipped
//      dist/index.js. So dist/index.js surviving a pack is *not* evidence
//      that a `files` allowlist is correct; only dist/bookmarks.schema.json
//      (never referenced by `bin`/`main`) actually depends on `files` being
//      right. This is why scenario 2 below asserts on the schema file
//      specifically, not on dist/index.js.
//
// The reliable way to reproduce the under-inclusion bug is therefore not
// "delete the `files` key" (the dispatch brief's primary phrasing) but its
// own parenthetical alternative -- "set it to something that doesn't
// include `dist`" -- confirmed to reproducibly drop
// dist/bookmarks.schema.json from the pack listing while dist/index.js (the
// bin target) survives regardless.
//
// (Free finding, recorded for the plan: `npm pack --dry-run` DID run
// `prepack` on this npm version -- its "> prepack / > npm run build" output
// appeared even under `--dry-run`. Constraint 3.2's --dry-run caveat is
// belt-and-braces here, not load-bearing.)
// ---------------------------------------------------------------------------

interface PackageManifest {
  files?: string[];
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

interface ExecError extends Error {
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readRealManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(mcpServerRoot, 'package.json'), 'utf8')) as PackageManifest;
}

/**
 * Builds an isolated scratch tree containing the real, on-disk
 * scripts/src/tsconfig files plus the repo-root schemas/ directory that
 * copy-schema.mjs and the `prepack` build chain need to resolve --
 * mirroring copySchema.test.ts's convention of exercising the real scripts
 * against a throwaway copy rather than the live tree, so this suite never
 * writes into the real mcp-server/dist that a concurrently-running
 * `node --test` invocation depends on.
 *
 * node_modules is linked, not copied: a recursive copy would duplicate
 * ~7000 files / ~70MB per test run for no benefit -- `prepack`'s `tsc` step
 * only needs `tsc` resolvable from node_modules/.bin, which a link provides
 * exactly as well as a copy would. `'junction'` is unprivileged on Windows
 * and is ignored (falls back to a plain symlink) on POSIX, so this works
 * unmodified on both CI legs T4 adds (ci.yml's ubuntu-latest /
 * windows-latest matrix).
 *
 * `mutateManifest` lets each scenario adjust the copied package.json's
 * `files` / `scripts` before packing, without ever touching the real
 * mcp-server/package.json -- every mutation below writes only into the
 * scratch copy.
 */
function buildScratchTree(mutateManifest?: (pkg: PackageManifest) => void): {
  scratchRoot: string;
  scratchMcpServerRoot: string;
} {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'bookmarks-verify-pack-test-'));
  tempDirs.push(scratchRoot);

  const scratchMcpServerRoot = join(scratchRoot, 'mcp-server');
  mkdirSync(scratchMcpServerRoot, { recursive: true });
  mkdirSync(join(scratchRoot, 'schemas'), { recursive: true });

  cpSync(
    join(repoRoot, 'schemas', 'bookmarks.schema.json'),
    join(scratchRoot, 'schemas', 'bookmarks.schema.json'),
  );

  for (const entry of ['scripts', 'src']) {
    cpSync(join(mcpServerRoot, entry), join(scratchMcpServerRoot, entry), { recursive: true });
  }
  for (const tsconfig of ['tsconfig.json', 'tsconfig.build.json', 'tsconfig.test.json']) {
    cpSync(join(mcpServerRoot, tsconfig), join(scratchMcpServerRoot, tsconfig));
  }
  // README.md / LICENSE: T1 added both (npm auto-includes them regardless of
  // `files`, same as package.json). E1's own pass criteria (plan §4) list
  // them alongside dist/index.js and dist/bookmarks.schema.json, so a
  // correct verify-pack.mjs may reasonably assert on all four -- without
  // these two, that correct implementation would fail scenario 1 against
  // this scratch tree for a reason that has nothing to do with the bug
  // scenario 1 is meant to prove is fixed.
  for (const file of ['README.md', 'LICENSE']) {
    const src = join(mcpServerRoot, file);
    if (existsSync(src)) {
      cpSync(src, join(scratchMcpServerRoot, file));
    }
  }

  symlinkSync(join(mcpServerRoot, 'node_modules'), join(scratchMcpServerRoot, 'node_modules'), 'junction');

  const manifest = readRealManifest();
  mutateManifest?.(manifest);
  writeFileSync(join(scratchMcpServerRoot, 'package.json'), JSON.stringify(manifest, null, 2));

  return { scratchRoot, scratchMcpServerRoot };
}

/**
 * Precondition every scenario below shares: verify-pack.mjs must exist in
 * the scratch tree's scripts/ directory before this suite can exercise it.
 * T2 has not landed yet, so today this fails on its own, cleanly, in all
 * three scenarios -- that clean assertion failure (rather than an ENOENT /
 * MODULE_NOT_FOUND crash surfacing out of execFileSync) is the correct red
 * for a script that has not been written yet.
 */
function assertVerifyPackExists(scratchMcpServerRoot: string): void {
  assert.ok(
    existsSync(join(scratchMcpServerRoot, 'scripts', 'verify-pack.mjs')),
    "mcp-server/scripts/verify-pack.mjs does not exist yet (T2). See the plan's §6 T2 for " +
      'the contract this suite exercises: run `npm pack --json`, assert dist/index.js and ' +
      'dist/bookmarks.schema.json are present, and dist/test/** is absent.',
  );
}

/** Result of one verify-pack.mjs invocation, combining stdout+stderr so
 * assertions can search either stream without caring which one a given
 * implementation writes diagnostics to. */
interface VerifyPackResult {
  status: number | null;
  output: string;
}

function runVerifyPack(scratchMcpServerRoot: string): VerifyPackResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(scratchMcpServerRoot, 'scripts', 'verify-pack.mjs')],
      { cwd: scratchMcpServerRoot, encoding: 'utf8' },
    );
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as ExecError;
    const stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '');
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
    return { status: e.status ?? 1, output: `${stdout}${stderr}` };
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 -- current (post-T1) tree, real build. verify-pack.mjs must
// build the tree itself via `npm pack`'s own `prepack` (constraint 3.2,
// post-T1 form) -- this test supplies no preceding explicit `npm run build`.
// ---------------------------------------------------------------------------

test('verify-pack.mjs exits 0 against the current (post-T1) manifest, whose files allowlist is already correct', () => {
  const { scratchMcpServerRoot } = buildScratchTree();
  assertVerifyPackExists(scratchMcpServerRoot);

  const result = runVerifyPack(scratchMcpServerRoot);

  assert.equal(
    result.status,
    0,
    'expected verify-pack.mjs to exit 0 against the unmodified, already-correct manifest ' +
      `(files: ${JSON.stringify(readRealManifest().files)}).\n--- combined output ---\n${result.output}`,
  );
});

// ---------------------------------------------------------------------------
// Scenario 2 -- simulated pre-T1 bug #1: a `files` allowlist that omits
// `dist` (constraint 3.1's under-inclusion half). See the file header for
// why this is built as `files: []` rather than deleting the `files` key.
// ---------------------------------------------------------------------------

test('verify-pack.mjs fails when `files` omits dist, because dist/bookmarks.schema.json does not survive that allowlist', () => {
  const { scratchMcpServerRoot } = buildScratchTree((pkg) => {
    pkg.files = [];
  });
  assertVerifyPackExists(scratchMcpServerRoot);

  const result = runVerifyPack(scratchMcpServerRoot);

  assert.notEqual(
    result.status,
    0,
    'expected verify-pack.mjs to fail when `files` does not include dist -- ' +
      'dist/bookmarks.schema.json is not shipped in that case (unlike dist/index.js, which npm ' +
      'always force-includes via `bin` regardless of `files` -- see the file header).\n' +
      `--- combined output ---\n${result.output}`,
  );
  assert.ok(
    /dist[\\/]bookmarks\.schema\.json/.test(result.output),
    "expected verify-pack.mjs's failure output to name the missing path, " +
      `dist/bookmarks.schema.json.\n--- combined output ---\n${result.output}`,
  );
});

// ---------------------------------------------------------------------------
// Scenario 3 -- simulated pre-T1 bug #2: a naive `files: ["dist"]` allowlist
// (no dist/test exclusion) combined with the pre-T1 build wiring that
// recreated dist/test/fixtures on every build (constraint 3.1's
// over-inclusion half). `prepack`'s `clean` step wipes dist/ before every
// pack, so a fixture file merely dropped into dist/ ahead of time would not
// survive to be packed -- the leak must come from something the build
// itself recreates, exactly as it did before T1(a)'s fixture-copy split.
// ---------------------------------------------------------------------------

test('verify-pack.mjs fails when `files` is a naive ["dist"] and the build recreates dist/test/fixtures', () => {
  const { scratchMcpServerRoot } = buildScratchTree((pkg) => {
    pkg.files = ['dist'];
    const scripts = pkg.scripts;
    if (!scripts || typeof scripts.build !== 'string') {
      throw new Error('expected package.json to declare a string `build` script');
    }
    // Mirrors the pre-T1 wiring constraint 3.1 describes: copy-schema.mjs
    // used to copy test/fixtures into dist/test/fixtures on every build,
    // unconditionally. T1 moved that call out of `build` and into `test`
    // only (packageManifest.test.ts pins that wiring); this reintroduces
    // the old call from `build` to reproduce the leak this test targets,
    // without touching the real, already-fixed copy-schema.mjs source.
    scripts.build = `${scripts.build} && node scripts/copy-test-fixtures.mjs`;
  });
  assertVerifyPackExists(scratchMcpServerRoot);

  // copy-test-fixtures.mjs (invoked above from `build`) reads test/fixtures/
  // -- present in the real tree, but not copied into the scratch tree by
  // buildScratchTree() (no other scenario needs it), so it is added here,
  // scoped to this one test.
  cpSync(join(mcpServerRoot, 'test', 'fixtures'), join(scratchMcpServerRoot, 'test', 'fixtures'), {
    recursive: true,
  });

  const result = runVerifyPack(scratchMcpServerRoot);

  assert.notEqual(
    result.status,
    0,
    'expected verify-pack.mjs to fail when `files: ["dist"]` ships everything the build ' +
      'produces, including dist/test/fixtures/** recreated by a build wired the pre-T1 way.\n' +
      `--- combined output ---\n${result.output}`,
  );
  assert.ok(
    /dist[\\/]test/.test(result.output),
    `expected verify-pack.mjs's failure output to name a path under dist/test.\n--- combined output ---\n${result.output}`,
  );
});
