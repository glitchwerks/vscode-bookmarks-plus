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

function collectJsonRpcResponse(child, id) {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      resolve(value);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) {
          continue;
        }
        try {
          const message = JSON.parse(line);
          if (message.id === id) {
            finish(message);
            return;
          }
        } catch {
          // Ignore non-JSON stdout noise while waiting for the requested response.
        }
      }
    };

    const onExit = () => finish(undefined);
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function waitFor(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
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
  execFileSync(process.execPath, ['esbuild.js'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  const sourceMap = JSON.parse(readFileSync(bundleSourceMap, 'utf8'));
  const normalizedSources = sourceMap.sources.map((source) => source.replaceAll('\\', '/'));

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
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const initializeResponsePromise = collectJsonRpcResponse(child, 1);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bundle-test-client', version: '0.0.0' },
        },
      })}\n`,
    );

    const initializeResponse = await waitFor(
      initializeResponsePromise,
      10_000,
      'the bundled MCP initialize response',
    );
    assert.ok(initializeResponse, `expected initialize response; stderr: ${stderr}`);
    assert.equal(initializeResponse.result.serverInfo.name, 'bookmarks-plus-mcp');
    assert.equal(initializeResponse.result.serverInfo.version, mcpPackage.version);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })}\n`,
    );

    const toolsResponsePromise = collectJsonRpcResponse(child, 2);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );

    const toolsResponse = await waitFor(
      toolsResponsePromise,
      10_000,
      'the bundled MCP tools/list response',
    );
    assert.ok(toolsResponse, `expected tools/list response; stderr: ${stderr}`);
    assert.deepEqual(
      toolsResponse.result.tools.map(({ name }) => name).sort(),
      ['add_bookmark', 'list_bookmarks'],
    );
  } finally {
    await stopChild(child);
  }
});

test('VSIX contains the bundled MCP runtime without raw server files or dependencies', async () => {
  assert.equal(
    rootPackage.devDependencies.yauzl,
    '2.10.0',
    'expected yauzl to be a direct test dependency rather than an accidental transitive import',
  );

  const packageDir = makeTempDir('bookmarks-plus-vsix-');
  const vsixPath = join(packageDir, 'bookmarks-plus.vsix');
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
});
