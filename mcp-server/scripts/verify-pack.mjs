#!/usr/bin/env node
// Regression guard for issue #66 / T2 (plan
// docs/superpowers/plans/2026-08-30-publish-mcp-server-to-npm.md, §6 T2,
// constraint 3.1): runs `npm pack --dry-run --json` (which invokes `prepack`
// -> the real build, per T1's move off `prepublishOnly`) against the package
// in the current working directory, and asserts the resulting tarball's file
// list is correct:
//   - dist/index.js and dist/bookmarks.schema.json must both be present
//     (constraint 3.1's under-inclusion half)
//   - nothing under dist/test/ may be present
//     (constraint 3.1's over-inclusion half)
//
// Exits 0 on success. Exits non-zero on failure, printing a diagnostic that
// names the specific missing or leaked path(s).
//
// `execSync` (not `execFileSync`/`spawnSync`) is used deliberately: on
// Windows, `npm` is a `.cmd` shim rather than a direct executable, and a bare
// spawn without a shell throws ENOENT. `execSync` always spawns through a
// shell, so it resolves `npm` correctly on both Windows and POSIX without
// needing an explicit `shell: true` option.
import { execSync } from 'node:child_process';

const REQUIRED_PATHS = ['dist/index.js', 'dist/bookmarks.schema.json'];
const FORBIDDEN_PREFIX = 'dist/test/';

/**
 * Runs `npm pack --dry-run --json` in the current working directory and
 * returns the packed file paths (posix-style, forward slashes) it reports.
 *
 * `--dry-run` avoids leaving a `.tgz` artifact behind on every invocation of
 * this guard, while still running `prepack` on the npm version this repo
 * uses (confirmed empirically while authoring the frozen test this script
 * satisfies -- see mcp-server/test/verifyPack.test.ts's file header).
 *
 * @returns {string[]} the `path` field of every entry in the pack's file list.
 */
function getPackedPaths() {
  let stdout;
  try {
    stdout = execSync('npm pack --dry-run --json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`verify-pack: \`npm pack --dry-run --json\` failed to run: ${err.message}`);
    if (err.stdout) console.error(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    process.exit(1);
  }

  // Defensive: some npm versions/configurations can emit warnings to stdout
  // ahead of the JSON payload. Locate the start of the JSON array/object
  // rather than assuming stdout is pure JSON.
  const jsonStart = stdout.search(/[[{]/);
  const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error(
      `verify-pack: failed to parse \`npm pack --json\` output as JSON: ${err.message}`,
    );
    console.error(stdout);
    process.exit(1);
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    console.error('verify-pack: unexpected `npm pack --json` output shape (no files array found).');
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }

  return entry.files.map((file) => String(file.path).replace(/\\/g, '/'));
}

const packedPaths = getPackedPaths();
const packedSet = new Set(packedPaths);

const errors = [];

for (const requiredPath of REQUIRED_PATHS) {
  if (!packedSet.has(requiredPath)) {
    errors.push(`missing ${requiredPath} from packed files -- must name ${requiredPath}`);
  }
}

const leakedPaths = packedPaths.filter((path) => path.startsWith(FORBIDDEN_PREFIX));
for (const leaked of leakedPaths) {
  errors.push(`${leaked} must not be in the packed tarball -- must name a path under dist/test`);
}

if (errors.length > 0) {
  console.error('verify-pack: packed tarball contents are incorrect:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `verify-pack: OK (${packedPaths.length} files packed; dist/index.js and ` +
    'dist/bookmarks.schema.json present, no dist/test leakage)',
);
process.exit(0);
