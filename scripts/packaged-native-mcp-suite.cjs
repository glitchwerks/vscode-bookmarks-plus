'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync, realpathSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const { createJsonRpcClient } = require('./mcp-json-rpc.cjs');

const EXTENSION_ID = 'cbeaulieu-gt.vscode-bookmarks-plus';
const MCP_TEST_DEFINITIONS_COMMAND = 'bookmarks.test.getMcpServerDefinitions';
const MCP_TEST_RESOLVE_COMMAND = 'bookmarks.test.resolveMcpServerDefinition';
const MCP_TEST_STATE_COMMAND = 'bookmarks.test.getScopedBookmarkState';

function canonicalPath(value) {
  const resolved = realpathSync(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toolPayload(response) {
  assert.equal(response.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(response.error)}`);
  assert.notEqual(response.result?.isError, true, `unexpected MCP tool error: ${JSON.stringify(response.result)}`);

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
  const explicitSuccessPayload = { items: [{ id: 'explicit-success' }] };
  assert.deepEqual(
    toolPayload({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify(explicitSuccessPayload) }],
        structuredContent: explicitSuccessPayload,
        isError: false,
      },
    }),
    explicitSuccessPayload,
    'an explicit isError: false result must remain a successful structured payload',
  );

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

  const api = await extension.activate();
  assert.deepEqual(api.apiVersion, { major: 1, minor: 0 });
  assert.equal(Object.isFrozen(api), true);
  assert.equal(typeof api.requestMcpConnection, 'function');

  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 2, 'an anchor folder keeps the host alive when the selected folder is removed');
  assert.equal(canonicalPath(folders[1].uri.fsPath), canonicalPath(expectedWorkspacePath));

  const workspacePath = folders[1].uri.fsPath;
  const targetPath = path.join(workspacePath, 'packaged-mcp-target.txt');
  const targetUri = vscode.Uri.file(targetPath);
  const definitions = await vscode.commands.executeCommand(MCP_TEST_DEFINITIONS_COMMAND);
  assert.ok(Array.isArray(definitions), 'normal activation must expose registered MCP definitions');
  assert.equal(definitions.length, 2, 'each attached root must register one MCP server');
  assert.ok(definitions.every(value => value.env.BOOKMARKS_PLUS_BRIDGE_TOKEN === undefined));
  const selected = definitions.find(value => canonicalPath(value.args[1]) === canonicalPath(workspacePath));
  assert.ok(selected, 'enumeration must identify the selected workspace');
  const rootUri = selected.env.BOOKMARKS_PLUS_ROOT_URI;
  const definition = await vscode.commands.executeCommand(MCP_TEST_RESOLVE_COMMAND, rootUri);
  assert.ok(definition, 'native launch must resolve a fresh bridge grant');
  assert.ok(
    definition instanceof vscode.McpStdioServerDefinition,
    'the registered MCP server must use stdio',
  );
  assert.equal(definition.label, 'Bookmarks Plus (workspace)');
  assert.equal(definition.version, extension.packageJSON.version);

  const [bundlePath, definedWorkspacePath] = definition.args;
  assert.equal(existsSync(bundlePath), true, 'the extracted VSIX must contain the MCP bundle');
  assert.equal(canonicalPath(definedWorkspacePath), canonicalPath(workspacePath));
  writeFileSync(targetPath, 'packaged MCP integration target\n');

  const launch = (resolved) => {
    const childEnv = { ...process.env };
    for (const [key, value] of Object.entries(resolved.env)) {
      if (value === null) delete childEnv[key];
      else childEnv[key] = String(value);
    }
    return spawn(resolved.command, resolved.args, {
      cwd: resolved.cwd?.fsPath ?? extension.extensionPath,
      env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  const child = launch(definition);
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
    assert.deepEqual(initialList.grantedScopes, ['workspace', 'global']);
    assert.equal(Object.hasOwn(initialList, 'mirrorPath'), false);

    const added = toolPayload(await client.request('tools/call', {
      name: 'add_bookmark',
      arguments: {
        uri: targetUri.toString(),
        type: 'file',
        description: 'added through the packaged MCP server',
      },
    }));
    assert.equal(typeof added.id, 'string');
    assert.equal(added.scope, 'workspace');
    assert.equal(Object.hasOwn(added, 'mirrorPath'), false);
    const globalUri = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'global-target.txt'));
    const globalAdded = toolPayload(await client.request('tools/call', {
      name: 'add_bookmark', arguments: { uri: globalUri.toString(), type: 'file', scope: 'global' },
    }));
    assert.equal(globalAdded.scope, 'global');
    assert.equal(Object.hasOwn(globalAdded, 'mirrorPath'), false);
    const state = await vscode.commands.executeCommand(MCP_TEST_STATE_COMMAND, rootUri);
    assert.deepEqual(state.workspace.items.map(item => item.id), [added.id]);
    assert.deepEqual(state.global.items.map(item => item.id), [globalAdded.id]);
    const populated = toolPayload(await client.request('tools/call', { name: 'list_bookmarks', arguments: {} }));
    assert.deepEqual(populated.items.map(item => [item.id, item.scope]), [[added.id, 'workspace'], [globalAdded.id, 'global']]);
    assert.equal(Object.hasOwn(populated, 'mirrorPath'), false);
    await vscode.commands.executeCommand('bookmarks.remove', targetUri);
    await vscode.commands.executeCommand('bookmarks.remove', globalUri);

    const finalList = toolPayload(await client.request('tools/call', {
      name: 'list_bookmarks',
      arguments: {},
    }));
    assert.deepEqual(finalList.items, []);
    client.assertNoStdoutNoise();

    assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
    await waitUntil('VS Code to remove the selected root', () => vscode.workspace.workspaceFolders.length === 1);
    await waitUntil('selected-root reconciliation', async () =>
      (await vscode.commands.executeCommand(MCP_TEST_DEFINITIONS_COMMAND)).length === 1);
    await waitUntil('selected-root removal to close the native child', () => child.exitCode !== null && child.stdout.readableEnded);
    assert.equal(child.exitCode, 0);
    client.assertNoStdoutNoise();

    // Use the packaged module's existing lifecycle export; no extra production test command.
    const remaining = (await vscode.commands.executeCommand(MCP_TEST_DEFINITIONS_COMMAND))[0];
    const retained = await vscode.commands.executeCommand(MCP_TEST_RESOLVE_COMMAND, remaining.env.BOOKMARKS_PLUS_ROOT_URI);
    assert.ok(retained, 'capture an unused live grant before shutdown');
    const loadedExtension = Object.values(require.cache).find(module =>
      module.filename.endsWith(`${path.sep}dist${path.sep}extension.js`) &&
      canonicalPath(module.filename) === canonicalPath(path.join(extension.extensionPath, 'dist', 'extension.js')));
    assert.ok(loadedExtension, 'the packaged extension must already be present in the module cache');
    await loadedExtension.exports.deactivate();
    const stoppedDefinition = await vscode.commands.executeCommand(MCP_TEST_RESOLVE_COMMAND, remaining.env.BOOKMARKS_PLUS_ROOT_URI);
    assert.ok(stoppedDefinition === undefined, 'resolution must fail after stopping the active extension bridge');
    const unavailableChild = launch(retained);
    const unavailable = createJsonRpcClient(unavailableChild, { timeoutMs: 15_000 });
    try {
      await assert.rejects(unavailable.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'closed-bridge-test', version: '1.0.0' },
      }), error => error.data?.bookmarksPlusCode === 'bridge-unavailable');
      await waitUntil('unavailable native startup to exit', () => unavailableChild.exitCode !== null);
      assert.notEqual(unavailableChild.exitCode, 0);
      unavailable.assertNoStdoutNoise();
    } finally { await unavailable.stop(); }
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
