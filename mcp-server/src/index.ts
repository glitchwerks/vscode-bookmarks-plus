#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveWorkspaceState, type Config, type WorkspaceState } from './config.js';
import { readMirror, writeMirrorAtomic } from './mirrorFile.js';
import { createAddHandler } from './tools/add.js';
import { createListHandler } from './tools/list.js';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createServer(
  config: Config | undefined,
  options?: { disabledReason?: string },
): McpServer {
  const server = new McpServer({
    name: 'bookmarks-plus-mcp',
    version: '0.0.0',
  });

  const listTool = createListHandler(config, {
    readMirror,
    disabledReason: options?.disabledReason,
  });
  server.registerTool(
    listTool.name,
    {
      description: listTool.description,
      annotations: listTool.annotations,
      inputSchema: listTool.inputSchema,
    },
    listTool.handler,
  );

  const addTool = createAddHandler(config, {
    readMirror,
    writeMirrorAtomic,
    sleep,
    uuid: randomUUID,
    disabledReason: options?.disabledReason,
  });
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

async function main(): Promise<void> {
  let state: WorkspaceState;

  // TEMPORARY — Phase 0 probe, issue #57. Remove before PR is marked ready.
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), 'bookmarks-plus-mcp-probe.json'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
        BOOKMARKS_PLUS_WORKSPACE: process.env.BOOKMARKS_PLUS_WORKSPACE ?? null,
        cwd: process.cwd(),
      })}\n`,
    );
  } catch {
    // Ignore probe failures so server startup remains unaffected.
  }

  try {
    state = resolveWorkspaceState(process.argv, process.env);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const server =
    state.kind === 'ok'
      ? createServer(state.config)
      : createServer(undefined, { disabledReason: state.reason });
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
