import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  buildNodeTestArguments,
  discoverTestFiles,
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

test('discoverTestFiles rejects an empty suite', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bookmarks-mcp-empty-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => discoverTestFiles(root), /no \.test\.js files/i);
});
