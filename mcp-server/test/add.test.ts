import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { createAddHandler } from '../src/tools/add.js';
import { readMirror, writeMirrorAtomic } from '../src/mirrorFile.js';
import type { Config } from '../src/config.js';

// Same import.meta.url -> directory pattern established in list.test.ts /
// contract.test.ts, for the same reason: import.meta.dirname needs Node
// >=20.11 and is not reliably typed against this project's pinned
// @types/node.
const here = path.dirname(fileURLToPath(import.meta.url));

function fixturePath(name: string): string {
  return path.join(here, 'fixtures', name);
}

// scripts/copy-schema.mjs copies ../../schemas/bookmarks.schema.json to
// mcp-server/dist/bookmarks.schema.json (mcp-server dist ROOT, not
// dist/test/) as part of `npm test`. This compiled test file lives at
// dist/test/add.test.js, so the copied schema sits one directory above it.
const schemaPath = path.join(here, '..', 'bookmarks.schema.json');

// Tracks every temp workspace created by makeWorkspace() so they can all be
// removed in a single `after` hook, mirroring list.test.ts / mirrorFile.test.ts.
const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<{ workspacePath: string; mirrorPath: string }> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-add-test-'));
  tempDirs.push(workspacePath);
  const mirrorPath = path.join(workspacePath, '.vscode', 'bookmarks.json');
  return { workspacePath, mirrorPath };
}

function makeConfig(
  workspacePath: string,
  mirrorPath: string,
  overrides: Partial<Config> = {},
): Config {
  return { workspacePath, mirrorPath, verifyDelayMs: 400, ...overrides };
}

/** Copies a fixture file byte-for-byte into the workspace's mirror path. */
async function seedMirror(mirrorPath: string, fixtureName: string): Promise<void> {
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
  await fs.copyFile(fixturePath(fixtureName), mirrorPath);
}

/** Writes an arbitrary object as the mirror file's contents. */
async function seedMirrorContent(mirrorPath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
  await fs.writeFile(mirrorPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// The MCP result envelope shape (content / structuredContent / isError) is
// an SDK detail the implementer chooses freely; these tests only need read
// access to whichever fields are present, matching list.test.ts's loose
// local view rather than importing the SDK's CallToolResult type.
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

  return {};
}

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

interface MirrorFileShape {
  version: number;
  items: Array<Record<string, unknown>>;
  collections: Array<Record<string, unknown>>;
}

async function readMirrorJson(mirrorPath: string): Promise<MirrorFileShape> {
  const raw = await fs.readFile(mirrorPath, 'utf8');
  return JSON.parse(raw) as MirrorFileShape;
}

/** A no-op sleep that resolves immediately, so no test burns wall-clock time. */
function fastSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    sleep: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
}

/** Counts writeMirrorAtomic calls while still performing the real write. */
function spyOnRealWrite(): {
  writeMirrorAtomic: (path: string, content: string) => Promise<void>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    writeMirrorAtomic: async (targetPath: string, content: string) => {
      calls.push(targetPath);
      return writeMirrorAtomic(targetPath, content);
    },
    calls,
  };
}

/** Counts readMirror calls while still performing the real read. */
function spyOnRead(): {
  readMirror: typeof readMirror;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    readMirror: async (mirrorPath: string) => {
      calls.push(mirrorPath);
      return readMirror(mirrorPath);
    },
    calls,
  };
}

const BOOKMARK_ITEM_SCHEMA_POINTER = '#/definitions/bookmarkItem';

// ajv v8's default export is typed against `moduleResolution: "node16"` in a
// way that loses its construct signature (a documented ajv/TS interop gap,
// unrelated to this project's code) even though `new Ajv()` is exactly
// correct at runtime — verified directly against this package's compiled
// output before writing this cast. The cast is scoped to the constructor
// call only; `ValidateFunction`'s real ajv type is used for the result.
type AjvConstructor = new (options?: unknown) => {
  compile: (schema: unknown) => ValidateFunction;
};
const AjvClass = Ajv as unknown as AjvConstructor;

