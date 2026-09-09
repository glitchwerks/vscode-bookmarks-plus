import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BackendError } from '../src/backend.js';
import { MirrorBookmarkBackend } from '../src/mirrorBackend.js';
import type { Config } from '../src/config.js';

const tempDirs: string[] = [];
after(async () => { await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function workspace(data?: unknown): Promise<Config> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-mirror-backend-'));
  tempDirs.push(workspacePath);
  const mirrorPath = path.join(workspacePath, '.vscode', 'bookmarks.json');
  if (data !== undefined) {
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
    await fs.writeFile(mirrorPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  return { workspacePath, mirrorPath, verifyDelayMs: 0 };
}

test('list preserves mirror metadata and adds workspace scope to every record', async () => {
  const config = await workspace({ version: 2, collections: [{ id: 'c1', name: 'Work', order: 0 }], items: [{ id: 'i1', type: 'file', uri: 'file:///workspace/a.ts', collectionId: 'c1', order: 0 }] });
  const result = await new MirrorBookmarkBackend(config).list();
  assert.deepEqual(result, {
    workspacePath: config.workspacePath,
    mirrorPath: config.mirrorPath,
    version: 2,
    collections: [{ id: 'c1', name: 'Work', order: 0, description: undefined, scope: 'workspace' }],
    items: [{ id: 'i1', type: 'file', uri: 'file:///workspace/a.ts', collectionId: 'c1', order: 0, description: undefined, scope: 'workspace' }],
  });
});

test('add returns the exact additive mirror result', async () => {
  const config = await workspace({ version: 2, collections: [{ id: 'c1', name: 'Work', order: 0 }], items: [] });
  const result = await new MirrorBookmarkBackend(config, { uuid: () => 'new-id' }).add({ uri: 'file:///workspace/a.ts', type: 'file', collectionId: 'c1' });
  assert.deepStrictEqual(result, {
    id: 'new-id',
    mirrorPath: config.mirrorPath,
    scope: 'workspace',
    collection: { id: 'c1', name: 'Work', order: 0, scope: 'workspace' },
  });
});

test('global scope is rejected before the mirror is read or written', async () => {
  const config = await workspace();
  const backend = new MirrorBookmarkBackend(config, { readMirror: async () => { throw new Error('read'); } });
  await assert.rejects(() => backend.add({ uri: 'file:///workspace/a.ts', type: 'file', scope: 'global' }), (error: unknown) => error instanceof BackendError && error.code === 'scope-unavailable');
});

test('duplicate additions preserve the duplicate-bookmark error', async () => {
  const config = await workspace({ version: 2, collections: [], items: [{ id: 'i1', type: 'file', uri: 'file:///workspace/a.ts', collectionId: null, order: 0 }] });
  await assert.rejects(() => new MirrorBookmarkBackend(config).add({ uri: 'file:///workspace/a.ts', type: 'file' }), /already exists/);
});

test('a clobbered write is retried once and succeeds when its item survives', async () => {
  const config = await workspace();
  let writes = 0;
  const afterRetry = JSON.stringify({ version: 2, collections: [], items: [{ id: 'new-id', type: 'file', uri: 'file:///workspace/a.ts', collectionId: null, order: 0 }] });
  const backend = new MirrorBookmarkBackend({ ...config, verifyDelayMs: 1 }, {
    uuid: () => 'new-id', sleep: async () => {},
    readMirror: async () => writes >= 2 ? afterRetry : JSON.stringify({ version: 2, collections: [], items: [] }),
    writeMirrorAtomic: async () => { writes += 1; },
  });
  await backend.add({ uri: 'file:///workspace/a.ts', type: 'file' });
  assert.equal(writes, 2);
});
