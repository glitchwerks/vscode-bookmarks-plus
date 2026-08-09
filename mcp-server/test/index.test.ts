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
 *
 * `registeredTool.handler` (same object literal, `mcp.js:616`) is exposed
 * for the same reason and used below to prove that a disabledReason passed
 * to `createServer` actually reaches a tool's *call*-time behavior, not
 * merely that registration succeeds -- calling the stored handler directly
 * bypasses the SDK's request-routing layer entirely (no transport, no
 * schema validation before the call), which is exactly the introspection
 * this suite needs and nothing more.
 */
interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface RegisteredToolLike {
  annotations?: Record<string, unknown>;
  handler: (args: unknown) => Promise<ToolResultLike>;
}

/** Joins every text content block in a tool result into one string. */
function resultText(result: ToolResultLike): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
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

// ---------------------------------------------------------------------------
// createServer(config: Config | undefined, options?: { disabledReason?: string })
// (spec § 4B.8, strategy (a)). Registration itself must never fail on a
// disabled workspace -- the transport still connects, and the refusal is
// deferred to tool-call time inside each handler.
// ---------------------------------------------------------------------------

test('createServer still accepts a single Config argument (the pre-#57 call shape) and registers both tools', () => {
  const config = makeConfig();

  const server = createServer(config);

  const registered = registeredTools(server);
  assert.deepEqual(Object.keys(registered).sort(), ['add_bookmark', 'list_bookmarks']);
});

test('createServer(undefined, { disabledReason }) still registers both tools without throwing -- the disabled refusal is deferred to tool-call time, not registration time', () => {
  const server = createServer(undefined, { disabledReason: 'some reason' });

  assert.ok(server instanceof McpServer);
  assert.equal(server.isConnected(), false);

  const registered = registeredTools(server);
  assert.deepEqual(Object.keys(registered).sort(), ['add_bookmark', 'list_bookmarks']);
});

test('createServer(undefined, { disabledReason }) threads the reason through to a real list_bookmarks call, not just past registration', async () => {
  // Registering successfully is not enough: createServer must actually pass
  // disabledReason into createListHandler's deps, or a call would surface
  // only a generic message (or worse, attempt real I/O). Calling the stored
  // handler directly exercises that wiring without a transport.
  const server = createServer(undefined, {
    disabledReason: 'Bookmarks are unavailable: no workspace folder is open.',
  });
  const registered = registeredTools(server);

  const result = await registered.list_bookmarks.handler({});

  assert.equal(result.isError, true);
  assert.ok(
    resultText(result).includes('no workspace folder is open'),
    'the disabledReason passed to createServer must reach the list_bookmarks call',
  );
});

test('createServer(undefined, { disabledReason }) threads the reason through to a real add_bookmark call, not just past registration', async () => {
  const server = createServer(undefined, {
    disabledReason: 'Bookmarks are unavailable: multi-root workspaces are not supported yet.',
  });
  const registered = registeredTools(server);

  const result = await registered.add_bookmark.handler({
    uri: 'file:///workspace/should-not-be-written.ts',
    type: 'file',
  });

  assert.equal(result.isError, true);
  assert.ok(
    resultText(result).includes('multi-root workspaces are not supported yet'),
    'the disabledReason passed to createServer must reach the add_bookmark call',
  );
});
