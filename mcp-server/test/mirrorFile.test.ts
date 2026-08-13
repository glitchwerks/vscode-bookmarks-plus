import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMirror, writeMirrorAtomic } from '../src/mirrorFile.js';

// Tracks every temp directory created by makeTempDir() so they can all be
// removed in a single `after` hook, regardless of which test created them
// or whether that test failed partway through.
const tempDirs: string[] = [];

/**
 * Creates a fresh real temp directory for a single test and registers it
 * for cleanup. No mocking of `fs` anywhere in this file — every assertion
 * below exercises the real filesystem, per the plan's Task 3 / D4 test
 * strategy (real-filesystem integration for mirrorFile.ts).
 */
async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-mirror-test-'));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test('readMirror resolves undefined for a missing file rather than rejecting', async () => {
  const dir = await makeTempDir();
  const missingPath = path.join(dir, 'bookmarks.json');

  const result = await readMirror(missingPath);

  assert.equal(result, undefined);
});

test('readMirror resolves the exact contents of an existing file', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'bookmarks.json');
  const contents = '{"version":2,"items":[],"collections":[]}\n';
  await fs.writeFile(filePath, contents, 'utf8');

  const result = await readMirror(filePath);

  assert.equal(result, contents);
});

test('readMirror rethrows a non-ENOENT error instead of resolving undefined', async () => {
  // A directory cannot be read as a file: attempting to do so reliably
  // produces a non-ENOENT fs error (verified as EISDIR on both POSIX and
  // this Windows/libuv environment) without mocking fs. The assertion
  // below checks the contract ("any other error rethrows") rather than
  // pinning the exact errno, which is a platform detail the spec never
  // names.
  const dir = await makeTempDir();
  const directoryAsTarget = path.join(dir, 'iAmADirectory');
  await fs.mkdir(directoryAsTarget);

  await assert.rejects(
    () => readMirror(directoryAsTarget),
    (error: unknown) =>
      error instanceof Error &&
      typeof (error as NodeJS.ErrnoException).code === 'string' &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT',
  );
});

test('writeMirrorAtomic creates a missing target directory before writing', async () => {
  const dir = await makeTempDir();
  const nestedDir = path.join(dir, '.vscode');
  const targetPath = path.join(nestedDir, 'bookmarks.json');
  const content = '{"version":2,"items":[],"collections":[]}\n';

  await assert.rejects(() => fs.stat(nestedDir));

  await writeMirrorAtomic(targetPath, content);

  const stat = await fs.stat(nestedDir);
  assert.ok(stat.isDirectory());
  assert.equal(await fs.readFile(targetPath, 'utf8'), content);
});

test('writeMirrorAtomic leaves no temporary file behind after a successful write', async () => {
  const dir = await makeTempDir();
  const targetPath = path.join(dir, 'bookmarks.json');

  await writeMirrorAtomic(targetPath, '{"version":2,"items":[],"collections":[]}\n');

  const entries = await fs.readdir(dir);
  const leftoverTempFiles = entries.filter((entry) => entry.endsWith('.tmp'));
  assert.deepEqual(leftoverTempFiles, []);
});

test('writeMirrorAtomic round-trips content byte-for-byte, including a trailing newline', async () => {
  const dir = await makeTempDir();
  const targetPath = path.join(dir, 'bookmarks.json');
  const content = '{"version":2,"items":[{"id":"a"}],"collections":[]}\n';

  await writeMirrorAtomic(targetPath, content);
  const readBack = await readMirror(targetPath);

  // Exact equality, not a trimmed comparison — a missing or extra
  // trailing newline would silently break the extension's hash-based
  // echo suppression (Global Constraint 12).
  assert.equal(readBack, content);
});

test('writeMirrorAtomic surfaces the real underlying error when the target directory cannot be created', async () => {
  const dir = await makeTempDir();
  // A plain file occupies the path segment that writeMirrorAtomic must
  // mkdir -p through, so directory creation fails with a genuine fs
  // error (ENOTDIR on both POSIX and this Windows/libuv environment)
  // rather than something swallowed or generic.
  const blockerFilePath = path.join(dir, 'blocker');
  await fs.writeFile(blockerFilePath, 'not a directory');
  const targetPath = path.join(blockerFilePath, 'nested', 'bookmarks.json');

  // Assert the errno *shape* (a real Node fs error code), not a specific
  // literal — the exact code Node normalizes this scenario to (ENOTDIR
  // vs. EEXIST) has varied across Node majors/platforms, and the spec's
  // requirement is "surfaces the real underlying error … not a
  // swallowed/generic error", not a specific errno.
  await assert.rejects(
    () => writeMirrorAtomic(targetPath, '{"version":2,"items":[],"collections":[]}\n'),
    (error: unknown) =>
      error instanceof Error &&
      /^E[A-Z]+$/.test(String((error as NodeJS.ErrnoException).code)),
  );

  // The blocker file itself must be untouched — the failure must not
  // have partially clobbered anything on its way to surfacing the error.
  assert.equal(await fs.readFile(blockerFilePath, 'utf8'), 'not a directory');
});
