import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BackendError, type BookmarkBackend, type MirrorListResult } from '../src/backend.js';
import { createListHandler } from '../src/tools/list.js';

const listResult: MirrorListResult = {
  workspacePath: '/workspace',
  mirrorPath: '/workspace/.vscode/bookmarks.json',
  version: 2,
  collections: [{ id: 'c1', name: 'Work', order: 0, scope: 'workspace' }],
  items: [{ id: 'i1', type: 'file', uri: 'file:///workspace/a.ts', collectionId: 'c1', order: 0, scope: 'workspace' }],
};

function fakeBackend(overrides: Partial<BookmarkBackend> = {}): BookmarkBackend {
  return {
    mode: 'mirror',
    list: async () => listResult,
    add: async () => { throw new Error('unused'); },
    close: async () => {},
    ...overrides,
  };
}

test('list_bookmarks returns the backend list result unchanged', async () => {
  const result = await createListHandler(fakeBackend()).handler({});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, listResult);
  assert.equal((result.content[0] as { text: string }).text, JSON.stringify(listResult));
});

test('list_bookmarks maps a typed backend failure to a tool error', async () => {
  const backend = fakeBackend({
    list: async () => { throw new BackendError('store-unavailable', 'mirror unavailable'); },
  });
  const result = await createListHandler(backend).handler({});
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as { text: string }).text, 'mirror unavailable');
});

test('a disabled list handler returns its configured reason', async () => {
  const result = await createListHandler(undefined, { disabledReason: 'No folder.' }).handler({});
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as { text: string }).text, 'No folder.');
});
