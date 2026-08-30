import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same import.meta.url -> directory pattern established in contract.test.ts /
// schemaDrift.test.ts. This compiled test file lives at
// dist/test/copyTestFixtures.test.js, so mcp-server root is two directories
// up (dist/test -> dist -> mcp-server).
const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = join(here, '..', '..');

// Issue #66 / T1, constraint 3.1(a): the fixture-copy logic that today lives
// (buggily) inside copy-schema.mjs must move into a brand-new
// mcp-server/scripts/copy-test-fixtures.mjs, invoked only by the `test` npm
// script. Until T1 lands, that file does not exist at all -- this suite's
// setup step below fails with ENOENT, which is this test's correct red.

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Recursively lists every file under `dir` as paths relative to `dir`, sorted, for deep content comparison. */
function listFilesRecursively(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Builds an isolated scratch tree containing test/fixtures and the whole
 * real, currently-on-disk scripts/ directory, mirroring the relative layout
 * copy-test-fixtures.mjs expects (script under mcp-server/scripts/, fixtures
 * under mcp-server/test/fixtures/) since the script locates everything
 * relative to its own `import.meta.url`, not to `cwd`.
 *
 * The whole scripts/ directory is copied (not just the one file) so this
 * test survives an implementer factoring shared copy logic into a sibling
 * helper module -- a single-file copy would turn that refactor into an
 * unrelated module-not-found failure in this frozen test.
 *
 * The explicit `existsSync` assertion below is deliberate: without it, a
 * missing script produces an ENOENT thrown from inside `cpSync`, which is
 * indistinguishable from a broken test helper. This test's whole point,
 * pre-T1, is to fail with a clean, named assertion instead.
 */
function buildScratchTree(): { scratchMcpServerRoot: string; scratchScriptPath: string } {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'bookmarks-copy-fixtures-test-'));
  tempDirs.push(scratchRoot);

  const scratchMcpServerRoot = join(scratchRoot, 'mcp-server');
  mkdirSync(join(scratchMcpServerRoot, 'test'), { recursive: true });

  cpSync(join(mcpServerRoot, 'test', 'fixtures'), join(scratchMcpServerRoot, 'test', 'fixtures'), {
    recursive: true,
  });

  const realScriptPath = join(mcpServerRoot, 'scripts', 'copy-test-fixtures.mjs');
  assert.ok(
    existsSync(realScriptPath),
    'mcp-server/scripts/copy-test-fixtures.mjs must exist (T1 constraint 3.1(a)): the fixture-copy ' +
      'logic that today lives inside copy-schema.mjs must be split out into this new script',
  );

  cpSync(join(mcpServerRoot, 'scripts'), join(scratchMcpServerRoot, 'scripts'), {
    recursive: true,
  });

  const scratchScriptPath = join(scratchMcpServerRoot, 'scripts', 'copy-test-fixtures.mjs');
  return { scratchMcpServerRoot, scratchScriptPath };
}

test('copy-test-fixtures.mjs copies every file under test/fixtures into dist/test/fixtures', () => {
  const { scratchMcpServerRoot, scratchScriptPath } = buildScratchTree();

  execFileSync(process.execPath, [scratchScriptPath], { cwd: scratchMcpServerRoot });

  const sourceFiles = listFilesRecursively(join(scratchMcpServerRoot, 'test', 'fixtures'));
  const destFiles = listFilesRecursively(join(scratchMcpServerRoot, 'dist', 'test', 'fixtures'));

  assert.ok(sourceFiles.length > 0, 'test setup sanity check: the fixtures source must be non-empty');
  assert.deepEqual(
    destFiles,
    sourceFiles,
    'copy-test-fixtures.mjs must copy every file under test/fixtures into dist/test/fixtures, ' +
      'matching exactly (same relative paths)',
  );
});
