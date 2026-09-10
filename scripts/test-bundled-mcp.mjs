import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vsce from '@vscode/vsce';
import yauzl from 'yauzl';

import { createJsonRpcClient } from './mcp-json-rpc.cjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtBundle = join(repoRoot, 'dist', 'bookmarks-plus-mcp.mjs');
const bundleSourceMap = `${builtBundle}.map`;
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const mcpPackage = JSON.parse(
  readFileSync(join(repoRoot, 'mcp-server', 'package.json'), 'utf8'),
);
const tempDirs = [];

function makeTempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function removeDirWithRetry(directory) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(directory, { recursive: true, force: true });
  }
}

function readZipEntries(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, archive) => {
      if (openError) {
        reject(openError);
        return;
      }

      const entries = [];
      archive.on('error', reject);
      archive.on('entry', (entry) => {
        entries.push(entry.fileName.replaceAll('\\', '/'));
        archive.readEntry();
      });
      archive.on('end', () => resolve(entries));
      archive.readEntry();
    });
  });
}

before(() => {
  execFileSync(process.execPath, ['esbuild.js', '--production'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
});

after(async () => {
  for (const directory of tempDirs) {
    await removeDirWithRetry(directory);
  }
});

test('production build emits both extension and MCP bundles', () => {
  assert.equal(existsSync(join(repoRoot, 'dist', 'extension.js')), true);
  assert.equal(
    existsSync(builtBundle),
    true,
    'expected the production build to emit dist/bookmarks-plus-mcp.mjs',
  );
});

test('MCP bundle resolves its shared runtime dependencies from the verified root install', () => {
  let normalizedSources;
  try {
    execFileSync(process.execPath, ['esbuild.js'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    const sourceMap = JSON.parse(readFileSync(bundleSourceMap, 'utf8'));
    normalizedSources = sourceMap.sources.map((source) => source.replaceAll('\\', '/'));
  } finally {
    execFileSync(process.execPath, ['esbuild.js', '--production'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  }

  for (const dependency of ['@modelcontextprotocol/sdk', 'zod']) {
    const rootDependencyPrefix = `../node_modules/${dependency}/`;
    assert.ok(
      normalizedSources.some((source) => source.startsWith(rootDependencyPrefix)),
      `expected bundle inputs from ${rootDependencyPrefix}`,
    );
  }
  assert.equal(
    normalizedSources.some((source) => source.startsWith('../mcp-server/node_modules/')),
    false,
    'expected no bundle inputs from the independently installed standalone package dependencies',
  );
  assert.equal(
    /\/\/# sourceMappingURL=/.test(readFileSync(builtBundle, 'utf8')),
    false,
    'expected source-map inspection to leave the production MCP bundle restored',
  );
});

test('isolated MCP bundle initializes with its own version and lists both tools', async () => {
  const bundleDir = makeTempDir('bookmarks-plus-mcp-bundle-');
  const copiedBundle = join(bundleDir, 'bookmarks-plus-mcp.mjs');
  copyFileSync(builtBundle, copiedBundle);

  const workspaceDir = makeTempDir('bookmarks-plus-mcp-workspace-');
  mkdirSync(join(workspaceDir, '.vscode'), { recursive: true });
  writeFileSync(
    join(workspaceDir, '.vscode', 'bookmarks.json'),
    JSON.stringify({ version: 1, items: [], collections: [] }),
  );

  assert.equal(existsSync(join(bundleDir, 'node_modules')), false);

  const child = spawn(process.execPath, [copiedBundle, workspaceDir], {
    cwd: bundleDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createJsonRpcClient(child);

  try {
    const initializeResponse = await client.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bundle-test-client', version: '0.0.0' },
      },
      'the bundled MCP initialize response',
    );
    assert.equal(initializeResponse.result.serverInfo.name, 'bookmarks-plus-mcp');
    assert.equal(initializeResponse.result.serverInfo.version, mcpPackage.version);

    client.notify('notifications/initialized');

    const toolsResponse = await client.request(
      'tools/list',
      {},
      'the bundled MCP tools/list response',
    );
    assert.deepEqual(
      toolsResponse.result.tools.map(({ name }) => name).sort(),
      ['add_bookmark', 'list_bookmarks'],
    );
    const listed = await client.request('tools/call', { name: 'list_bookmarks', arguments: {} });
    assert.deepEqual(listed.result.structuredContent, {
      workspacePath: workspaceDir,
      mirrorPath: join(workspaceDir, '.vscode', 'bookmarks.json'),
      version: 1, collections: [], items: [],
    });
    const added = await client.request('tools/call', {
      name: 'add_bookmark', arguments: { type: 'file', uri: 'file:///standalone-target' },
    });
    const payload = added.result.structuredContent;
    assert.equal(typeof payload.id, 'string');
    assert.deepEqual(payload, {
      id: payload.id, scope: 'workspace', collection: null,
      mirrorPath: join(workspaceDir, '.vscode', 'bookmarks.json'),
    });
    const afterAdd = await client.request('tools/call', { name: 'list_bookmarks', arguments: {} });
    assert.deepEqual(afterAdd.result.structuredContent.items.map(item => [item.id, item.uri, item.scope]),
      [[payload.id, 'file:///standalone-target', 'workspace']]);
    client.assertNoStdoutNoise();
  } finally {
    await client.stop();
  }
});

test('VSIX contains the bundled MCP runtime without raw server files, dependencies, or scratch artifacts', async () => {
  assert.equal(
    rootPackage.devDependencies.yauzl,
    '2.10.0',
    'expected yauzl to be a direct test dependency rather than an accidental transitive import',
  );

  const packageDir = makeTempDir('bookmarks-plus-vsix-');
  const vsixPath = join(packageDir, 'bookmarks-plus.vsix');
  const scratchDir = join(repoRoot, '.tmp');
  const scratchFile = join(scratchDir, 'packaging-regression-sentinel.txt');
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(scratchFile, 'must not ship\n');

  try {
    await vsce.createVSIX({
      cwd: repoRoot,
      packagePath: vsixPath,
      dependencies: false,
    });

    const entries = await readZipEntries(vsixPath);
    assert.ok(entries.includes('extension/dist/extension.js'));
    assert.ok(entries.includes('extension/dist/bookmarks-plus-mcp.mjs'));
    assert.equal(entries.some((entry) => entry.startsWith('extension/mcp-server/')), false);
    assert.equal(entries.some((entry) => entry.includes('/node_modules/')), false);
    assert.equal(entries.some((entry) => entry.startsWith('extension/.tmp/')), false);
  } finally {
    await rm(scratchFile, { force: true });
  }
});
