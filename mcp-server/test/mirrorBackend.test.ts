import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';

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

function mirrorData(items: unknown[] = [], collections: unknown[] = []): string {
  return JSON.stringify({ version: 2, items, collections });
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

test('a malformed first verification retries against fresh valid data', async () => {
  const config = await workspace();
  let writes = 0;
  const reads = [
    JSON.stringify({ version: 2, collections: [], items: [] }),
    '{ malformed verification',
    JSON.stringify({ version: 2, collections: [], items: [] }),
    JSON.stringify({ version: 2, collections: [], items: [{ id: 'retry-id', type: 'file', uri: 'file:///workspace/a.ts', collectionId: null, order: 0 }] }),
  ];
  const backend = new MirrorBookmarkBackend({ ...config, verifyDelayMs: 1 }, {
    uuid: () => writes === 0 ? 'first-id' : 'retry-id',
    sleep: async () => {},
    readMirror: async () => reads.shift(),
    writeMirrorAtomic: async () => { writes += 1; },
  });

  const result = await backend.add({ uri: 'file:///workspace/a.ts', type: 'file' });

  assert.equal(result.id, 'retry-id');
  assert.equal(writes, 2);
});

test('a malformed retry source still recovers the first write by id', async () => {
  const config = await workspace();
  let writes = 0;
  const reads = [
    JSON.stringify({ version: 2, collections: [], items: [] }),
    '{ malformed verification',
    '{ malformed retry source',
    JSON.stringify({ version: 2, collections: [], items: [{ id: 'first-id', type: 'file', uri: 'file:///workspace/a.ts', collectionId: null, order: 0 }] }),
  ];
  const backend = new MirrorBookmarkBackend({ ...config, verifyDelayMs: 1 }, {
    uuid: () => 'first-id',
    sleep: async () => {},
    readMirror: async () => reads.shift(),
    writeMirrorAtomic: async () => { writes += 1; },
  });

  const result = await backend.add({ uri: 'file:///workspace/a.ts', type: 'file' });

  assert.equal(result.id, 'first-id');
  assert.equal(writes, 1);
});

test('a missing mirror lists empty workspace-scoped collections and items', async () => {
  const config = await workspace();
  const result = await new MirrorBookmarkBackend(config).list();
  assert.deepEqual(result.collections, []);
  assert.deepEqual(result.items, []);
  assert.equal(result.version, undefined);
});

test('list preserves item and collection descriptions', async () => {
  const config = await workspace({ version: 2, collections: [{ id: 'c1', name: 'Work', order: 0, description: 'Team work' }], items: [{ id: 'i1', type: 'file', uri: 'file:///workspace/a.ts', collectionId: 'c1', order: 0, description: 'Entry point' }] });
  const result = await new MirrorBookmarkBackend(config).list();
  assert.equal(result.collections[0]?.description, 'Team work');
  assert.equal(result.items[0]?.description, 'Entry point');
});

test('list never rewrites a v1 mirror', async () => {
  const config = await workspace({ version: 1, collections: [], items: [] });
  const before = await fs.readFile(config.mirrorPath);
  const beforeStat = await fs.stat(config.mirrorPath);
  const result = await new MirrorBookmarkBackend(config).list();
  const after = await fs.readFile(config.mirrorPath);
  const afterStat = await fs.stat(config.mirrorPath);
  assert.equal(result.version, 1);
  assert.ok(before.equals(after));
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('list surfaces a future-version failure', async () => {
  const config = await workspace({ version: 3, collections: [], items: [] });
  await assert.rejects(() => new MirrorBookmarkBackend(config).list(), /newer version.*Upgrade/i);
});

test('list maps mirror read failures to a safe backend error', async () => {
  const config = await workspace();
  const backend = new MirrorBookmarkBackend(config, { readMirror: async () => { throw new Error('EACCES'); } });
  await assert.rejects(() => backend.list(), (error: unknown) => error instanceof BackendError && error.code === 'store-unavailable' && error.message.includes('EACCES'));
});

test('a malformed list source is refused without changing its bytes', async () => {
  const config = await workspace();
  await fs.mkdir(path.dirname(config.mirrorPath), { recursive: true });
  await fs.writeFile(config.mirrorPath, '{ malformed', 'utf8');
  const before = await fs.readFile(config.mirrorPath);
  await assert.rejects(() => new MirrorBookmarkBackend(config).list(), /Invalid JSON/);
  assert.ok(before.equals(await fs.readFile(config.mirrorPath)));
});

test('adding to a v1 mirror migrates to v2 and preserves its existing items', async () => {
  const config = await workspace({ version: 1, collections: [], items: [{ id: 'old', type: 'file', uri: 'file:///workspace/old.ts', collectionId: null, order: 0 }] });
  await new MirrorBookmarkBackend(config, { uuid: () => 'new' }).add({ uri: 'file:///workspace/new.ts', type: 'file' });
  const persisted = JSON.parse(await fs.readFile(config.mirrorPath, 'utf8')) as { version: number; items: Array<{ id: string }> };
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.items.map((item) => item.id), ['old', 'new']);
});

test('add persists canonical output instead of source unknown fields', async () => {
  const config = await workspace({ version: 2, extra: 'remove', collections: [], items: [{ id: 'old', type: 'file', uri: 'file:///workspace/old.ts', collectionId: null, order: 0, color: 'blue' }] });
  await new MirrorBookmarkBackend(config, { uuid: () => 'new' }).add({ uri: 'file:///workspace/new.ts', type: 'file' });
  const persisted = JSON.parse(await fs.readFile(config.mirrorPath, 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(persisted, 'extra'), false);
  assert.equal(Object.hasOwn((persisted.items as Array<Record<string, unknown>>)[0] ?? {}, 'color'), false);
});

test('add orders a new item after the highest gapped sibling order', async () => {
  const config = await workspace({ version: 2, collections: [], items: [{ id: 'zero', type: 'file', uri: 'file:///workspace/zero.ts', collectionId: null, order: 0 }, { id: 'five', type: 'file', uri: 'file:///workspace/five.ts', collectionId: null, order: 5 }, { id: 'other', type: 'file', uri: 'file:///workspace/other.ts', collectionId: 'c1', order: 99 }] });
  await new MirrorBookmarkBackend(config, { uuid: () => 'new' }).add({ uri: 'file:///workspace/new.ts', type: 'file' });
  const persisted = JSON.parse(await fs.readFile(config.mirrorPath, 'utf8')) as { items: Array<{ id: string; order: number }> };
  assert.equal(persisted.items.find((item) => item.id === 'new')?.order, 6);
});

test('collectionName resolves to the matching persisted collection id', async () => {
  const config = await workspace({ version: 2, collections: [{ id: 'c1', name: 'Work', order: 0 }], items: [] });
  await new MirrorBookmarkBackend(config, { uuid: () => 'new' }).add({ uri: 'file:///workspace/new.ts', type: 'file', collectionName: 'Work' });
  const persisted = JSON.parse(await fs.readFile(config.mirrorPath, 'utf8')) as { items: Array<{ collectionId: string | null }> };
  assert.equal(persisted.items[0]?.collectionId, 'c1');
});

test('an unknown collection refuses the add before any write', async () => {
  const config = await workspace();
  let writes = 0;
  const backend = new MirrorBookmarkBackend(config, { writeMirrorAtomic: async () => { writes += 1; } });
  await assert.rejects(() => backend.add({ uri: 'file:///workspace/a.ts', type: 'file', collectionId: 'missing' }), /Unknown collectionId/);
  assert.equal(writes, 0);
});

test('add omits whitespace-only descriptions from persisted items', async () => {
  const config = await workspace();
  await new MirrorBookmarkBackend(config, { uuid: () => 'new' }).add({ uri: 'file:///workspace/a.ts', type: 'file', description: '   ' });
  const persisted = JSON.parse(await fs.readFile(config.mirrorPath, 'utf8')) as { items: Array<Record<string, unknown>> };
  assert.equal(Object.hasOwn(persisted.items[0] ?? {}, 'description'), false);
});

test('add trims persisted descriptions', async () => {
  const config = await workspace();
  await new MirrorBookmarkBackend(config, { uuid: () => 'new' }).add({ uri: 'file:///workspace/a.ts', type: 'file', description: '  note  ' });
  const persisted = JSON.parse(await fs.readFile(config.mirrorPath, 'utf8')) as { items: Array<{ description?: string }> };
  assert.equal(persisted.items[0]?.description, 'note');
});

test('a malformed initial add source is never overwritten', async () => {
  const config = await workspace();
  await fs.mkdir(path.dirname(config.mirrorPath), { recursive: true });
  await fs.writeFile(config.mirrorPath, '{ malformed', 'utf8');
  const before = await fs.readFile(config.mirrorPath);
  await assert.rejects(() => new MirrorBookmarkBackend(config).add({ uri: 'file:///workspace/a.ts', type: 'file' }), /Invalid JSON/);
  assert.ok(before.equals(await fs.readFile(config.mirrorPath)));
});

test('the persisted added item validates against the published schema', async () => {
  const config = await workspace();
  await new MirrorBookmarkBackend(config, { uuid: () => 'new' }).add({ uri: 'file:///workspace/a.ts', type: 'file', description: 'note' });
  const schema = JSON.parse(await fs.readFile(path.join(process.cwd(), 'dist', 'bookmarks.schema.json'), 'utf8')) as { definitions: { bookmarkItem: object } };
  const AjvClass = Ajv as unknown as new () => { compile: (value: object) => (value: unknown) => boolean };
  const validate = new AjvClass().compile(schema.definitions.bookmarkItem);
  const persisted = JSON.parse(await fs.readFile(config.mirrorPath, 'utf8')) as { items: unknown[] };
  assert.equal(validate(persisted.items[0]), true);
});

test('a double clobber returns the historical did-not-survive failure', async () => {
  const config = await workspace();
  let writes = 0;
  const backend = new MirrorBookmarkBackend({ ...config, verifyDelayMs: 1 }, { uuid: () => 'new', sleep: async () => {}, readMirror: async () => mirrorData(), writeMirrorAtomic: async () => { writes += 1; } });
  await assert.rejects(() => backend.add({ uri: 'file:///workspace/a.ts', type: 'file' }), /did not survive/);
  assert.equal(writes, 2);
});

test('zero verification delay succeeds without a verification read', async () => {
  const config = await workspace();
  let reads = 0;
  const backend = new MirrorBookmarkBackend(config, { uuid: () => 'new', readMirror: async () => { reads += 1; return mirrorData(); }, writeMirrorAtomic: async () => {} });
  await backend.add({ uri: 'file:///workspace/a.ts', type: 'file' });
  assert.equal(reads, 1);
});

test('retry recovery accepts a first write that became visible before retry', async () => {
  const config = await workspace();
  let writes = 0;
  const first = { id: 'first', type: 'file', uri: 'file:///workspace/a.ts', collectionId: null, order: 0 };
  const reads = [mirrorData(), mirrorData(), mirrorData([first]), mirrorData([first])];
  const backend = new MirrorBookmarkBackend({ ...config, verifyDelayMs: 1 }, { uuid: () => 'first', sleep: async () => {}, readMirror: async () => reads.shift(), writeMirrorAtomic: async () => { writes += 1; } });
  const result = await backend.add({ uri: 'file:///workspace/a.ts', type: 'file' });
  assert.equal(result.id, 'first');
  assert.equal(writes, 1);
});

test('retry recovery identifies the first write by id after its collection changes', async () => {
  const config = await workspace();
  let writes = 0;
  const original = { id: 'first', type: 'file', uri: 'file:///workspace/a.ts', collectionId: null, order: 0 };
  const moved = { id: 'first', type: 'file', uri: 'file:///workspace/a.ts', collectionId: 'moved', order: 0 };
  const reads = [mirrorData(), mirrorData(), mirrorData([original]), mirrorData([moved])];
  const backend = new MirrorBookmarkBackend({ ...config, verifyDelayMs: 1 }, { uuid: () => 'first', sleep: async () => {}, readMirror: async () => reads.shift(), writeMirrorAtomic: async () => { writes += 1; } });
  const result = await backend.add({ uri: 'file:///workspace/a.ts', type: 'file' });
  assert.equal(result.id, 'first');
  assert.equal(writes, 1);
});
