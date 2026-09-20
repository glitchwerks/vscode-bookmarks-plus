#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE_NAME = '@glitchwerks/bookmarks-plus-mcp';
const TAG_PATTERN = /^mcp-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export function validateRelease({ tag, manifest, changelogText }) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must match mcp-vMAJOR.MINOR.PATCH`);
  }

  const version = match[1];
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`Package name must be ${EXPECTED_PACKAGE_NAME}; got ${manifest.name}`);
  }
  if (manifest.version !== version) {
    throw new Error(`Manifest version ${manifest.version} does not match tag version ${version}`);
  }

  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## \\[${escapedVersion}\\] — \\d{4}-\\d{2}-\\d{2}$`, 'm');
  if (!heading.test(changelogText)) {
    throw new Error(`Changelog is missing a dated heading for ${version}`);
  }
  return version;
}

export function validateCurrentRelease(rootDirectory = process.cwd()) {
  const tag = process.env.MCP_RELEASE_TAG ?? '';
  const manifest = JSON.parse(readFileSync(resolve(rootDirectory, 'package.json'), 'utf8'));
  const changelogText = readFileSync(resolve(rootDirectory, 'CHANGELOG.md'), 'utf8');
  return validateRelease({ tag, manifest, changelogText });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = validateCurrentRelease();
    console.log(`validate-release: OK (${EXPECTED_PACKAGE_NAME}@${version})`);
  } catch (error) {
    console.error(`validate-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
