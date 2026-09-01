#!/usr/bin/env node
// Copies test/fixtures/ into dist/test/fixtures/ so compiled tests (which run
// from dist/, per tsconfig.test.json's outDir) can read the same fixture
// files their .ts sources reference. Invoked only from the `test` npm
// script -- never from `build` -- so a plain `npm run build` never emits
// dist/test/** (issue #66 / T1, constraint 3.1(a)). This logic used to live,
// unconditionally and incorrectly, inside scripts/copy-schema.mjs.
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = join(here, '..');

const fixturesSrc = join(mcpServerRoot, 'test', 'fixtures');
const fixturesDest = join(mcpServerRoot, 'dist', 'test', 'fixtures');

if (existsSync(fixturesSrc)) {
  mkdirSync(fixturesDest, { recursive: true });
  cpSync(fixturesSrc, fixturesDest, { recursive: true });
}
