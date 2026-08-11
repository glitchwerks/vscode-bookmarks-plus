#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveWorkspaceState, type Config, type WorkspaceState } from './config.js';
import { readMirror, writeMirrorAtomic } from './mirrorFile.js';
import { createAddHandler } from './tools/add.js';
import { createListHandler } from './tools/list.js';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function readPackageVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 5; depth += 1) {
    const packageJsonPath = path.join(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        version: string;
      };
      return packageJson.version;
    }
    directory = path.dirname(directory);
  }

  throw new Error('Unable to locate mcp-server/package.json.');
}

export function createServer(
  config: Config | undefined,
  options?: { disabledReason?: string },
): McpServer {
  const server = new McpServer({
    name: 'bookmarks-plus-mcp',
    version: readPackageVersion(),
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
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void main();
}
