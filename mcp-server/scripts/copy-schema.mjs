#!/usr/bin/env node
// Copies build-time assets that `tsc` does not handle (it only compiles
// `.ts`) into `dist/`. Run after `tsc` from both the `build` and `test`
// npm scripts.
import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
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

const fixturesSrc = join(mcpServerRoot, 'test', 'fixtures');
const fixturesDest = join(mcpServerRoot, 'dist', 'test', 'fixtures');

if (existsSync(fixturesSrc)) {
  mkdirSync(fixturesDest, { recursive: true });
  cpSync(fixturesSrc, fixturesDest, { recursive: true });
}
