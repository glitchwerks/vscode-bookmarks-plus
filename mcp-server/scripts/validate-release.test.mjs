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
