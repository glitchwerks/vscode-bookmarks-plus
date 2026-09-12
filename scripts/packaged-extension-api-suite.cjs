'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { createJsonRpcClient } = require('./mcp-json-rpc.cjs');

/** Compare host paths across Windows drive-letter casing and junctions. */
function canonicalPath(value) {
  const resolved = realpathSync(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Decode an MCP tool result, rejecting protocol and application failures. */
function toolPayload(response) {
  assert.equal(response.error, undefined);
  assert.notEqual(response.result?.isError, true);
  if (response.result?.structuredContent !== undefined) return response.result.structuredContent;
  const text = response.result?.content?.find(part => part.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

/** Bound asynchronous workspace reconciliation and process shutdown assertions. */
async function waitUntil(label, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Exercise only the optional consumer's public activation export. */
async function run() {
  const scenario = process.env.BOOKMARKS_PACKAGED_API_SCENARIO;
  const expectedConsumerPath = process.env.BOOKMARKS_PACKAGED_CONSUMER_PATH;
  const expectedProducerPath = process.env.BOOKMARKS_PACKAGED_EXTENSION_PATH;
  const expectedWorkspacePath = process.env.BOOKMARKS_PACKAGED_WORKSPACE_PATH;
  const expectedMcpVersion = process.env.BOOKMARKS_PACKAGED_MCP_VERSION;
  assert.ok(['trusted', 'missing', 'incompatible', 'restricted'].includes(scenario));
  assert.ok(expectedConsumerPath);
  assert.ok(expectedWorkspacePath);
  assert.ok(expectedMcpVersion);
  const consumer = vscode.extensions.getExtension('bookmarks-plus-tests.api-consumer');
  assert.ok(consumer, 'VS Code must discover the optional second extension');
  assert.equal(canonicalPath(consumer.extensionPath), canonicalPath(expectedConsumerPath));
  assert.equal(consumer.packageJSON.extensionDependencies, undefined);
  const adapter = await consumer.activate();
  assert.equal(typeof adapter.connect, 'function');
  const producer = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 2, 'an anchor keeps the host alive after selected-root removal');
  assert.equal(canonicalPath(folders[1].uri.fsPath), canonicalPath(expectedWorkspacePath));
  const workspaceFolderUri = folders[1].uri.toString(true);

  if (scenario === 'missing') {
    assert.equal(producer, undefined);
    assert.deepEqual(await adapter.connect(workspaceFolderUri), {
      kind: 'fallback', reason: 'missing-extension',
    });
  } else {
    assert.ok(producer, 'the scenario must load its producer');
    assert.ok(expectedProducerPath);
    assert.equal(canonicalPath(producer.extensionPath), canonicalPath(expectedProducerPath));
    if (scenario === 'incompatible') {
      assert.deepEqual(await adapter.connect(workspaceFolderUri), {
        kind: 'fallback', reason: 'incompatible-api',
      });
    } else if (scenario === 'restricted') {
      assert.equal(vscode.workspace.isTrusted, false);
      assert.equal(producer.isActive, false);
      const outcome = await adapter.connect(workspaceFolderUri);
      assert.deepEqual(outcome, { kind: 'fallback', reason: 'workspace-untrusted' });
      assert.equal(producer.isActive, false, 'optional discovery must not activate a trust-disabled producer');
    } else {
      assert.equal(vscode.workspace.isTrusted, true);
      const outcome = await adapter.connect(workspaceFolderUri);
      assert.equal(outcome?.kind, 'descriptor');
      await exerciseDescriptor(outcome.descriptor, folders, expectedMcpVersion);
    }
  }
  console.log(`Packaged public API scenario passed: ${scenario}`);
}

/** Use the public descriptor from an unrelated cwd and verify both granted scopes. */
async function exerciseDescriptor(descriptor, folders, expectedMcpVersion) {
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.transport, 'stdio');
  assert.equal(path.isAbsolute(descriptor.command), true);
  assert.equal(descriptor.args.every(value => path.isAbsolute(value)), true);
  assert.equal(Object.hasOwn(descriptor, 'cwd'), false);
  assert.deepEqual(descriptor.grantedScopes, ['workspace', 'global']);
  assert.deepEqual(descriptor.sensitiveEnvKeys, ['BOOKMARKS_PLUS_BRIDGE_TOKEN']);
  const token = descriptor.env.BOOKMARKS_PLUS_BRIDGE_TOKEN;
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);
  assert.equal(JSON.stringify({
    ...descriptor, env: { ...descriptor.env, BOOKMARKS_PLUS_BRIDGE_TOKEN: '[redacted]' },
  }).includes(token), false, 'redacting the declared secret must remove it from the descriptor');

  const unrelatedCwd = mkdtempSync(path.join(tmpdir(), 'bookmarks-api-cwd-'));
  const targetUri = vscode.Uri.file(path.join(folders[1].uri.fsPath, 'api-target.txt'));
  const globalUri = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'api-global-target.txt'));
  writeFileSync(targetUri.fsPath, 'API workspace target\n');
  writeFileSync(globalUri.fsPath, 'API global target\n');
  const child = spawn(descriptor.command, descriptor.args, {
    cwd: unrelatedCwd, env: { ...process.env, ...descriptor.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createJsonRpcClient(child, { timeoutMs: 15_000 });
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'packaged-api-consumer-test', version: '1.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'bookmarks-plus-mcp');
    assert.equal(initialized.result.serverInfo.version, expectedMcpVersion);
    client.notify('notifications/initialized');
    const tools = await client.request('tools/list');
    assert.deepEqual(tools.result.tools.map(({ name }) => name).sort(), ['add_bookmark', 'list_bookmarks']);
    const initial = toolPayload(await client.request('tools/call', { name: 'list_bookmarks', arguments: {} }));
    assert.deepEqual(initial.items, []);
    assert.deepEqual(initial.grantedScopes, ['workspace', 'global']);
    const workspaceAdded = toolPayload(await client.request('tools/call', {
      name: 'add_bookmark', arguments: { uri: targetUri.toString(), type: 'file', scope: 'workspace' },
    }));
    const globalAdded = toolPayload(await client.request('tools/call', {
      name: 'add_bookmark', arguments: { uri: globalUri.toString(), type: 'file', scope: 'global' },
    }));
    assert.equal(typeof workspaceAdded.id, 'string');
    assert.equal(workspaceAdded.scope, 'workspace');
    assert.equal(typeof globalAdded.id, 'string');
    assert.equal(globalAdded.scope, 'global');
    const populated = toolPayload(await client.request('tools/call', { name: 'list_bookmarks', arguments: {} }));
    assert.deepEqual(populated.items.map(item => [item.id, item.scope]), [
      [workspaceAdded.id, 'workspace'], [globalAdded.id, 'global'],
    ]);
    await vscode.commands.executeCommand('bookmarks.remove', targetUri);
    await vscode.commands.executeCommand('bookmarks.remove', globalUri);
    const finalList = toolPayload(await client.request('tools/call', { name: 'list_bookmarks', arguments: {} }));
    assert.deepEqual(finalList.items, []);
    assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
    await waitUntil('selected root removal', () => vscode.workspace.workspaceFolders.length === 1);
    await waitUntil('descriptor child to exit', () => child.exitCode !== null && child.stdout.readableEnded);
    assert.equal(child.exitCode, 0);
    client.assertNoStdoutNoise();
  } finally {
    await client.stop();
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
}

module.exports = { run };
