import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same import.meta.url -> directory pattern established in contract.test.ts
// / schemaDrift.test.ts. This compiled test file lives at
// dist/test/packageManifest.test.js, so mcp-server/package.json sits two
// directories up (dist/test -> dist -> mcp-server).
const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, '..', '..', 'package.json');

interface PackageManifest {
  private?: boolean;
  version?: string;
  description?: string;
  license?: string;
  repository?: Record<string, unknown> | string;
  homepage?: string;
  bugs?: unknown;
  engines?: { node?: string };
  keywords?: string[];
  author?: unknown;
  files?: unknown;
  scripts?: Record<string, string>;
}

function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageManifest;
}

// Issue #66 / T1(b) + constraint 3.1 + D2 + D6: mcp-server/package.json must
// become a publishable manifest. Every assertion below is checked against
// mcp-server/package.json:1-29 as it stands today (per the plan's §2.1 facts
// table) and is expected to fail until T1 lands.

test('mcp-server/package.json is publishable: no "private": true (T1, constraint 3.1)', () => {
  const pkg = readManifest();
  assert.notEqual(
    pkg.private,
    true,
    'package.json must not carry "private": true once T1 lands -- that flag blocks `npm publish` outright',
  );
});

test('mcp-server/package.json declares the first published version, 0.1.0 (D2)', () => {
  const pkg = readManifest();
  assert.equal(pkg.version, '0.1.0');
});

test('mcp-server/package.json description no longer references the internal issue #52', () => {
  const pkg = readManifest();
  assert.ok(
    typeof pkg.description === 'string' && !pkg.description.includes('(issue #52)'),
    'description becomes the npm listing blurb once published -- it must not carry the internal ' +
      '"(issue #52)" reference',
  );
});

test('mcp-server/package.json declares a `files` allowlist that is not a bare ["dist"] (D6 + constraint 3.1)', () => {
  const pkg = readManifest();
  assert.ok(
    Array.isArray(pkg.files),
    'package.json must declare a `files` array -- D6 resolved the mechanism to `files`, not ' +
      '`.npmignore` or the .gitignore fallback that applies when neither is present',
  );

  const files = pkg.files as unknown[];
  const isWholeDistTree =
    files.length === 1 &&
    typeof files[0] === 'string' &&
    ['dist', 'dist/', 'dist/*', 'dist/**', './dist'].includes((files[0] as string).replace(/\\/g, '/'));
  assert.ok(
    !isWholeDistTree,
    '`files: ["dist"]` (or an equivalent whole-directory form) alone would ship dist/test/** ' +
      '(where copy-schema.mjs / copy-test-fixtures.mjs write fixtures) into the published tarball ' +
      '-- constraint 3.1 forbids exactly this value',
  );
});

test('mcp-server/package.json `files` excludes everything under dist/test (constraint 3.1(b))', () => {
  const pkg = readManifest();
  const files = (Array.isArray(pkg.files) ? pkg.files : []) as unknown[];
  assert.ok(files.length > 0, 'files must be a non-empty array');

  const stringFiles = files
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.replace(/\\/g, '/'));

  // Recognizes any of the common whole-directory spellings a `files` entry
  // could use to include all of dist/ -- not just the literal string
  // "dist". A predicate that only matched "dist" exactly would let
  // "dist/" or "dist/**" (which ship exactly the same dist/test/** content)
  // pass this guard silently.
  const wholeDistTreeForms = ['dist', 'dist/', 'dist/*', 'dist/**', './dist'];
  const hasWholeDistDirectory = stringFiles.some((f) => wholeDistTreeForms.includes(f));
  const excludesDistTest = stringFiles.some(
    (f) => f.startsWith('!') && f.replace(/^!/, '').includes('dist/test'),
  );
  const explicitlyListsDistTest = stringFiles.some(
    (f) => !f.startsWith('!') && f.includes('dist/test'),
  );

  if (hasWholeDistDirectory) {
    // Directory form: a whole-tree "dist" entry ships everything unless
    // paired with an explicit negation entry excluding dist/test.
    assert.ok(
      excludesDistTest,
      'a whole-directory "dist" entry in `files` ships everything under dist/, including ' +
        'dist/test/** -- pair it with an explicit "!dist/test/**"-style exclusion entry, or switch ' +
        'to explicit enumeration of the published artifacts instead',
    );
  } else {
    // Enumeration form: safe as long as no entry explicitly names dist/test.
    assert.ok(
      !explicitlyListsDistTest,
      '`files` must not explicitly enumerate anything under dist/test',
    );
  }
});

