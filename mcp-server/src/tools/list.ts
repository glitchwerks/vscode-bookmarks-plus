import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { BackendError, type BookmarkBackend } from '../backend.js';

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Creates the MCP list tool over the configured bookmark backend. */
export function createListHandler(
  backend: BookmarkBackend | undefined,
  options: { disabledReason?: string } = {},
) {
  return {
    name: 'list_bookmarks' as const,
    description: "Lists the user's bookmarked files, folders, and collections to surface their areas of interest in this workspace.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    inputSchema: {},
    handler: async (_args: unknown): Promise<CallToolResult> => {
      if (backend === undefined) {
        return toolError(options.disabledReason ?? 'The Bookmarks Plus mirror is unavailable in this VS Code window.');
      }
      try {
        const payload = await backend.list();
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload as unknown as Record<string, unknown> };
      } catch (error: unknown) {
        return toolError(error instanceof BackendError ? error.message : 'The bookmarks backend failed to list bookmarks.');
      }
    },
  };
}