async function compileBookmarkItemValidator(): Promise<ValidateFunction> {
  const raw = await fs.readFile(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as {
    definitions: { bookmarkItem: Record<string, unknown> };
  };
  // Compiling the sub-schema directly (rather than the whole document and
  // resolving the $ref) is equivalent here since bookmarkItem has no
  // internal $ref of its own.
  return new AjvClass().compile(schema.definitions.bookmarkItem);
}

// ---------------------------------------------------------------------------
// 1-9: real fs (temp dirs), real readMirror/writeMirrorAtomic, real uuid.
// Only `sleep` is faked everywhere, so tests never burn real wall-clock time
// waiting out `verifyDelayMs` even when verification genuinely exercises the
// real filesystem.
// ---------------------------------------------------------------------------

test('adding to a missing file creates .vscode/ and the file with version 2', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  await assert.rejects(() => fs.stat(path.dirname(mirrorPath)));

  const result = await add.handler({ uri: 'file:///workspace/new-file.ts', type: 'file' });

  assert.notEqual(result.isError, true, extractMessage(result));
  const stat = await fs.stat(path.dirname(mirrorPath));
  assert.ok(stat.isDirectory());

  const written = await readMirrorJson(mirrorPath);
  assert.equal(written.version, 2);
  assert.equal(written.items.length, 1);
  assert.equal(written.items[0]?.uri, 'file:///workspace/new-file.ts');
});

test('adding to a v1 file writes version 2 and preserves existing items', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const before = await readMirrorJson(mirrorPath);

  const result = await add.handler({ uri: 'file:///workspace/added.ts', type: 'file' });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);

  assert.equal(after.version, 2);
  assert.equal(after.items.length, before.items.length + 1);

  for (const originalItem of before.items) {
    const survivor = after.items.find((item) => item.id === originalItem.id);
    assert.deepEqual(survivor, originalItem, 'a pre-existing item must survive byte-identical');
  }
});

test('unknown fields on untouched items survive the write', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v2-unknown-fields.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({ uri: 'file:///workspace/another.ts', type: 'file' });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);

  const coloredItem = after.items.find((item) => item.id === 'item-1');
  assert.equal(coloredItem?.color, 'red', 'an unknown field on an untouched item must survive');
});

test("a document-level unknown field is stripped from the written mirror, unlike per-item unknown fields (CodeRabbit regression: contract.ts:124 -- toCanonicalV2 only sets `version`, it does not strip fields outside the strict v2 schema)", async () => {
  // v2-unknown-fields.json carries a top-level "generator" field alongside
  // v2's known top-level keys. The read path is deliberately tolerant of it
  // (contract.test.ts / the "unknown fields on untouched items survive the
  // write" test just below assert the same tolerance for per-ITEM unknown
  // fields), but the WRITE path is schema-strict (schemaDrift.test.ts
  // enforces additionalProperties: false on the full document) -- so
  // toCanonicalV2 (or whatever calls it before serialize()) must strip a
  // document-level unknown field before writing, not carry it through.
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v2-unknown-fields.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({ uri: 'file:///workspace/strip-check.ts', type: 'file' });

  assert.notEqual(result.isError, true, extractMessage(result));
  const raw = await fs.readFile(mirrorPath, 'utf8');
  const written = JSON.parse(raw) as Record<string, unknown>;

  assert.equal(
    Object.hasOwn(written, 'generator'),
    false,
    'a document-level unknown field must be stripped by the write path to satisfy the strict v2 schema',
  );
});

