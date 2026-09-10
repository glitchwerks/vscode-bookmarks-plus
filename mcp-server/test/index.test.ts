import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../src/index.js';
import type { BookmarkBackend } from '../src/backend.js';
import net from 'node:net';
import { once } from 'node:events';
import { LIVE_BRIDGE_HANDSHAKE_TIMEOUT_MS } from '../src/liveBridgeClient.js';

// Same import.meta.url -> directory pattern established in contract.test.ts
// / add.test.ts / schemaDrift.test.ts, for the same reason: import.meta.dirname
// needs Node >=20.11 and is not reliably typed against this project's pinned
// @types/node. This compiled test file lives at dist/test/index.test.js, so
// dist/src sits one directory above it (sibling of dist/test) and the
// package.json root two directories above it.
const here = path.dirname(fileURLToPath(import.meta.url));

const liveInitialize = {
  jsonrpc: '2.0', id: 101, method: 'initialize',
  params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'live-startup-test', version: '1' },
  },
};

/** Runs the compiled entrypoint with real stdio and an optional internal deadline override. */
function spawnLive(endpoint: string, override: NodeJS.ProcessEnv = {}, timeoutMs?: number, beforeStart = '') {
  const entrypoint = path.join(here, '..', 'src', 'index.js');
  const args = timeoutMs === undefined ? [entrypoint] : [
    '--input-type=module', '-e',
    beforeStart + `const { runServer } = await import(${JSON.stringify(pathToFileURL(entrypoint).href)});` +
      `await runServer(process.argv, process.env, { handshakeTimeoutMs: ${timeoutMs} });`,
  ];
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BOOKMARKS_PLUS_LIVE_MODE: '1', BOOKMARKS_PLUS_ROOT_URI: 'file:///workspace',
      BOOKMARKS_PLUS_BRIDGE_ENDPOINT: endpoint, BOOKMARKS_PLUS_BRIDGE_PROTOCOL: '1',
      BOOKMARKS_PLUS_BRIDGE_GENERATION: 'generation', BOOKMARKS_PLUS_BRIDGE_TOKEN: 'private-token',
      ...override,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = once(child, 'close');
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

/** Owns a local IPC endpoint and cleans every accepted socket after the test. */
async function fakeBridge(onConnection: (socket: net.Socket) => void) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-init-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\bookmarks-init-${process.pid}-${path.basename(directory)}`
    : path.join(directory, 'bridge.sock');
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  listener.listen(endpoint);
  await once(listener, 'listening');
  return {
    endpoint,
    close: async () => {
      for (const socket of sockets) { socket.destroy(); }
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

const readyFrame = JSON.stringify({
  kind: 'ready', version: 1, sessionId: 'session', workspaceFolderUri: 'file:///workspace',
  grantedScopes: ['workspace', 'global'],
}) + '\n';

test('production live handshake deadline remains ten seconds', () => {
  assert.equal(LIVE_BRIDGE_HANDSHAKE_TIMEOUT_MS, 10_000);
});

for (const behavior of ['silent', 'trickled', 'late-ready'] as const) {
  test(`compiled live startup fails once and closes stdio for a ${behavior} bridge`, async () => {
    let helloSeen = false;
    let socketClosed = false;
    let lateReadyTimer: ReturnType<typeof setTimeout> | undefined;
    let lateReadyAttempt: Promise<void> | undefined;
    const bridge = await fakeBridge((socket) => {
      socket.once('data', () => { helloSeen = true; });
      socket.once('close', () => { socketClosed = true; });
      if (behavior === 'trickled') {
        const timer = setInterval(() => socket.write(' '), 15);
        socket.once('close', () => clearInterval(timer));
      }
      if (behavior === 'late-ready') {
        lateReadyAttempt = new Promise<void>((resolve) => {
          lateReadyTimer = setTimeout(() => { socket.write(readyFrame); resolve(); }, 350);
        });
      }
    });
    const run = spawnLive(bridge.endpoint, {}, 120);
    const ceiling = setTimeout(() => run.child.kill('SIGKILL'), 4000);
    try {
      run.child.stdin.write(JSON.stringify(liveInitialize) + '\n');
      run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' }) + '\n');
      const [code, signal] = await run.closed;
      assert.equal(signal, null, run.stderr());
      assert.equal(code, 1, run.stderr());
      assert.equal(helloSeen, true, 'the compiled entrypoint must attempt authentication');
      assert.equal(socketClosed, true);
      await lateReadyAttempt;
      const responses = run.stdout().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(responses.length, 1, run.stdout());
      assert.deepEqual(responses[0], {
        jsonrpc: '2.0', id: 101,
        error: {
          code: -32000, message: 'The live bridge is unavailable.',
          data: { bookmarksPlusCode: 'bridge-unavailable' },
        },
      });
      assert.equal(run.child.stdout.readableEnded, true);
      assert.ok(!run.stderr().includes('private-token'));
    } finally {
      clearTimeout(ceiling);
      clearTimeout(lateReadyTimer);
      run.child.kill('SIGKILL');
      await bridge.close();
    }
  });
}

test('compiled live entrypoint buffers discovery until ready and closes the bridge on stdin EOF', async () => {
  let authenticate!: () => void;
  let helloResolve!: () => void;
  let closeResolve!: () => void;
  const hello = new Promise<void>((resolve) => { helloResolve = resolve; });
  const socketClosed = new Promise<void>((resolve) => { closeResolve = resolve; });
  const bridge = await fakeBridge((socket) => {
    authenticate = () => { socket.write(readyFrame); };
    socket.once('data', () => helloResolve());
    socket.once('close', () => closeResolve());
  });
  // A hostile-looking timeout env value must not alter the production deadline.
  const run = spawnLive(bridge.endpoint, { BOOKMARKS_PLUS_BRIDGE_HANDSHAKE_TIMEOUT_MS: '1' });
  const ceiling = setTimeout(() => run.child.kill('SIGKILL'), 4000);
  try {
    run.child.stdin.write(JSON.stringify(liveInitialize) + '\n');
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' }) + '\n');
    await Promise.race([hello, run.closed.then(() => assert.fail('entrypoint exited before authentication'))]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(run.stdout(), '', 'initialize and discovery must stay behind authentication');
    const initialized = collectJsonRpcResponse(run.child, 101);
    const discovery = collectJsonRpcResponse(run.child, 102);
    authenticate();
    assert.ok((await initialized)?.result);
    const toolResponse = await discovery;
    assert.deepEqual((toolResponse?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name),
      ['list_bookmarks', 'add_bookmark']);
    run.child.stdin.end();
    const [code, signal] = await run.closed;
    assert.equal(signal, null);
    assert.equal(code, 0, run.stderr());
    await socketClosed;
  } finally {
    clearTimeout(ceiling);
    run.child.kill('SIGKILL');
    await bridge.close();
  }
});

test('malformed live configuration returns an initialize error without creating a mirror', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-no-fallback-'));
  const run = spawnLive('unused', {
    BOOKMARKS_PLUS_BRIDGE_TOKEN: '', BOOKMARKS_PLUS_WORKSPACE: workspace,
  });
  const ceiling = setTimeout(() => run.child.kill('SIGKILL'), 4000);
  try {
    run.child.stdin.write(JSON.stringify(liveInitialize) + '\n');
    const [code, signal] = await run.closed;
    assert.equal(signal, null);
    assert.equal(code, 1);
    const responses = run.stdout().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.data.bookmarksPlusCode, 'bridge-unavailable');
    assert.deepEqual(await fs.readdir(workspace), []);
  } finally {
    clearTimeout(ceiling);
    run.child.kill('SIGKILL');
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('stdin EOF during authentication cancels the bridge immediately and exits normally', async () => {
  let helloResolve!: () => void;
  let closeResolve!: () => void;
  const hello = new Promise<void>((resolve) => { helloResolve = resolve; });
  const socketClosed = new Promise<void>((resolve) => { closeResolve = resolve; });
  const bridge = await fakeBridge((socket) => {
    socket.once('data', () => helloResolve());
    socket.once('close', () => closeResolve());
  });
  const run = spawnLive(bridge.endpoint, {}, 1500);
  const ceiling = setTimeout(() => run.child.kill('SIGKILL'), 4000);
  try {
    run.child.stdin.write(JSON.stringify(liveInitialize) + '\n');
    await Promise.race([hello, run.closed.then(() => assert.fail('entrypoint exited before authentication'))]);
    const start = performance.now();
    run.child.stdin.end();
    const [code, signal] = await run.closed;
    assert.equal(signal, null);
    assert.equal(code, 0, run.stderr());
    assert.ok(performance.now() - start < 750, 'EOF must cancel rather than wait for the handshake deadline');
    await socketClosed;
    assert.equal(run.stdout(), '', 'consumer closure does not emit a startup failure');
  } finally {
    clearTimeout(ceiling);
    run.child.kill('SIGKILL');
    await bridge.close();
  }
});

test('inner transport closure during authentication cancels the socket and exits normally', async () => {
  let helloResolve!: () => void;
  let closeResolve!: () => void;
  const hello = new Promise<void>((resolve) => { helloResolve = resolve; });
  const socketClosed = new Promise<void>((resolve) => { closeResolve = resolve; });
  const bridge = await fakeBridge((socket) => {
    socket.once('data', () => helloResolve());
    socket.once('close', () => closeResolve());
  });
  const stdioUrl = pathToFileURL(path.join(here, '..', '..', 'node_modules',
    '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'stdio.js')).href;
  // Keep the real start/close side effects and control only the moment transport closure happens.
  const beforeStart = `const { StdioServerTransport } = await import(${JSON.stringify(stdioUrl)});` +
    'const start = StdioServerTransport.prototype.start;' +
    'StdioServerTransport.prototype.start = async function() {' +
    'await start.call(this); setTimeout(() => { void this.close(); }, 100); };';
  const run = spawnLive(bridge.endpoint, {}, 1500, beforeStart);
  const ceiling = setTimeout(() => run.child.kill('SIGKILL'), 4000);
  try {
    run.child.stdin.write(JSON.stringify(liveInitialize) + '\n');
    await Promise.race([hello, run.closed.then(() => assert.fail('entrypoint exited before authentication'))]);
    const start = performance.now();
    await socketClosed;
    assert.ok(performance.now() - start < 750,
      'transport closure must cancel the pending socket before its 1500 ms deadline');
    const [code, signal] = await run.closed;
    assert.equal(signal, null);
    assert.equal(code, 0, run.stderr());
    assert.equal(run.stdout(), '', 'transport closure must not produce a startup error');
    assert.equal(run.child.stdout.readableEnded, true);
  } finally {
    clearTimeout(ceiling);
    run.child.kill('SIGKILL');
    await bridge.close();
  }
});

// createServer must never itself read or write the mirror file — tool
// registration only closes over `config`, it does not perform I/O — so an
// arbitrary (non-existent) workspace path is fine here. Real filesystem
// fixtures are unnecessary for this test.
function makeBackend(): BookmarkBackend {
  return {
    mode: 'mirror',
    list: async () => ({ workspacePath: '/workspace', mirrorPath: '/workspace/.vscode/bookmarks.json', collections: [], items: [] }),
    add: async () => ({ id: 'new-id', scope: 'workspace', collection: null }),
    close: async () => {},
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
  const backend = makeBackend();

  const server = createServer(backend);

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
// createServer(backend: BookmarkBackend | undefined, options?: { disabledReason?: string })
// (spec § 4B.8, strategy (a)). Registration itself must never fail on a
// disabled workspace -- the transport still connects, and the refusal is
// deferred to tool-call time inside each handler.
// ---------------------------------------------------------------------------

test('createServer accepts a BookmarkBackend and registers both tools', () => {
  const backend = makeBackend();

  const server = createServer(backend);

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
  const backend = makeBackend();

  const server = createServer(backend);

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
// readPackageVersion fallback (CodeRabbit regression: index.ts's
// readPackageVersion throws -- crashing server startup -- when no
// package.json is found within a 5-directory upward walk, or when the
// package.json it does find fails to parse as JSON. Both cases must instead
// fall back to a placeholder version string: the reported version is
// diagnostic-only metadata, not something worth crashing over.
// ---------------------------------------------------------------------------

test('createServer falls back to a placeholder version instead of throwing when the nearest package.json exists but is malformed JSON', async () => {
  // Isolated copy (the same nested-6-levels-deep technique the "missing
  // package.json" test below uses), for two independent reasons:
  //
  //   1. Writing malformed JSON into the SHARED dist/src/package.json races
  //      every other test FILE's own fresh module resolution of
  //      ../src/*.js -- `node --test` runs each test file as its own
  //      worker process, and a malformed package.json there crashes Node's
  //      OWN module-type resolution (ERR_INVALID_PACKAGE_CONFIG) for
  //      whichever worker hasn't already resolved that directory yet, not
  //      just this test. (Confirmed empirically: an earlier version of this
  //      test that wrote directly to dist/src/package.json intermittently
  //      crashed the unrelated mirrorFile.test.js worker with exactly that
  //      error.)
  //
  //   2. Even inside an isolated copy, the malformed package.json must be
  //      written AFTER this module has already been imported once (while
  //      only a valid ancestor package.json -- mcp-server/package.json --
  //      is in scope). Node's ESM loader itself must read the *nearest*
  //      package.json to decide module type at import() time, and a
  //      malformed one there crashes that resolution before
  //      readPackageVersion's own read ever runs. Importing first, then
  //      mutating the file, exercises readPackageVersion's plain
  //      synchronous fs read (which Node's already-resolved module load
  //      does not repeat) without ever asking Node's own loader to parse
  //      invalid JSON.
  const distSrcDir = path.join(here, '..', 'src');
  const nestedRoot = await fs.mkdtemp(path.join(here, '..', 'version-fallback-malformed-'));
  const nestedSrcDir = path.join(nestedRoot, 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'src');

  try {
    await fs.cp(distSrcDir, nestedSrcDir, { recursive: true });

    const nestedIndexUrl = pathToFileURL(path.join(nestedSrcDir, 'index.js')).href;
    const mod = (await import(nestedIndexUrl)) as { createServer: typeof createServer };

    // Only now, after the module has already loaded successfully, plant a
    // malformed package.json at the module's own directory -- the first
    // place readPackageVersion's upward walk checks.
    await fs.writeFile(path.join(nestedSrcDir, 'package.json'), '{ this is not valid json', 'utf8');

    const backend = makeBackend();
    let server: McpServer | undefined;

    assert.doesNotThrow(() => {
      server = mod.createServer(backend);
    }, 'createServer must not throw when the nearest package.json exists but fails to parse -- reported version is diagnostic-only metadata');

    const info = (server?.server as unknown as ServerWithInfo)._serverInfo;
    assert.equal(
      info?.version,
      '0.0.0-unknown',
      'a malformed nearest package.json must produce the fallback UNKNOWN_VERSION constant, not the real manifest version -- an exact match (not merely non-empty) is required so a future change to the upward-walk depth that lets it fall through to the real package.json is caught here',
    );
  } finally {
    await fs.rm(nestedRoot, { recursive: true, force: true });
  }
});

test('createServer falls back to a placeholder version instead of throwing when no package.json exists within the 5-directory search', async () => {
  // The compiled module and its relative dependencies (config.js,
  // contract.js, mirrorFile.js, tools/*.js) are copied 6 directories deep
  // under mcp-server/dist/ so readPackageVersion's 5-attempt upward walk
  // exhausts before it ever reaches mcp-server/package.json. Nested under
  // mcp-server/dist/ (rather than os.tmpdir()) so bare-specifier imports
  // (@modelcontextprotocol/sdk, zod) still resolve via Node's normal,
  // depth-unlimited node_modules upward walk to mcp-server/node_modules --
  // no symlink or NODE_PATH trick required.
  const distSrcDir = path.join(here, '..', 'src');
  const nestedRoot = await fs.mkdtemp(path.join(here, '..', 'version-fallback-missing-'));
  const nestedSrcDir = path.join(nestedRoot, 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'src');

  try {
    await fs.cp(distSrcDir, nestedSrcDir, { recursive: true });

    const nestedIndexUrl = pathToFileURL(path.join(nestedSrcDir, 'index.js')).href;
    const mod = (await import(nestedIndexUrl)) as { createServer: typeof createServer };

    const backend = makeBackend();
    let server: McpServer | undefined;

    assert.doesNotThrow(() => {
      server = mod.createServer(backend);
    }, 'createServer must not throw when no package.json is found within the 5-directory search -- reported version is diagnostic-only metadata');

    const info = (server?.server as unknown as ServerWithInfo)._serverInfo;
    assert.equal(
      info?.version,
      '0.0.0-unknown',
      'exhausting the 5-directory search must produce the fallback UNKNOWN_VERSION constant, not the real manifest version -- an exact match (not merely non-empty) is required so a future change to the walk depth that lets it fall through to the real package.json is caught here',
    );
  } finally {
    await fs.rm(nestedRoot, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// Entrypoint guard vs. an invalid process.argv[1] (CodeRabbit regression:
// index.ts's top-level "am I the entrypoint" check calls
// realpathSync(process.argv[1]) unguarded. When process.argv[1] points to a
// path that does not exist -- as it can under some `node --eval` / stdin
// invocation styles -- realpathSync throws ENOENT synchronously during
// module evaluation, crashing the import itself instead of simply
// concluding "this is not the entrypoint" and skipping main().
//
// Note: the sibling case named in the same CodeRabbit comment --
// process.argv[1] being `undefined` -- is already handled correctly by the
// current source (index.ts's guard reads `process.argv[1] !== undefined &&
// ...`, which short-circuits before ever calling realpathSync). That half
// requires no regression test here; only the ENOENT half below is still
// broken.
//
// Same constraint as the symlinked-entrypoint test above: the guard is
// top-level module code with no extracted, directly-callable function, so
// the only way to exercise the real check is to actually import the
// compiled module as a fresh process with a controlled process.argv[1].
// ---------------------------------------------------------------------------

test('importing the module does not throw when process.argv[1] points to a path that does not exist', async () => {
  const distEntrypointUrl = pathToFileURL(path.join(here, '..', 'src', 'index.js')).href;
  const nonexistentPath = path.join(
    os.tmpdir(),
    `bookmarks-plus-mcp-does-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  // A plain `node -e` script that sets argv[1] to a nonexistent path before
  // dynamically importing the compiled entrypoint, then reports whether the
  // import resolved or rejected. This must resolve (IMPORT_OK) rather than
  // reject -- the module must not crash on import just because it happens
  // to be unable to confirm it *isn't* the entrypoint.
  const script = [
    `process.argv[1] = ${JSON.stringify(nonexistentPath)};`,
    `import(${JSON.stringify(distEntrypointUrl)})`,
    "  .then(() => { console.log('IMPORT_OK'); process.exit(0); })",
    "  .catch((err) => { console.error('IMPORT_FAILED: ' + (err && err.stack ? err.stack : err)); process.exit(1); });",
  ].join('\n');

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      // Mirrors the symlinked-entrypoint test's 5s ceiling: if the fix
      // regresses into actually starting the server (main() called, stdio
      // transport connected and waiting on stdin), the process would hang
      // rather than exit -- this bounds that failure mode to a timeout
      // instead of wedging the suite.
      const timeout = setTimeout(() => {
        child?.kill('SIGKILL');
        resolve(null);
      }, 5000);
      child?.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(
      exitCode,
      0,
      `expected importing the module with a nonexistent process.argv[1] to succeed without starting the server (exit 0), got exit ${String(exitCode)}. stdout: ${stdout} stderr: ${stderr}`,
    );
    assert.ok(
      stdout.includes('IMPORT_OK'),
      `expected the dynamic import() to resolve, not reject or hang. stdout: ${stdout} stderr: ${stderr}`,
    );
  } finally {
    child?.kill('SIGKILL');
  }
});
