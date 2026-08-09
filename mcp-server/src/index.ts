#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveConfig, type Config } from './config.js';
import { readMirror, writeMirrorAtomic } from './mirrorFile.js';
import { createAddHandler } from './tools/add.js';
import { createListHandler } from './tools/list.js';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: 'bookmarks-plus-mcp',
    version: '0.0.0',
  });

  const listTool = createListHandler(config, { readMirror });
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
  let config: Config;
  try {
    config = resolveConfig(process.argv, process.env);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