test('a new item gets order = max(existing sibling orders) + 1 (CodeRabbit regression: add.ts:130 -- previously order = the count of existing siblings, which left a gapped/non-contiguous collection out of sort order)', async () => {
  // Deliberately built so only the max(order)+1 formula survives:
  // max(order)+1 for 'target-collection' = 6 (existing sibling orders 0 and
  // 5, gaps allowed since parseMirror does not enforce contiguity);
  // siblingCount would give 2; counting every item regardless of collection
  // would give 4. Two decoy items belong to a different collection so those
  // other formulas remain distinguishable from max(order)+1 here.
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirrorContent(mirrorPath, {
    version: 2,
    items: [
      {
        id: 'sibling-a',
        type: 'file',
        uri: 'file:///workspace/a.ts',
        collectionId: 'target-collection',
        order: 0,
      },
      {
        id: 'sibling-b',
        type: 'file',
        uri: 'file:///workspace/b.ts',
        collectionId: 'target-collection',
        order: 5,
      },
      {
        id: 'decoy-a',
        type: 'file',
        uri: 'file:///workspace/decoy-a.ts',
        collectionId: null,
        order: 0,
      },
      {
        id: 'decoy-b',
        type: 'file',
        uri: 'file:///workspace/decoy-b.ts',
        collectionId: null,
        order: 1,
      },
    ],
    collections: [{ id: 'target-collection', name: 'Target', order: 0 }],
  });
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({
    uri: 'file:///workspace/new.ts',
    type: 'file',
    collectionId: 'target-collection',
  });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);
  const newItem = after.items.find((item) => item.uri === 'file:///workspace/new.ts');
  assert.equal(
    newItem?.order,
    6,
    'order must normalize to max(existing sibling orders) + 1, so the new item sorts last',
  );
});

test('an exact duplicate (uri, collectionId) is rejected without writing', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const { writeMirrorAtomic: spiedWrite, calls } = spyOnRealWrite();
  const add = createAddHandler(config, {
    readMirror,
    writeMirrorAtomic: spiedWrite,
    sleep,
    uuid: randomUUID,
  });
  const beforeBytes = await fs.readFile(mirrorPath);

  // v1-basic.json's item-1 is { uri: 'file:///workspace/src/index.ts', collectionId: 'collection-1' }.
  const result = await add.handler({
    uri: 'file:///workspace/src/index.ts',
    type: 'file',
    collectionId: 'collection-1',
  });

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, 'a rejected duplicate must never reach writeMirrorAtomic');
  const afterBytes = await fs.readFile(mirrorPath);
  assert.ok(beforeBytes.equals(afterBytes));
});

test('an unknown collectionId is rejected and lists the valid collections', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const { writeMirrorAtomic: spiedWrite, calls } = spyOnRealWrite();
  const add = createAddHandler(config, {
    readMirror,
    writeMirrorAtomic: spiedWrite,
    sleep,
    uuid: randomUUID,
  });

  const result = await add.handler({
    uri: 'file:///workspace/whatever.ts',
    type: 'file',
    collectionId: 'does-not-exist',
  });

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, 'an unknown collectionId must never reach writeMirrorAtomic');
  const message = extractMessage(result);
  // v1-basic.json's only collection is { id: 'collection-1', name: 'Core' }.
  assert.ok(
    message.includes('collection-1') || message.includes('Core'),
    `error should list the valid collection(s), got: ${message}`,
  );
});

test('a collectionName that matches no existing collection is rejected without writing', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const { writeMirrorAtomic: spiedWrite, calls } = spyOnRealWrite();
  const add = createAddHandler(config, {
    readMirror,
    writeMirrorAtomic: spiedWrite,
    sleep,
    uuid: randomUUID,
  });

  const result = await add.handler({
    uri: 'file:///workspace/whatever.ts',
    type: 'file',
    collectionName: 'Does Not Exist',
  });

  // Plan Q2's stated default: no implicit collection creation.
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, 'an unmatched collectionName must never reach writeMirrorAtomic');
});

test('a collectionName that matches an existing collection resolves to its id', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'v1-basic.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({
    uri: 'file:///workspace/named.ts',
    type: 'file',
    collectionName: 'Core',
  });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);
  const newItem = after.items.find((item) => item.uri === 'file:///workspace/named.ts');
  assert.equal(newItem?.collectionId, 'collection-1');
});

test('a whitespace-only description is omitted, not stored as an empty string', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({
    uri: 'file:///workspace/described.ts',
    type: 'file',
    description: '   ',
  });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);
  const newItem = after.items.find((item) => item.uri === 'file:///workspace/described.ts');
  assert.ok(newItem);
  assert.equal(
    Object.hasOwn(newItem as object, 'description'),
    false,
    'a whitespace-only description must be omitted entirely, not stored as ""',
  );
});

