import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { parseMirror, serialize, toCanonicalV2 } from '../src/contract.js';

// Mirrors the import.meta.url -> directory pattern already established in
// scripts/copy-schema.mjs, rather than import.meta.dirname (Node >=20.11
// only, and not a reliably typed ImportMeta property against this
// project's pinned @types/node).
const here = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): string {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
}

// The repo-root authored schema, reached by walking up from
// dist/test/contract.test.js: dist/test -> dist -> mcp-server -> repo root
// -> schemas/bookmarks.schema.json. Same layout schemaDrift.test.ts /
// add.test.ts already rely on.
const authoredSchemaPath = join(here, '..', '..', '..', 'schemas', 'bookmarks.schema.json');

// ajv v8's default export is typed against `moduleResolution: "node16"` in a
// way that loses its construct signature (a documented ajv/TS interop gap,
// unrelated to this project's code) even though `new Ajv()` is exactly
// correct at runtime -- same cast pattern schemaDrift.test.ts / add.test.ts
// already use. The cast is scoped to the constructor call only;
// `ValidateFunction`'s real ajv type is used for the result.
type AjvConstructor = new (options?: unknown) => {
  compile: (schema: unknown) => ValidateFunction;
};
const AjvClass = Ajv as unknown as AjvConstructor;

function compileFullSchemaValidator(): ValidateFunction {
  const schema = JSON.parse(readFileSync(authoredSchemaPath, 'utf8')) as Record<string, unknown>;
  return new AjvClass().compile(schema);
}

test('undefined input yields an empty result, not an error', () => {
  const result = parseMirror(undefined);

  assert.deepEqual(result, { kind: 'empty' });
});

test('a v1 file parses and reports version 1', () => {
  const raw = readFixture('v1-basic.json');

  const result = parseMirror(raw);

  // node:assert/strict's equal() is strictEqual(), which is typed with an
  // "asserts" signature — this line both checks and narrows `result` to
  // its 'ok' variant for the property accesses below.
  assert.equal(result.kind, 'ok');
  assert.equal(result.data.version, 1);
  assert.equal(result.data.items.length, 2);
  assert.equal(result.data.collections.length, 1);
});

test('a v2 file with unknown fields parses and preserves them', () => {
  // The AC's forward-compat requirement, and the check that guards against
  // ajv-with-additionalProperties-false creeping into the read path.
  const raw = readFixture('v2-unknown-fields.json');

  const result = parseMirror(raw);

  assert.equal(result.kind, 'ok');
  // These fields are not part of BookmarkData's known shape, so read them
  // back through an untyped view rather than widening the exported type.
  const topLevel = result.data as unknown as Record<string, unknown>;
  assert.equal(topLevel.generator, 'some-other-tool');

  const items = result.data.items as unknown as Array<Record<string, unknown>>;
  const coloredItem = items.find((item) => item.id === 'item-1');
  assert.equal(coloredItem?.color, 'red');
});

test('a v3 file is rejected with a message telling the user to upgrade the MCP server', () => {
  const raw = readFixture('v3-future.json');

  const result = parseMirror(raw);

  assert.equal(result.kind, 'error');
  assert.match(result.message, /newer/i);
  assert.match(result.message, /upgrad/i);
  assert.match(result.message, /mcp[- ]?server/i);
});

test('malformed JSON is rejected without throwing', () => {
  const raw = readFixture('malformed.json');

  // The tolerance is in the returned kind, not just in exception safety —
  // assert both, as two independent checks rather than leaning on a value
  // captured through a closure for narrowing.
  assert.doesNotThrow(() => parseMirror(raw));

  const result = parseMirror(raw);
  assert.equal(result.kind, 'error');
});

test('a bare array is rejected', () => {
  const raw = readFixture('not-an-object.json');

  const result = parseMirror(raw);

  assert.equal(result.kind, 'error');
});

test('an item with a numeric uri rejects the whole payload', () => {
  // Matches the extension's all-or-nothing isStrictBookmarkData gate — a
  // single malformed entry rejects the whole payload rather than silently
  // dropping just that entry.
  const raw = JSON.stringify({
    version: 2,
    items: [{ id: 'item-1', type: 'file', uri: 12345, collectionId: null, order: 0 }],
    collections: [],
  });

  const result = parseMirror(raw);

  assert.equal(result.kind, 'error');
});

