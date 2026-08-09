import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { MAX_SUPPORTED_VERSION } from '../src/contract.js';

// Mirrors the import.meta.url -> directory pattern already established in
// contract.test.ts / add.test.ts, rather than import.meta.dirname (Node
// >=20.11 only, and not a reliably typed ImportMeta property against this
// project's pinned @types/node).
const here = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): string {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
}

// scripts/copy-schema.mjs copies ../../schemas/bookmarks.schema.json to
// mcp-server/dist/bookmarks.schema.json (mcp-server dist ROOT, not
// dist/test/) as part of `npm test`. This compiled test file lives at
// dist/test/schemaDrift.test.js, so the copied schema sits one directory
// above it — same layout add.test.ts already relies on.
const distSchemaPath = join(here, '..', 'bookmarks.schema.json');

// The repo-root authored schema, reached by walking up from
// dist/test/schemaDrift.test.js: dist/test -> dist -> mcp-server -> repo
// root -> schemas/bookmarks.schema.json.
const authoredSchemaPath = join(here, '..', '..', '..', 'schemas', 'bookmarks.schema.json');

// ajv v8's default export is typed against `moduleResolution: "node16"` in a
// way that loses its construct signature (a documented ajv/TS interop gap,
// unrelated to this project's code) even though `new Ajv()` is exactly
// correct at runtime — same cast pattern add.test.ts already uses. The cast
// is scoped to the constructor call only; `ValidateFunction`'s real ajv type
// is used for the result.
type AjvConstructor = new (options?: unknown) => {
  compile: (schema: unknown) => ValidateFunction;
};
const AjvClass = Ajv as unknown as AjvConstructor;

function compileFullSchemaValidator(schemaRaw: string): ValidateFunction {
  const schema = JSON.parse(schemaRaw) as Record<string, unknown>;
  return new AjvClass().compile(schema);
}

test('dist/bookmarks.schema.json is byte-identical to the repo-root authored schema', () => {
  // `npm test` runs `tsc ... && node scripts/copy-schema.mjs && node --test
  // dist/test`, so by the time this test executes the copy step has already
  // run in this same invocation. This assertion pins that the copy step
  // places the schema at dist/bookmarks.schema.json byte-for-byte unmodified
  // (catches a future copy-schema.mjs that starts transforming/filtering, or
  // stops copying the schema at all). It cannot, on its own, detect someone
  // running the compiled dist/test output directly without re-running `npm
  // test` first — that staleness case has no automated guard; `npm test`
  // (and CI, which always runs it fresh) is what keeps dist/ current.
  const distBytes = readFileSync(distSchemaPath);
  const authoredBytes = readFileSync(authoredSchemaPath);

  assert.ok(
    distBytes.equals(authoredBytes),
    'mcp-server/dist/bookmarks.schema.json must be byte-identical to schemas/bookmarks.schema.json ' +
      '(the build-time copy step in scripts/copy-schema.mjs must run, and dist/ must be rebuilt ' +
      'whenever the authored schema changes)',
  );
});

test("the schema's properties.version.maximum matches contract.ts's MAX_SUPPORTED_VERSION", () => {
  // The important one: if a future PR bumps the extension's schema version
  // ceiling without also updating the MCP server's contract.ts (or vice
  // versa), this test fails and names the reason — the exact drift that
  // already happened once between #51's plan draft and its shipped
  // src/types.ts (see plan's "Drift is not hypothetical" section).
  const authoredRaw = readFileSync(authoredSchemaPath, 'utf8');
  const schema = JSON.parse(authoredRaw) as {
    properties: { version: { maximum: number } };
  };

  assert.equal(schema.properties.version.maximum, MAX_SUPPORTED_VERSION);
});

test('every fixture the tests treat as valid also validates against the full schema', () => {
  const authoredRaw = readFileSync(authoredSchemaPath, 'utf8');
  const validate = compileFullSchemaValidator(authoredRaw);

  // These fixtures parse successfully via parseMirror in contract.test.ts
  // AND are structurally valid whole-document fixtures — i.e. they satisfy
  // the schema's additionalProperties: false as well as the tolerant read
  // path. v3-future.json, malformed.json, and not-an-object.json are
  // excluded: they are invalid at the parseMirror level for reasons other
  // than what this schema-validation check tests (unsupported version,
  // unparseable JSON, wrong top-level type).
  const validFixtures = [
    'v1-basic.json',
    'v2-with-descriptions.json',
    'v2-invariant-violations.json',
    'empty-collections.json',
  ];

  for (const fixtureName of validFixtures) {
    const data = JSON.parse(readFixture(fixtureName)) as unknown;
    const valid = validate(data);
    assert.ok(
      valid,
      `${fixtureName} must validate against the full schema: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test('v2-unknown-fields.json is EXPECTED to fail full-schema validation', () => {
  // Do not "fix" this by relaxing the schema's additionalProperties: false.
  // v2-unknown-fields.json is the forward-compat fixture: the published
  // contract promises the read path will accept and preserve fields the
  // schema doesn't know about yet (README.md § "The .vscode/bookmarks.json
  // mirror"), which is exactly why parseMirror is deliberately more
  // tolerant than the JSON Schema (see the plan's "Read validation must be
  // tolerant, write validation must be strict" section). Schema validation
  // is the strict write-side check, not the read-side contract, so this
  // fixture correctly fails it — that failure is the whole point of the
  // tolerant-read design, not a bug to chase.
  const authoredRaw = readFileSync(authoredSchemaPath, 'utf8');
  const validate = compileFullSchemaValidator(authoredRaw);

  const data = JSON.parse(readFixture('v2-unknown-fields.json')) as unknown;
  const valid = validate(data);

  assert.equal(
    valid,
    false,
    'v2-unknown-fields.json must fail full-schema validation because of additionalProperties: false — ' +
      'if this starts passing, the schema was relaxed and the forward-compat guarantee is no longer tested here',
  );
  assert.ok(validate.errors && validate.errors.length > 0);
});
