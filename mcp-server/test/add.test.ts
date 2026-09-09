import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BackendError, type AddBookmarkInput, type BookmarkBackend } from '../src/backend.js';
import { createAddHandler } from '../src/tools/add.js';

const addResult = {
  id: 'new-id',
  scope: 'workspace' as const,
  collection: { id: 'c1', name: 'Work', order: 0, scope: 'workspace' as const },
};

function fakeBackend(overrides: Partial<BookmarkBackend> = {}): BookmarkBackend {
  return {
    mode: 'mirror',
    list: async () => ({ workspacePath: '/workspace', mirrorPath: '/workspace/.vscode/bookmarks.json', collections: [], items: [] }),
    add: async () => addResult,
    close: async () => {},
    ...overrides,
  };
}

test('add_bookmark exposes optional scope and returns the backend result unchanged', async () => {
  let input: AddBookmarkInput | undefined;
  const backend = fakeBackend({ add: async (received) => { input = received; return addResult; } });
  const add = createAddHandler(backend);
  const result = await add.handler({ uri: 'file:///workspace/a.ts', type: 'file', scope: 'workspace', collectionId: 'c1', collectionName: 'Work', description: 'note' });
  assert.ok('scope' in add.inputSchema);
  assert.deepEqual(input, { uri: 'file:///workspace/a.ts', type: 'file', scope: 'workspace', collectionId: 'c1', collectionName: 'Work', description: 'note' });
  assert.deepEqual(result.structuredContent, addResult);
  assert.equal((result.content[0] as { text: string }).text, JSON.stringify(addResult));
});

test('add_bookmark maps a typed backend failure to a tool error', async () => {
  const backend = fakeBackend({ add: async () => { throw new BackendError('scope-unavailable', 'Global scope is unavailable.'); } });
  const result = await createAddHandler(backend).handler({ uri: 'file:///workspace/a.ts', type: 'file' });
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as { text: string }).text, 'Global scope is unavailable.');
});

test('a disabled add handler returns its configured reason', async () => {
  const result = await createAddHandler(undefined, { disabledReason: 'No folder.' }).handler({ uri: 'file:///workspace/a.ts', type: 'file' });
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as { text: string }).text, 'No folder.');
});