test("invariant violations parse successfully — repair is the extension's job", () => {
  // v2-invariant-violations.json is strictly well-typed but has a dangling
  // collectionId, a duplicate (uri, collectionId) pair, and non-contiguous
  // order values within a collection. None of that is parseMirror's
  // concern — normalizeBookmarkData on the extension side repairs it.
  const raw = readFixture('v2-invariant-violations.json');

  const result = parseMirror(raw);

  assert.equal(result.kind, 'ok');
  assert.equal(result.data.items.length, 3);
  assert.equal(result.data.collections.length, 1);
});

test('serialize output ends with exactly one newline', () => {
  // Built from a real parsed fixture (rather than an inline object
  // literal) so this test cannot silently drift from whatever shape
  // BookmarkData ends up having.
  const raw = readFixture('empty-collections.json');
  const result = parseMirror(raw);

  assert.equal(result.kind, 'ok');
  const output = serialize(result.data);

  assert.ok(output.endsWith('\n'));
  assert.ok(!output.endsWith('\n\n'));
});

test('serialize round-trips a parsed fixture byte-for-byte', () => {
  const raw = readFixture('v2-with-descriptions.json');

  const result = parseMirror(raw);

  assert.equal(result.kind, 'ok');
  const output = serialize(result.data);

  // Byte comparison, not structural equality — a manual string builder
  // that happened to be structurally equivalent would still fail this.
  assert.equal(output, JSON.stringify(result.data, null, 2) + '\n');
});

// ---------------------------------------------------------------------------
// toCanonicalV2 (CodeRabbit regression: contract.ts:121-133 -- only
// document-level unknown fields (outside version/items/collections) are
// stripped; items and collections are passed through by reference,
// unmodified. The schema's additionalProperties: false applies at the item
// and collection level too (schemas/bookmarks.schema.json), so an item or
// collection carrying an unrecognized field still fails strict schema
// validation after toCanonicalV2 -- even though toCanonicalV2 exists
// specifically to produce a schema-valid write payload.
// ---------------------------------------------------------------------------

test('toCanonicalV2 strips unknown fields from items, not just from the top-level document', () => {
  const raw = readFixture('v2-unknown-fields.json');
  const result = parseMirror(raw);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') {
    return;
  }

  const canonical = toCanonicalV2(result.data);

  const items = canonical.items as unknown as Array<Record<string, unknown>>;
  const coloredItem = items.find((item) => item.id === 'item-1');
  assert.ok(coloredItem, 'item-1 must still be present after toCanonicalV2');
  assert.ok(
    !('color' in (coloredItem as Record<string, unknown>)),
    'toCanonicalV2 must strip unknown item-level fields (schema: bookmarkItem additionalProperties: false)',
  );
});

test('toCanonicalV2 strips unknown fields from collections, not just from items and the top-level document', () => {
  const raw = JSON.stringify({
    version: 2,
    items: [],
    collections: [
      { id: 'collection-1', name: 'Core', order: 0, color: 'blue', icon: 'star' },
    ],
  });
  const result = parseMirror(raw);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') {
    return;
  }

  const canonical = toCanonicalV2(result.data);

  const collections = canonical.collections as unknown as Array<Record<string, unknown>>;
  const collection = collections.find((entry) => entry.id === 'collection-1');
  assert.ok(collection, 'collection-1 must still be present after toCanonicalV2');
  assert.ok(
    !('color' in (collection as Record<string, unknown>)),
    'toCanonicalV2 must strip unknown collection-level fields (schema: bookmarkCollection additionalProperties: false)',
  );
  assert.ok(!('icon' in (collection as Record<string, unknown>)));
  // Known fields must survive the strip -- this is field removal, not a
  // document rebuilt from scratch.
  assert.equal(collection?.name, 'Core');
  assert.equal(collection?.order, 0);
});

test('toCanonicalV2 output validates against the full schema even when the input carried unknown item- and collection-level fields', () => {
  // The authoritative check: additionalProperties: false applies at every
  // level of the schema, so this is the real bar toCanonicalV2's output
  // must clear -- not just the two field-by-field checks above.
  const raw = JSON.stringify({
    version: 2,
    generator: 'some-other-tool',
    items: [
      {
        id: 'item-1',
        type: 'file',
        uri: 'file:///workspace/src/index.ts',
        collectionId: 'collection-1',
        order: 0,
        color: 'red',
      },
    ],
    collections: [
      { id: 'collection-1', name: 'Core', order: 0, color: 'blue' },
    ],
  });
  const result = parseMirror(raw);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') {
    return;
  }

  const canonical = toCanonicalV2(result.data);
  const validate = compileFullSchemaValidator();
  const valid = validate(canonical);

  assert.ok(
    valid,
    `toCanonicalV2 output must validate against the full schema: ${JSON.stringify(validate.errors)}`,
  );
});
