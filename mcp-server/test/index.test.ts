import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../src/index.js';
import type { Config } from '../src/config.js';

// createServer must never itself read or write the mirror file — tool
// registration only closes over `config`, it does not perform I/O — so an
// arbitrary (non-existent) workspace path is fine here. Real filesystem
// fixtures are unnecessary for this test.
function makeConfig(): Config {
  const workspacePath = path.join(os.tmpdir(), 'bookmarks-index-test-workspace');
  return {
    workspacePath,
    mirrorPath: path.join(workspacePath, '.vscode', 'bookmarks.json'),
    verifyDelayMs: 400,
  };
}

/**
 * The SDK's `McpServer` has no public API to list what has been registered
 * (`registerTool` returns a handle to the *newly* registered tool, not the
 * full registry). `_registeredTools` is a plain (non-`#private`) instance
 * property set by `_createRegisteredTool` — see
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:605-653`
 * (`this._registeredTools[name] = registeredTool`, `:649`) — so it is
 * readable at runtime despite being declared `private` in `mcp.d.ts`
 * (TS-only privacy, not a real JS private field). This is the only
 * introspection point the installed SDK (v1.30.x) exposes short of driving
 * a real `tools/list` protocol round trip, which would require connecting a
 * transport — exactly what this test must avoid.
 */
interface RegisteredToolLike {
  annotations?: Record<string, unknown>;
}

interface McpServerInternals {
  _registeredTools: Record<string, RegisteredToolLike>;
}

function registeredTools(server: McpServer): Record<string, RegisteredToolLike> {
  return (server as unknown as McpServerInternals)._registeredTools;
}

test('createServer registers exactly list_bookmarks and add_bookmark with the expected annotations, without connecting a transport', () => {
  const config = makeConfig();

  const server = createServer(config);

  // 1. Returns an McpServer without throwing, and this test never calls
  // .connect() — the assertion below confirms the server agrees it is not
  // connected, keeping the test fast and hermetic (no stdio transport, no
  // process I/O).
  assert.ok(server instanceof McpServer);
  assert.equal(server.isConnected(), false);

  // 2. Exactly two tools are registered — no more, no fewer.
  const registered = registeredTools(server);
  assert.deepEqual(Object.keys(registered).sort(), ['add_bookmark', 'list_bookmarks']);

  // 3. Each tool's annotations match tools/list.ts and tools/add.ts exactly.
  assert.deepEqual(registered.list_bookmarks.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(registered.add_bookmark.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
});
