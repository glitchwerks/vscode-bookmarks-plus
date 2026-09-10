#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { type BookmarkBackend } from './backend.js';
import { MirrorBookmarkBackend } from './mirrorBackend.js';
import { InitializationGate } from './initializationGate.js';
import { LiveBookmarkBackend, LiveBridgeStartupError, LiveMcpBridgeClient } from './liveBridgeClient.js';
import { resolveRuntimeMode, type RuntimeMode } from './runtimeMode.js';
import { createAddHandler } from './tools/add.js';
import { createListHandler } from './tools/list.js';

declare const __BOOKMARKS_PLUS_MCP_VERSION__: string | undefined;

const UNKNOWN_VERSION = '0.0.0-unknown';

function readPackageVersion(): string {
  if (typeof __BOOKMARKS_PLUS_MCP_VERSION__ === 'string') {
    return __BOOKMARKS_PLUS_MCP_VERSION__;
  }

  let directory = path.dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 5; depth += 1) {
    const packageJsonPath = path.join(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
          version: string;
        };
        return packageJson.version;
      } catch {
        return UNKNOWN_VERSION;
      }
    }
    directory = path.dirname(directory);
  }

  return UNKNOWN_VERSION;
}

export function createServer(
  backend: BookmarkBackend | undefined,
  options?: { disabledReason?: string },
): McpServer {
  const server = new McpServer({
    name: 'bookmarks-plus-mcp',
    version: readPackageVersion(),
  });

  const listTool = createListHandler(backend, { disabledReason: options?.disabledReason });
  server.registerTool(
    listTool.name,
    {
      description: listTool.description,
      annotations: listTool.annotations,
      inputSchema: listTool.inputSchema,
    },
    listTool.handler,
  );

  const addTool = createAddHandler(backend, { disabledReason: options?.disabledReason });
  server.registerTool(
    addTool.name,
    {
      description: addTool.description,
      annotations: addTool.annotations,
      inputSchema: addTool.inputSchema,
    },
    addTool.handler,
  );

  return server;
}

/** Starts the selected runtime; the deadline override is an internal test dependency only. */
export async function runServer(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: { handshakeTimeoutMs?: number } = {},
): Promise<void> {
  let mode: RuntimeMode | undefined;
  let configurationError: LiveBridgeStartupError | undefined;
  try {
    mode = resolveRuntimeMode(argv, env);
  } catch (error: unknown) {
    if (error instanceof LiveBridgeStartupError) {
      configurationError = error;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  if (mode && mode.kind !== 'live') {
    const server = mode.kind === 'mirror'
      ? createServer(new MirrorBookmarkBackend(mode.config))
      : createServer(undefined, { disabledReason: mode.reason });
    await server.connect(new StdioServerTransport());
    return;
  }

  const gate = new InitializationGate(new StdioServerTransport());
  const authentication = new AbortController();
  let client: LiveMcpBridgeClient | undefined;
  let backend: LiveBookmarkBackend | undefined;
  let closed = false;
  let cleanup: Promise<void> | undefined;

  /** Releases live resources and the process-owned stdio after the final write. */
  const releaseResources = (): Promise<void> => {
    if (cleanup) { return cleanup; }
    closed = true;
    authentication.abort();
    cleanup = Promise.resolve().then(async () => {
      process.stdin.off('end', onInputEnd);
      process.stdin.off('close', onInputEnd);
      try {
        if (backend) { await backend.close(); }
        else { await client?.close(); }
      } finally {
        process.stdin.destroy();
        await new Promise<void>((resolve) => process.stdout.end(resolve));
      }
    });
    return cleanup;
  };
  const onInputEnd = (): void => {
    void gate.close().then(releaseResources).catch(() => { process.exitCode = 1; });
  };
  gate.onclose = () => { void releaseResources().catch(() => { process.exitCode = 1; }); };
  process.stdin.once('end', onInputEnd);
  process.stdin.once('close', onInputEnd);

  try {
    await gate.start();
    if (configurationError) { throw configurationError; }
    if (!mode || mode.kind !== 'live') { throw new Error('Missing live runtime.'); }
    client = await LiveMcpBridgeClient.connect(mode.config, {
      handshakeTimeoutMs: dependencies.handshakeTimeoutMs, signal: authentication.signal,
    });
    // EOF can arrive during authentication; never create or expose a server after closure.
    if (closed) { await client.close(); return; }
    backend = new LiveBookmarkBackend(client);
    const server = createServer(backend);
    await server.connect(gate);
    gate.open();
  } catch (error: unknown) {
    if (closed) {
      await gate.close();
      await releaseResources();
      return;
    }
    process.exitCode = 1;
    const code = error instanceof LiveBridgeStartupError ? error.code : 'bridge-unavailable';
    try {
      // Producer exceptions and transport diagnostics may contain private bootstrap details.
      await gate.fail(code, 'The live bridge is unavailable.');
    } catch {
      // A broken output stream cannot receive a second response; cleanup still owns shutdown.
    } finally {
      await releaseResources();
    }
  }
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void runServer(process.argv, process.env);
}
