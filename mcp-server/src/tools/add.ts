import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { BackendError, type AddBookmarkInput, type BookmarkBackend } from '../backend.js';

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Creates the MCP add tool over the configured bookmark backend. */
export function createAddHandler(
  backend: BookmarkBackend | undefined,
  options: { disabledReason?: string } = {},
) {
  return {
    name: 'add_bookmark' as const,
    description: 'Adds a file or folder bookmark to this workspace.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const,
    inputSchema: {
      uri: z.string(),
      type: z.enum(['file', 'folder']),
      scope: z.enum(['workspace', 'global']).optional(),
      collectionId: z.string().optional(),
      collectionName: z.string().optional(),
      description: z.string().optional(),
    },
    handler: async (args: AddBookmarkInput): Promise<CallToolResult> => {
      if (backend === undefined) {
        return toolError(options.disabledReason ?? 'The Bookmarks Plus mirror is unavailable in this VS Code window.');
      }
      try {
        const payload = await backend.add(args);
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload as unknown as Record<string, unknown> };
      } catch (error: unknown) {
        return toolError(error instanceof BackendError ? error.message : 'The bookmarks backend failed to add a bookmark.');
      }
    },
  };
}