test('a description is trimmed of surrounding whitespace', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({
    uri: 'file:///workspace/described-2.ts',
    type: 'file',
    description: '  a real note  ',
  });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);
  const newItem = after.items.find((item) => item.uri === 'file:///workspace/described-2.ts');
  assert.equal(newItem?.description, 'a real note');
});

test('a malformed file is never overwritten', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  await seedMirror(mirrorPath, 'malformed.json');
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const { writeMirrorAtomic: spiedWrite, calls } = spyOnRealWrite();
  const add = createAddHandler(config, {
    readMirror,
    writeMirrorAtomic: spiedWrite,
    sleep,
    uuid: randomUUID,
  });
  const beforeBytes = await fs.readFile(mirrorPath);

  const result = await add.handler({ uri: 'file:///workspace/whatever.ts', type: 'file' });

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, 'a malformed source file must never be written over');
  const afterBytes = await fs.readFile(mirrorPath);
  assert.ok(beforeBytes.equals(afterBytes));
});

test('the newly constructed item satisfies the JSON Schema', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({
    uri: 'file:///workspace/schema-checked.ts',
    type: 'file',
    description: 'checked against the schema',
  });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);
  const newItem = after.items.find((item) => item.uri === 'file:///workspace/schema-checked.ts');
  assert.ok(newItem, 'the new item must be present in the written file');

  const validate = await compileBookmarkItemValidator();
  const valid = validate(newItem);
  assert.ok(
    valid,
    `the newly constructed item must satisfy ${BOOKMARK_ITEM_SCHEMA_POINTER}: ${JSON.stringify(validate.errors)}`,
  );
});

// ---------------------------------------------------------------------------
// 10-12: injected fakes only, per D4's explicit guidance — a real two-process
// race has no place in the blocking CI path. `sleep` always resolves
// immediately regardless of the ms argument.
// ---------------------------------------------------------------------------

test('a write that does not survive verification is retried exactly once', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath, { verifyDelayMs: 400 });
  const { sleep, calls: sleepCalls } = fastSleep();

  const preContent = JSON.stringify({ version: 2, items: [], collections: [] });
  const postContent = JSON.stringify({
    version: 2,
    items: [
      {
        id: 'fixed-uuid',
        type: 'file',
        uri: 'file:///workspace/race.ts',
        collectionId: null,
        order: 0,
      },
    ],
    collections: [],
  });

  let writeCount = 0;
  const writeCalls: string[] = [];
  const fakeReadMirror = async (): Promise<string | undefined> => {
    // Before any write, and immediately after the first write (simulating
    // VS Code clobbering it before the verify re-read), the file still
    // looks like its pre-write state. Only once the SECOND write has
    // landed does a read observe the new item.
    return writeCount >= 2 ? postContent : preContent;
  };
  const fakeWriteMirrorAtomic = async (_path: string, content: string): Promise<void> => {
    writeCount += 1;
    writeCalls.push(content);
  };

  const add = createAddHandler(config, {
    readMirror: fakeReadMirror,
    writeMirrorAtomic: fakeWriteMirrorAtomic,
    sleep,
    uuid: () => 'fixed-uuid',
  });

  const result = await add.handler({ uri: 'file:///workspace/race.ts', type: 'file' });

  assert.notEqual(result.isError, true, extractMessage(result));
  assert.equal(
    writeCalls.length,
    2,
    'a failed first verification must trigger exactly one full retry cycle (2 total writes)',
  );
  assert.ok(sleepCalls.length >= 1, 'verification must actually sleep before re-reading');
});

test('a write that fails verification twice returns the VS Code-overwrote error', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath, { verifyDelayMs: 400 });
  const { sleep } = fastSleep();

  const preContent = JSON.stringify({ version: 2, items: [], collections: [] });

  const writeCalls: string[] = [];
  // Always returns pre-write content: every verify re-read sees the file as
  // if VS Code just overwrote it, on both the initial attempt and the retry.
  const fakeReadMirror = async (): Promise<string | undefined> => preContent;
  const fakeWriteMirrorAtomic = async (_path: string, content: string): Promise<void> => {
    writeCalls.push(content);
  };

  const add = createAddHandler(config, {
    readMirror: fakeReadMirror,
    writeMirrorAtomic: fakeWriteMirrorAtomic,
    sleep,
    uuid: () => 'fixed-uuid',
  });

  const result = await add.handler({ uri: 'file:///workspace/always-clobbered.ts', type: 'file' });

  assert.equal(result.isError, true);
  const message = extractMessage(result);
  assert.match(message, /did not survive/i);
  assert.match(message, /retry/i);
  assert.match(message, /bookmarks view/i);
  assert.equal(
    writeCalls.length,
    2,
    'the retry contract still performs exactly one retry attempt even when it also fails',
  );
});

