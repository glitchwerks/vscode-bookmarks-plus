#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function discoverTestFiles(rootDirectory) {
  const root = resolve(rootDirectory);
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        files.push(path);
      }
    }
  }

  visit(root);
  files.sort();
  if (files.length === 0) {
    throw new Error(`No .test.js files found under ${root}`);
  }
  return files;
}

export function buildNodeTestArguments(testFiles) {
  return ['--test', ...testFiles];
}

export function runTests(testRoot = resolve('dist', 'test')) {
  const result = spawnSync(
    process.execPath,
    buildNodeTestArguments(discoverTestFiles(testRoot)),
    { stdio: 'inherit' },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runTests();
  } catch (error) {
    console.error(`run-tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
