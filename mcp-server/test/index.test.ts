import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../src/index.js';
import type { Config } from '../src/config.js';

// Same import.meta.url -> directory pattern established in contract.test.ts
// / add.test.ts / schemaDrift.test.ts, for the same reason: import.meta.dirname
// needs Node >=20.11 and is not reliably typed against this project's pinned
// @types/node. This compiled test file lives at dist/test/index.test.js, so
// dist/src sits one directory above it (sibling of dist/test) and the
// package.json root two directories above it.
const here = path.dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// Reported server version (CodeRabbit regression: index.ts:22 hardcodes the
// literal '0.0.0' as the version reported to MCP clients, instead of reading
// it from mcp-server/package.json).
// ---------------------------------------------------------------------------

/**
 * `McpServer.server` (readonly, public per mcp.d.ts) is the underlying
 * low-level `Server`, which stores its constructor's `serverInfo` argument
 * on the plain (non-`#private`) instance property `_serverInfo` -- see
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:37-39`
 * (`this._serverInfo = _serverInfo`). Same "TS-only privacy, readable at
 * runtime" situation as this file's own `_registeredTools` introspection
 * above, and the only way to observe the reported version without
 * connecting a transport and round-tripping a real `initialize` call.
 */
interface ServerWithInfo {
  _serverInfo?: { name?: string; version?: string };
}

test("createServer reports mcp-server/package.json's actual version to clients, not a hardcoded literal", () => {
  const config = makeConfig();

  const server = createServer(config);

  const packageJsonPath = path.join(here, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };

  const info = (server.server as unknown as ServerWithInfo)._serverInfo;
  assert.equal(
    info?.version,
    packageJson.version,
    "the server's reported version must be read from package.json, not hardcoded",
  );
});

// ---------------------------------------------------------------------------
// Symlinked entrypoint (CodeRabbit regression: index.ts:80 -- the "am I the
// entrypoint" guard compares import.meta.url to a process.argv[1]-derived
// URL without resolving symlinks first. mcp-server/package.json publishes
// dist/index.js as the `bookmarks-plus-mcp` bin, which npm invokes via a
// symlink; without realpathSync, the guard can fail to recognize the module
// as the entrypoint and never call main()).
//
// This is a full subprocess spawn, not a unit test of an extracted guard
// function -- the guard is inline top-level module code in index.ts (there
// is no separate exported function to import and call directly), so the
// only way to exercise the real self-invocation check is to actually invoke
// the compiled module as a child process through a symlink and observe
// whether it starts serving. This is slower and heavier than the rest of
// this suite; that trade-off is accepted here because no cheaper seam exists
// without editing implementation code, which is out of scope for this test
// suite.
// ---------------------------------------------------------------------------

/**
 * Buffers `child`'s stdout, splitting on newlines (the MCP stdio transport's
 * framing -- see `@modelcontextprotocol/sdk/dist/esm/shared/stdio.js`), and
 * resolves with the first parsed JSON-RPC message whose `id` matches, or
 * `undefined` if the child exits first without ever producing one.
 */
function collectJsonRpcResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;

    const finish = (value: Record<string, unknown> | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      resolve(value);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === id) {
            finish(parsed);
            return;
          }
        } catch {
          // Non-JSON stdout noise (there should be none, but ignore rather
          // than fail the test on an unrelated stray line).
        }
      }
    };
    const onExit = (): void => finish(undefined);

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

test('a build invoked through a symlink (mirroring the npm bin shim) still recognizes itself as the entrypoint and starts serving', async () => {
  const distEntrypoint = path.join(here, '..', 'src', 'index.js');
  await assert.doesNotReject(
    () => fs.stat(distEntrypoint),
    "dist/src/index.js must exist -- npm test's tsc step should already have produced it before this test runs",
  );

  const symlinkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-symlink-test-'));
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-symlink-workspace-'));
  const symlinkPath = path.join(symlinkDir, 'bookmarks-plus-mcp');
  let child: ChildProcessWithoutNullStreams | undefined;

  try {
    await fs.symlink(distEntrypoint, symlinkPath, 'file');

    // argv[2] is the highest-precedence workspace tier (config.test.ts's
    // argvWith() convention), so this always resolves regardless of
    // whatever env vars this test process happens to inherit.
    child = spawn(process.execPath, [symlinkPath, workspaceDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responsePromise = collectJsonRpcResponse(child, 1);
    const timeoutPromise = new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), 5000);
    });

    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'symlink-entrypoint-test-client', version: '0.0.0' },
      },
    };
    child.stdin.write(JSON.stringify(initializeRequest) + '\n');

    const response = await Promise.race([responsePromise, timeoutPromise]);

    assert.ok(
      response !== undefined,
      'expected an initialize response over stdout, proving main() ran when the module was invoked through a symlink -- got none (the process likely exited without starting the server, i.e. the entrypoint guard did not recognize itself through the symlink)',
    );
  } finally {
    child?.kill('SIGKILL');
    await fs.rm(symlinkDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
});