test('mcp-server/package.json declares license, repository.directory, homepage, bugs, engines.node, keywords, and author (T1(b))', () => {
  const pkg = readManifest();

  assert.equal(pkg.license, 'MIT');

  assert.ok(
    typeof pkg.repository === 'object' &&
      pkg.repository !== null &&
      (pkg.repository as { directory?: string }).directory === 'mcp-server',
    'repository must be an object whose "directory" is "mcp-server" (this package is published ' +
      'from a subdirectory of the monorepo, not the repo root)',
  );

  assert.ok(
    typeof pkg.homepage === 'string' && pkg.homepage.length > 0,
    'homepage must be a non-empty string',
  );

  assert.ok(pkg.bugs !== undefined && pkg.bugs !== null, 'bugs must be present');

  assert.equal(
    pkg.engines?.node,
    '>=18',
    'engines.node must be ">=18", matching the @modelcontextprotocol/sdk floor',
  );

  assert.ok(
    Array.isArray(pkg.keywords) && pkg.keywords.length > 0,
    'keywords must be a non-empty array',
  );

  assert.ok(
    pkg.author !== undefined &&
      pkg.author !== null &&
      !(typeof pkg.author === 'string' && pkg.author.trim() === ''),
    'author must be present and non-empty',
  );
});

test('mcp-server/package.json builds on `prepack`, not `prepublishOnly` (constraint 3.2)', () => {
  const pkg = readManifest();
  const scripts = pkg.scripts ?? {};

  assert.equal(
    scripts.prepublishOnly,
    undefined,
    'prepublishOnly only runs on `npm publish`, never on `npm pack` -- constraint 3.2 requires the ' +
      'build to run before packing too, so this hook must be removed (keeping both would double-' +
      'build on publish)',
  );

  assert.ok(
    typeof scripts.prepack === 'string' && scripts.prepack.includes('build'),
    'prepack must run the build so `npm pack` (not only `npm publish`) produces fresh dist/ output',
  );
});

test('the `build` script never invokes copy-test-fixtures.mjs (T1 constraint 3.1(a))', () => {
  // copySchema.test.ts / copyTestFixtures.test.ts prove each script's own
  // behavior in isolation; this test is the one that pins the *wiring*
  // between them -- without it, an implementer could add
  // copy-test-fixtures.mjs and still (incorrectly) call it from `build`,
  // which is the exact bug constraint 3.1(a) requires fixing (a plain
  // `npm run build` must never emit dist/test/**).
  const scripts = readManifest().scripts ?? {};
  assert.ok(
    typeof scripts.build === 'string' && !scripts.build.includes('copy-test-fixtures'),
    'the `build` script must not invoke copy-test-fixtures.mjs -- fixture output belongs to `test` only',
  );
});

test('the `test` script invokes copy-test-fixtures.mjs', () => {
  // Substring check only, deliberately: this assertion must not pin the
  // rest of the command's shape (see the sibling glob-metacharacter test
  // below for the `node --test` argument itself).
  const scripts = readManifest().scripts ?? {};
  assert.ok(
    typeof scripts.test === 'string' && scripts.test.includes('copy-test-fixtures.mjs'),
    'fixtures must still reach dist/test/fixtures via the `test` script after the split ' +
      '(scripts/copy-test-fixtures.mjs, invoked from `test`, not `build`)',
  );
});

test('the `test` script\'s `node --test` argument is not a quoted glob (PR #113 CI regression)', () => {
  // Node's `--test` CLI flag only glob-expands a quoted pattern like
  // "dist/test/**/*.test.js" on Node 21+; on Node 18/20 (what CI's
  // actions/setup-node@v4 pins via node-version: '20.x') the shell passes
  // the quoted string through literally, `--test` treats it as a literal
  // path, finds no such file, and the whole `npm test` step fails with
  // "Could not find '.../dist/test/**/*.test.js'" -- see PR #113 / issue
  // #66, CI run 33346984629. The fix is the directory form (`node --test
  // dist/test`), which both Node 18/20 and 21+ discover correctly. This
  // test pins that shape so the quoted glob cannot silently return.
  const scripts = readManifest().scripts ?? {};
  const testScript = scripts.test ?? '';
  const match = testScript.match(/node --test (\S+)/);
  assert.ok(match, 'the `test` script must invoke `node --test <arg>`');
  const testArg = match![1];
  assert.ok(
    !/[*"]/.test(testArg),
    `the \`node --test\` argument must not be a quoted glob (Node <21 does not expand it) -- got ${JSON.stringify(testArg)}`,
  );
});
