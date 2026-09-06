'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const { createJsonRpcClient } = require('./mcp-json-rpc.cjs');

const EXTENSION_ID = 'cbeaulieu-gt.vscode-bookmarks-plus';
const MCP_TEST_DEFINITIONS_COMMAND = 'bookmarks.test.getMcpServerDefinitions';
const MIRROR_RELATIVE_PATH = path.join('.vscode', 'bookmarks.json');
const MIRROR_ADOPTION_WINDOW_MS = 1_000;

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
  const definitions = await vscode.commands.executeCommand(MCP_TEST_DEFINITIONS_COMMAND);
  assert.ok(Array.isArray(definitions), 'normal activation must expose registered MCP definitions');
  assert.equal(definitions.length, 1, 'a single-root workspace must register one MCP server');
  const definition = definitions[0];
  assert.ok(
    definition instanceof vscode.McpStdioServerDefinition,
    'the registered MCP server must use stdio',
  );
  assert.equal(definition.label, 'Bookmarks Plus');
  assert.equal(definition.version, extension.packageJSON.version);

  const [bundlePath, definedWorkspacePath] = definition.args;
  assert.equal(existsSync(bundlePath), true, 'the extracted VSIX must contain the MCP bundle');
  assert.equal(canonicalPath(definedWorkspacePath), canonicalPath(workspacePath));
  writeFileSync(targetPath, 'packaged MCP integration target\n');

  await waitUntil('the packaged extension mirror initialization', () => existsSync(mirrorPath));

  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(definition.env)) {
    if (value === null) {
      delete childEnv[key];
    } else {
      childEnv[key] = String(value);
    }
  }
  const child = spawn(definition.command, definition.args, {
    cwd: definition.cwd?.fsPath ?? extension.extensionPath,
    env: childEnv,
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

    // The store is closure-private, so there is no supported readiness signal for watcher
    // adoption. Allow filesystem delivery plus the 150 ms debounce to settle, then mutate once;
    // a missed adoption must fail instead of being masked by repeated remove commands.
    await new Promise((resolve) => setTimeout(resolve, MIRROR_ADOPTION_WINDOW_MS));
    await vscode.commands.executeCommand('bookmarks.remove', targetUri);
    await waitUntil('the packaged extension removal to reach the mirror', () =>
      !readMirror(mirrorPath).items.some((item) => item.id === added.id),
    );

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
}

module.exports = { run };
