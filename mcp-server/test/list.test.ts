import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createListHandler } from '../src/tools/list.js';
import { readMirror } from '../src/mirrorFile.js';
import type { Config } from '../src/config.js';

// Same import.meta.url -> directory pattern as contract.test.ts, for the
// same reason: import.meta.dirname needs Node >=20.11 and is not reliably
// typed against this project's pinned @types/node.
const here = path.dirname(fileURLToPath(import.meta.url));

function fixturePath(name: string): string {
  return path.join(here, 'fixtures', name);
}

// Tracks every temp workspace created by makeWorkspace() so they can all be
// removed in a single `after` hook, mirroring mirrorFile.test.ts.
const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Creates a fresh real temp workspace directory (no `.vscode/` yet) and
 * returns the workspace root plus the mirror path list_bookmarks would
 * resolve to. No mocking of the filesystem — the plan requires the
 * "not rewritten" test to prove real mtime/byte stability, which a fake
 * reader cannot demonstrate.
 */
async function makeWorkspace(): Promise<{ workspacePath: string; mirrorPath: string }> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-list-test-'));
  tempDirs.push(workspacePath);
  const mirrorPath = path.join(workspacePath, '.vscode', 'bookmarks.json');
  return { workspacePath, mirrorPath };
}

function makeConfig(workspacePath: string, mirrorPath: string): Config {
  return { workspacePath, mirrorPath, verifyDelayMs: 400 };
}

/** Copies a fixture file byte-for-byte into the workspace's mirror path. */
async function seedMirror(mirrorPath: string, fixtureName: string): Promise<void> {
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
  await fs.copyFile(fixturePath(fixtureName), mirrorPath);
}

// The MCP result envelope shape (content / structuredContent / isError) is
// an SDK detail the implementer chooses freely (see the briefing); these
// tests only need read access to whichever fields are present, so this
// local view is intentionally loose rather than importing the SDK's
// CallToolResult type.
interface ToolContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface ToolResultLike {
  content?: ToolContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Extracts the tool's success data regardless of whether the implementer
 * put it in `structuredContent` or serialized it into the first text
 * content block — the briefing explicitly asks tests not to over-pin the
 * envelope shape.
 */
function extractPayload(result: unknown): Record<string, unknown> {
  const r = result as ToolResultLike;

  if (r.structuredContent && Object.keys(r.structuredContent).length > 0) {
    return r.structuredContent;
  }

  const textBlock = r.content?.find(
    (block) => block.type === 'text' && typeof block.text === 'string',
  );
  if (textBlock?.text) {
    return JSON.parse(textBlock.text) as Record<string, unknown>;
  }

  throw new Error('Tool result carried no inspectable structured or text payload.');
}

/** Extracts a human-readable error message from either content or structuredContent. */
function extractMessage(result: unknown): string {
  const r = result as ToolResultLike;

  const texts = (r.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  if (texts.length > 0) {
    return texts;
  }

  const candidate = r.structuredContent?.message ?? r.structuredContent?.error;
  return typeof candidate === 'string' ? candidate : '';
}

/** True if `value` appears anywhere in `node`, recursing through objects/arrays. */
function containsValue(node: unknown, value: string): boolean {
  if (typeof node === 'string') {
    return node === value;
  }
  if (Array.isArray(node)) {
    return node.some((entry) => containsValue(entry, value));
  }
  if (node !== null && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).some((entry) =>
      containsValue(entry, value),
    );
  }
  return false;
}

test('a missing file returns an empty result, not an error', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  const result = await list.handler({});

  assert.notEqual(result.isError, true);
  const payload = extractPayload(result);
  assert.deepEqual(payload.collections, []);
  assert.deepEqual(payload.items, []);
});

