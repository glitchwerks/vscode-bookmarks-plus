'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const { createJsonRpcClient } = require('./mcp-json-rpc.cjs');

const EXTENSION_ID = 'cbeaulieu-gt.vscode-bookmarks-plus';
const MIRROR_RELATIVE_PATH = path.join('.vscode', 'bookmarks.json');

class MemoryMemento {
  constructor() {
    this.values = new Map();
  }

  get(key, defaultValue) {
    return this.values.has(key) ? this.values.get(key) : defaultValue;
  }

  update(key, value) {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }

  keys() {
    return [...this.values.keys()];
  }

  setKeysForSync() {}
}

function canonicalPath(value) {
  const resolved = realpathSync(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readMirror(mirrorPath) {
  return JSON.parse(readFileSync(mirrorPath, 'utf8'));
}

function toolPayload(response) {
  assert.equal(response.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(response.error)}`);
  assert.equal(response.result?.isError, undefined, `unexpected MCP tool error: ${JSON.stringify(response.result)}`);

  if (response.result?.structuredContent !== undefined) {
    return response.result.structuredContent;
  }

  const text = response.result?.content?.find((part) => part.type === 'text')?.text;
  assert.equal(typeof text, 'string', `expected an MCP text result: ${JSON.stringify(response)}`);
  return JSON.parse(text);
}

async function waitUntil(label, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const detail = lastError instanceof Error ? `; last error: ${lastError.message}` : '';
  throw new Error(`timed out waiting for ${label}${detail}`);
}

function createFakeContext(extension) {
  return {
    subscriptions: [],
    workspaceState: new MemoryMemento(),
    globalState: new MemoryMemento(),
    environmentVariableCollection: {
      persistent: true,
      description: undefined,
      replace() {},
    },
    extensionUri: extension.extensionUri,
    extension: { packageJSON: extension.packageJSON },
  };
}

async function capturePackagedProvider(extension, initialFolders) {
  const extensionModulePath = path.resolve(extension.extensionPath, extension.packageJSON.main);
  const extensionModule = require(extensionModulePath);
  const context = createFakeContext(extension);
  let folders = initialFolders;
  let provider;
  let activationError;

  try {
    extensionModule.activate(context, {
      getWorkspaceFolders: () => folders,
      registerProvider: (id, candidate) => {
        assert.equal(id, 'bookmarks-plus.mcp');
        provider = candidate;
        return { dispose() {} };
      },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    });
  } catch (error) {
    if (provider === undefined) {
      throw error;
    }
    activationError = error;
  }

  assert.ok(provider, 'expected the packaged extension to register its MCP provider');
  if (activationError !== undefined) {
    const message = activationError instanceof Error ? activationError.message : String(activationError);
    assert.match(
      message,
      /command ['"]bookmarks\.[^'"]+['"] already exists|already registered/i,
      `unexpected failure after packaged MCP provider registration: ${message}`,
    );
  }

  return {
    async definitionsFor(nextFolders) {
      folders = nextFolders;
      return await provider.provideMcpServerDefinitions();
    },
    dispose() {
      for (const disposable of [...context.subscriptions].reverse()) {
        try {
          disposable.dispose();
        } catch {
          // Best-effort isolation cleanup must not hide the contract assertions.
        }
      }
    },
  };
}

async function run() {
  const expectedExtensionPath = process.env.BOOKMARKS_PACKAGED_EXTENSION_PATH;
  const expectedWorkspacePath = process.env.BOOKMARKS_PACKAGED_WORKSPACE_PATH;
  const expectedMcpVersion = process.env.BOOKMARKS_PACKAGED_MCP_VERSION;
  assert.ok(expectedExtensionPath, 'BOOKMARKS_PACKAGED_EXTENSION_PATH is required');
  assert.ok(expectedWorkspacePath, 'BOOKMARKS_PACKAGED_WORKSPACE_PATH is required');
  assert.ok(expectedMcpVersion, 'BOOKMARKS_PACKAGED_MCP_VERSION is required');

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `expected VS Code to load ${EXTENSION_ID}`);
  assert.equal(
    canonicalPath(extension.extensionPath),
    canonicalPath(expectedExtensionPath),
    'VS Code must load the extension extracted from the packaged VSIX',
  );

  await extension.activate();

  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'the packaged MCP test requires one workspace folder');
  assert.equal(canonicalPath(folders[0].uri.fsPath), canonicalPath(expectedWorkspacePath));

  const workspacePath = folders[0].uri.fsPath;
  const mirrorPath = path.join(workspacePath, MIRROR_RELATIVE_PATH);
  const targetPath = path.join(workspacePath, 'packaged-mcp-target.txt');
  const targetUri = vscode.Uri.file(targetPath);
  const bundlePath = vscode.Uri.joinPath(
    extension.extensionUri,
    'dist',
    'bookmarks-plus-mcp.mjs',
  ).fsPath;
  assert.equal(existsSync(bundlePath), true, 'the extracted VSIX must contain the MCP bundle');
  writeFileSync(targetPath, 'packaged MCP integration target\n');

  await waitUntil('the packaged extension mirror initialization', () => existsSync(mirrorPath));

  const launch = {
    command: process.execPath,
    args: [bundlePath, workspacePath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const child = spawn(launch.command, launch.args, {
    cwd: extension.extensionPath,
    env: { ...process.env, ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createJsonRpcClient(child, { timeoutMs: 15_000 });

  try {
    const initialize = await client.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'packaged-native-mcp-test', version: '1.0.0' },
      },
      'the packaged MCP initialize response',
    );
    assert.equal(initialize.result.serverInfo.name, 'bookmarks-plus-mcp');
    assert.equal(initialize.result.serverInfo.version, expectedMcpVersion);
    client.notify('notifications/initialized');

    const tools = await client.request('tools/list', {}, 'the packaged MCP tools/list response');
    assert.deepEqual(
      tools.result.tools.map(({ name }) => name).sort(),
      ['add_bookmark', 'list_bookmarks'],
    );

    const initialList = toolPayload(await client.request('tools/call', {
      name: 'list_bookmarks',
      arguments: {},
    }));
    assert.deepEqual(initialList.items, []);

    const added = toolPayload(await client.request('tools/call', {
      name: 'add_bookmark',
      arguments: {
        uri: targetUri.toString(),
        type: 'file',
        description: 'added through the packaged MCP server',
      },
    }));
    assert.equal(typeof added.id, 'string');

    await waitUntil('the MCP-written bookmark to appear in the mirror', () =>
      readMirror(mirrorPath).items.some((item) => item.id === added.id),
    );

    await waitUntil('the packaged extension to adopt and remove the MCP-written bookmark', async () => {
      await vscode.commands.executeCommand('bookmarks.remove', targetUri);
      return !readMirror(mirrorPath).items.some((item) => item.id === added.id);
    });

    const finalList = toolPayload(await client.request('tools/call', {
      name: 'list_bookmarks',
      arguments: {},
    }));
    assert.deepEqual(finalList.items, []);
    client.assertNoStdoutNoise();
  } catch (error) {
    const stderr = client.getStderr().trim();
    if (stderr.length > 0 && error instanceof Error && !error.message.includes('stderr:')) {
      error.message = `${error.message}; stderr: ${stderr}`;
    }
    throw error;
  } finally {
    await client.stop();
  }

  const provider = await capturePackagedProvider(extension, folders);
  try {
    const singleRootDefinitions = await provider.definitionsFor(folders);
    assert.equal(singleRootDefinitions.length, 1);
    assert.equal(singleRootDefinitions[0].command, launch.command);
    assert.deepEqual(singleRootDefinitions[0].args, launch.args);
    assert.deepEqual(singleRootDefinitions[0].env, launch.env);
    assert.equal(singleRootDefinitions[0].version, extension.packageJSON.version);

    assert.deepEqual(await provider.definitionsFor(undefined), []);
    assert.deepEqual(
      await provider.definitionsFor([
        { uri: folders[0].uri },
        { uri: vscode.Uri.file(path.join(workspacePath, 'second-root')) },
      ]),
      [],
    );
  } finally {
    provider.dispose();
  }
}

module.exports = { run };
