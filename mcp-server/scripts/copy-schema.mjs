#!/usr/bin/env node
// Copies the authored JSON schema (a build-time asset `tsc` does not handle,
// since it only compiles `.ts`) into `dist/bookmarks.schema.json`. Run after
// `tsc` from both the `build` and `test` npm scripts.
//
// This script does the schema copy ONLY. It must never write anything under
// `dist/test` -- that would leak test fixtures into the publishable `dist/`
// tree on every plain `npm run build` (issue #66 / T1, constraint 3.1(a)).
// The test-fixture copy lives in the sibling script
// scripts/copy-test-fixtures.mjs, invoked only from the `test` npm script.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = join(here, '..');

const schemaSrc = join(mcpServerRoot, '..', 'schemas', 'bookmarks.schema.json');
const schemaDest = join(mcpServerRoot, 'dist', 'bookmarks.schema.json');

if (!existsSync(schemaSrc)) {
  console.error(`copy-schema: schema source not found at ${schemaSrc}`);
  process.exit(1);
}

mkdirSync(dirname(schemaDest), { recursive: true });
copyFileSync(schemaSrc, schemaDest);
