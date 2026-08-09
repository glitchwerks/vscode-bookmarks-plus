import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../config.js';
import { parseMirror } from '../contract.js';
import { readMirror } from '../mirrorFile.js';

export function createListHandler(
  config: Config,
  deps: { readMirror: typeof readMirror },
) {
  return {
    name: 'list_bookmarks' as const,
    description:
      "Lists the user's bookmarked files, folders, and collections to surface their areas of interest in this workspace.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    } as const,
    inputSchema: {},
    handler: async (_args: unknown): Promise<CallToolResult> => {
      const raw = await deps.readMirror(config.mirrorPath);
      const result = parseMirror(raw);

      if (result.kind === 'error') {
        return {
          isError: true,
          content: [{ type: 'text', text: result.message }],
        };
      }

      const payload: Record<string, unknown> = {
        workspacePath: config.workspacePath,
        mirrorPath: config.mirrorPath,
        collections:
          result.kind === 'ok'
            ? result.data.collections.map((collection) => ({
                id: collection.id,
                name: collection.name,
                order: collection.order,
                description: collection.description,
              }))
            : [],
        items:
          result.kind === 'ok'
            ? result.data.items.map((item) => ({
                id: item.id,
                type: item.type,
                uri: item.uri,
                collectionId: item.collectionId,
                order: item.order,
                description: item.description,
              }))
            : [],
      };

      if (result.kind === 'ok') {
        payload.version = result.data.version;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}
