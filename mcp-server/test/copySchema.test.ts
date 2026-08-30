import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same import.meta.url -> directory pattern established in contract.test.ts /
// schemaDrift.test.ts, for the same reason: import.meta.dirname needs Node
// >=20.11 and is not reliably typed against this project's pinned
// @types/node. This compiled test file lives at dist/test/copySchema.test.js,
// so mcp-server root is two directories up (dist/test -> dist -> mcp-server)
// and the repo root (for schemas/) is one further up still.
const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = join(here, '..', '..');
const repoRoot = join(mcpServerRoot, '..');

// Issue #66 / T1, constraint 3.1(a): a plain `npm run build` must never emit
// dist/test/** -- today it does, because copy-schema.mjs unconditionally
// copies test/fixtures into dist/test/fixtures on every run (guarded only by
// `existsSync(fixturesSrc)`, which is always true since fixtures are
// committed). T1 requires that fixture-copy logic to move out of
// copy-schema.mjs entirely, into a new copy-test-fixtures.mjs invoked only
// from the `test` npm script.

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Builds an isolated scratch tree containing just what copy-schema.mjs needs
 * to resolve on its own -- it locates everything relative to its own
 * `import.meta.url`, not to `cwd` -- and copies the *real, currently-on-disk*
 * script into it so this test exercises the actual file under test rather
 * than a stand-in.
 *
 * Every write happens inside a throwaway temp directory. This deliberately
 * never touches the real mcp-server/dist that the currently-running
 * `node --test dist/test` invocation depends on for its own compiled test
 * files -- clobbering that directory mid-run would make every other test
 * file in this suite unreliable, not just this one.
 */
function buildScratchTree(): { scratchMcpServerRoot: string } {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'bookmarks-copy-schema-test-'));
  tempDirs.push(scratchRoot);

  const scratchMcpServerRoot = join(scratchRoot, 'mcp-server');
  mkdirSync(join(scratchMcpServerRoot, 'scripts'), { recursive: true });
  mkdirSync(join(scratchRoot, 'schemas'), { recursive: true });

  cpSync(
    join(repoRoot, 'schemas', 'bookmarks.schema.json'),
    join(scratchRoot, 'schemas', 'bookmarks.schema.json'),
  );

  // Copies the whole scripts/ directory, not just copy-schema.mjs, so this
  // test survives an implementer factoring shared copy logic into a sibling
  // helper module (e.g. scripts/lib/copy-dir.mjs) -- a single-file copy
  // would turn that refactor into a module-not-found failure in this frozen
  // test, which is not a real regression.
  cpSync(join(mcpServerRoot, 'scripts'), join(scratchMcpServerRoot, 'scripts'), {
    recursive: true,
  });

  // Committed today (mcp-server/test/fixtures has 8 files per the plan's
  // §2.1), which is exactly what makes the pre-T1 leak reproducible here:
  // copy-schema.mjs's fixture-copy branch is gated only on
  // `existsSync(fixturesSrc)`.
  if (existsSync(join(mcpServerRoot, 'test', 'fixtures'))) {
    cpSync(join(mcpServerRoot, 'test', 'fixtures'), join(scratchMcpServerRoot, 'test', 'fixtures'), {
      recursive: true,
    });
  }

  return { scratchMcpServerRoot };
}

test('copy-schema.mjs copies the schema into dist/bookmarks.schema.json', () => {
  const { scratchMcpServerRoot } = buildScratchTree();

  execFileSync(process.execPath, [join(scratchMcpServerRoot, 'scripts', 'copy-schema.mjs')], {
    cwd: scratchMcpServerRoot,
  });

  assert.ok(
    existsSync(join(scratchMcpServerRoot, 'dist', 'bookmarks.schema.json')),
    'copy-schema.mjs must copy the schema to dist/bookmarks.schema.json',
  );
});

test('copy-schema.mjs never writes anything under dist/test (T1 constraint 3.1(a))', () => {
  const { scratchMcpServerRoot } = buildScratchTree();

  execFileSync(process.execPath, [join(scratchMcpServerRoot, 'scripts', 'copy-schema.mjs')], {
    cwd: scratchMcpServerRoot,
  });

  assert.ok(
    !existsSync(join(scratchMcpServerRoot, 'dist', 'test')),
    'copy-schema.mjs must do only the schema copy after T1 -- the fixture-copy logic belongs in ' +
      'scripts/copy-test-fixtures.mjs, invoked only from the `test` npm script and never from ' +
      '`build`. This currently fails because the on-disk copy-schema.mjs still copies test/fixtures ' +
      'into dist/test/fixtures unconditionally (mcp-server/scripts/copy-schema.mjs:23-29) -- a plain ' +
      '`npm run build` leaks test fixtures into the publishable dist/.',
  );
});