test('a v1 fixture lists items with no descriptions', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  const result = await list.handler({});

  assert.notEqual(result.isError, true);
  const payload = extractPayload(result);
  const items = payload.items as Array<Record<string, unknown>>;
  const collections = payload.collections as Array<Record<string, unknown>>;

  assert.equal(items.length, 2);
  assert.equal(collections.length, 1);
  assert.equal(payload.version, 1);

  for (const item of items) {
    assert.equal(item.description, undefined);
  }
  for (const collection of collections) {
    assert.equal(collection.description, undefined);
  }

  const firstItem = items.find((item) => item.id === 'item-1');
  assert.equal(firstItem?.type, 'file');
  assert.equal(firstItem?.uri, 'file:///workspace/src/index.ts');
  assert.equal(firstItem?.collectionId, 'collection-1');
  assert.equal(firstItem?.order, 0);

  const collection = collections.find((c) => c.id === 'collection-1');
  assert.equal(collection?.name, 'Core');
  assert.equal(collection?.order, 0);
});

test('a v2 fixture lists descriptions on items and collections', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v2-with-descriptions.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  const result = await list.handler({});

  assert.notEqual(result.isError, true);
  const payload = extractPayload(result);
  const items = payload.items as Array<Record<string, unknown>>;
  const collections = payload.collections as Array<Record<string, unknown>>;

  assert.equal(payload.version, 2);

  const describedItem = items.find((item) => item.id === 'item-1');
  assert.equal(describedItem?.description, 'Entry point for the workspace');

  const undescribedItem = items.find((item) => item.id === 'item-2');
  assert.equal(undescribedItem?.description, undefined);

  const collection = collections.find((c) => c.id === 'collection-1');
  assert.equal(collection?.description, 'Core modules and entry points');
});

test('a v1 fixture is NOT rewritten to v2 by a list call', async () => {
  // readOnlyHint: true must be true in fact, not just in the annotation
  // (Global Constraint 9). writeMirrorAtomic changes the file's identity
  // via a rename, so an unchanged mtime plus byte-identical content is
  // strong evidence no write occurred.
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  const beforeBytes = await fs.readFile(mirrorPath);
  const beforeStat = await fs.stat(mirrorPath);

  const result = await list.handler({});
  assert.notEqual(result.isError, true);

  const afterBytes = await fs.readFile(mirrorPath);
  const afterStat = await fs.stat(mirrorPath);

  assert.ok(beforeBytes.equals(afterBytes), 'file bytes must be unchanged after a list call');
  assert.equal(
    afterStat.mtimeMs,
    beforeStat.mtimeMs,
    'mtime must be unchanged after a list call — a write would change it via rename',
  );

  // The reported version reflects the source file (v1) — list_bookmarks
  // must never normalize on read (Global Constraint 9/10).
  const payload = extractPayload(result);
  assert.equal(payload.version, 1);
});

test('a malformed file returns a clear tool error and leaves the file untouched', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'malformed.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  const beforeBytes = await fs.readFile(mirrorPath);

  const result = await list.handler({});

  assert.equal(result.isError, true);
  const message = extractMessage(result);
  assert.ok(message.length > 0, 'a tool error must carry a human-readable message');

  const afterBytes = await fs.readFile(mirrorPath);
  assert.ok(beforeBytes.equals(afterBytes), 'a malformed file must never be overwritten');
});

test('a v3 file returns the upgrade-the-server error', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v3-future.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  const result = await list.handler({});

  assert.equal(result.isError, true);
  const message = extractMessage(result);
  // Matches the same language contract.ts's parseMirror already produces
  // for version > MAX_SUPPORTED_VERSION (contract.test.ts asserts the
  // same three patterns against parseMirror directly).
  assert.match(message, /newer/i);
  assert.match(message, /upgrad/i);
  assert.match(message, /mcp[- ]?server/i);
});

test('the tool registration exposes list_bookmarks as read-only with no required input', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  assert.equal(list.name, 'list_bookmarks');
  assert.equal(typeof list.description, 'string');
  assert.ok(list.description.length > 0);
  assert.deepEqual(list.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  if (list.inputSchema !== undefined) {
    assert.deepEqual(Object.keys(list.inputSchema), []);
  }
});

test('the result surfaces the resolved workspace and mirror path', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const list = createListHandler(config, { readMirror });

  const result = await list.handler({});
  const payload = extractPayload(result);

  assert.ok(
    containsValue(payload, mirrorPath) || containsValue(payload, workspacePath),
    'the success payload should surface the resolved workspace or mirror path somewhere',
  );
});