test('verifyDelayMs = 0 skips verification entirely', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath, { verifyDelayMs: 0 });
  const { sleep, calls: sleepCalls } = fastSleep();

  const preContent = JSON.stringify({ version: 2, items: [], collections: [] });
  const writeCalls: string[] = [];
  const fakeReadMirror = async (): Promise<string | undefined> => preContent;
  const fakeWriteMirrorAtomic = async (_path: string, content: string): Promise<void> => {
    writeCalls.push(content);
  };

  const add = createAddHandler(config, {
    readMirror: fakeReadMirror,
    writeMirrorAtomic: fakeWriteMirrorAtomic,
    sleep,
    uuid: () => 'fixed-uuid',
  });

  const result = await add.handler({ uri: 'file:///workspace/no-verify.ts', type: 'file' });

  assert.notEqual(result.isError, true, extractMessage(result));
  assert.equal(sleepCalls.length, 0, 'verifyDelayMs = 0 must never call sleep');
  assert.equal(
    writeCalls.length,
    1,
    'verifyDelayMs = 0 must succeed after a single write, with no retry cycle',
  );
});

test('a retry whose duplicate-check fires only because attempt 1\'s own write is now visible is reported as success, not a false "already exists" error (CodeRabbit regression: add.ts:198)', async () => {
  // Attempt 1 writes the item successfully, but its post-write verification
  // re-read races a concurrent external rewrite of the mirror and observes
  // survived === false, triggering a retry. Attempt 2 then re-reads the
  // mirror to build its own write and, because attempt 1's item is
  // genuinely already on disk by then, the pre-write duplicate check
  // (add.ts:115-122) fires on the very item attempt 1 already wrote. The
  // current code reports that as an "already exists" error even though the
  // original write succeeded; the confirmed fix treats this specific case
  // (retry's duplicate-check firing on attempt 1's own item) as verified
  // success.
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath, { verifyDelayMs: 400 });
  const { sleep } = fastSleep();

  const preContent = JSON.stringify({ version: 2, items: [], collections: [] });
  const postContent = JSON.stringify({
    version: 2,
    items: [
      {
        id: 'fixed-uuid',
        type: 'file',
        uri: 'file:///workspace/raced-duplicate.ts',
        collectionId: null,
        order: 0,
      },
    ],
    collections: [],
  });

  let readCount = 0;
  const fakeReadMirror = async (): Promise<string | undefined> => {
    readCount += 1;
    // 1st read: the handler's initial read, before attempt 1's write.
    // 2nd read: attempt 1's post-write verification read -- races a
    //   concurrent external rewrite and observes the pre-write state, i.e.
    //   survived === false, which is what triggers the retry.
    // 3rd+ read: attempt 2's own fresh read, by which point attempt 1's
    //   write is genuinely visible on disk.
    return readCount <= 2 ? preContent : postContent;
  };
  const fakeWriteMirrorAtomic = async (_path: string, _content: string): Promise<void> => {
    // No-op: the fake readMirror sequence above is what drives the race,
    // not the write itself, so nothing needs to be recorded here.
  };

  const add = createAddHandler(config, {
    readMirror: fakeReadMirror,
    writeMirrorAtomic: fakeWriteMirrorAtomic,
    sleep,
    uuid: () => 'fixed-uuid',
  });

  const result = await add.handler({ uri: 'file:///workspace/raced-duplicate.ts', type: 'file' });

  assert.notEqual(
    result.isError,
    true,
    `expected the race to be recognized as a verified success, got error: ${extractMessage(result)}`,
  );
});

// ---------------------------------------------------------------------------
// Registration metadata + success payload shape
// ---------------------------------------------------------------------------

test('the tool registration exposes add_bookmark as a non-destructive, non-idempotent write tool', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  assert.equal(add.name, 'add_bookmark');
  assert.equal(typeof add.description, 'string');
  assert.ok(add.description.length > 0);
  assert.deepEqual(add.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(
    Object.keys(add.inputSchema).sort(),
    ['collectionId', 'collectionName', 'description', 'type', 'uri'],
  );
});

test('the success result surfaces the new id and the mirror path', async () => {
  const { workspacePath, mirrorPath } = await makeWorkspace();
  const config = makeConfig(workspacePath, mirrorPath);
  const { sleep } = fastSleep();
  const add = createAddHandler(config, { readMirror, writeMirrorAtomic, sleep, uuid: randomUUID });

  const result = await add.handler({ uri: 'file:///workspace/reported.ts', type: 'file' });

  assert.notEqual(result.isError, true, extractMessage(result));
  const after = await readMirrorJson(mirrorPath);
  const newItem = after.items.find((item) => item.uri === 'file:///workspace/reported.ts');
  assert.ok(newItem && typeof newItem.id === 'string');

  const payload = extractPayload(result);
  assert.ok(
    containsValue(payload, newItem.id as string),
    'the success payload should surface the newly created id',
  );
  assert.ok(
    containsValue(payload, mirrorPath),
    'the success payload should surface the resolved mirror path',
  );
});

// ---------------------------------------------------------------------------
// Disabled workspace (config === undefined, spec § 4B.8, strategy (a)). This
// is the regression guard for the rejected placeholder-Config alternative:
// a dropped guard there would let writeMirrorAtomic('') resolve dirname('')
// to '.' and write bookmarks.json into the server's own cwd (§ 4B.8). Here,
// no file may be read OR written at all.
// ---------------------------------------------------------------------------

test('a disabled config (undefined) returns a tool error matching the provided disabledReason, without ever reading or writing the mirror', async () => {
  const { readMirror: spiedRead, calls: readCalls } = spyOnRead();
  const { writeMirrorAtomic: spiedWrite, calls: writeCalls } = spyOnRealWrite();
  const { sleep } = fastSleep();
  const add = createAddHandler(undefined, {
    readMirror: spiedRead,
    writeMirrorAtomic: spiedWrite,
    sleep,
    uuid: randomUUID,
    disabledReason: 'Bookmarks are unavailable: no workspace folder is open.',
  });

  const result = await add.handler({
    uri: 'file:///workspace/should-not-be-written.ts',
    type: 'file',
  });

  assert.equal(result.isError, true);
  const message = extractMessage(result);
  // Containment rather than equality: the handler is free to wrap
  // disabledReason in its own prefix/formatting, it just must surface the
  // reason verbatim somewhere in the message.
  assert.ok(
    message.includes('Bookmarks are unavailable: no workspace folder is open.'),
    'the tool error must surface the provided disabledReason',
  );
  assert.equal(readCalls.length, 0, 'a disabled config must never reach readMirror');
  assert.equal(
    writeCalls.length,
    0,
    'a disabled config must never reach writeMirrorAtomic -- a dropped guard here would write into the server process\'s own cwd',
  );
});

test('a disabled config (undefined) with no disabledReason still returns a non-empty tool error, without ever reading or writing the mirror', async () => {
  const { readMirror: spiedRead, calls: readCalls } = spyOnRead();
  const { writeMirrorAtomic: spiedWrite, calls: writeCalls } = spyOnRealWrite();
  const { sleep } = fastSleep();
  const add = createAddHandler(undefined, {
    readMirror: spiedRead,
    writeMirrorAtomic: spiedWrite,
    sleep,
    uuid: randomUUID,
  });

  const result = await add.handler({
    uri: 'file:///workspace/should-not-be-written.ts',
    type: 'file',
  });

  assert.equal(result.isError, true);
  const message = extractMessage(result);
  assert.ok(message.length > 0, 'a disabled config with no disabledReason must still surface a legible error message');
  assert.equal(readCalls.length, 0, 'a disabled config must never reach readMirror');
  assert.equal(writeCalls.length, 0, 'a disabled config must never reach writeMirrorAtomic');
});
