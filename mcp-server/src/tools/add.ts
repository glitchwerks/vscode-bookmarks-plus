import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Config } from '../config.js';
import {
  parseMirror,
  serialize,
  toCanonicalV2,
  type BookmarkCollection,
  type BookmarkData,
  type BookmarkItem,
} from '../contract.js';
import { readMirror, writeMirrorAtomic } from '../mirrorFile.js';

interface AddBookmarkArgs {
  uri: string;
  type: 'file' | 'folder';
  collectionId?: string;
  collectionName?: string;
  description?: string;
}

interface AddAttemptResult {
  item: BookmarkItem;
  collection: BookmarkCollection | null;
  survived: boolean;
}

interface ToolErrorResult extends CallToolResult {
  isError: true;
}

type AddAttemptOutcome = AddAttemptResult | ToolErrorResult;

function toolError(message: string): ToolErrorResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function validCollectionsMessage(collections: BookmarkCollection[]): string {
  if (collections.length === 0) {
    return 'There are no valid collections in the mirror file.';
  }

  return `Valid collections: ${collections
    .map((collection) => `${collection.id} (${collection.name})`)
    .join(', ')}.`;
}

function resolveCollection(
  args: AddBookmarkArgs,
  collections: BookmarkCollection[],
): BookmarkCollection | null | ToolErrorResult {
  if (args.collectionId !== undefined) {
    const collection = collections.find((candidate) => candidate.id === args.collectionId);
    if (collection === undefined) {
      return toolError(
        `Unknown collectionId "${args.collectionId}". ${validCollectionsMessage(collections)}`,
      );
    }
    return collection;
  }

  if (args.collectionName !== undefined) {
    const collection = collections.find((candidate) => candidate.name === args.collectionName);
    if (collection === undefined) {
      return toolError(
        `Unknown collectionName "${args.collectionName}". ${validCollectionsMessage(collections)}`,
      );
    }
    return collection;
  }

  return null;
}

function isToolError(value: object): value is ToolErrorResult {
  return 'isError' in value && value.isError === true;
}

export function createAddHandler(
  config: Config,
  deps: {
    readMirror: typeof readMirror;
    writeMirrorAtomic: typeof writeMirrorAtomic;
    sleep: (ms: number) => Promise<void>;
    uuid: () => string;
  },
) {
  const addOnce = async (args: AddBookmarkArgs): Promise<AddAttemptOutcome> => {
    const raw = await deps.readMirror(config.mirrorPath);
    const parsed = parseMirror(raw);

    if (parsed.kind === 'error') {
      return toolError(parsed.message);
    }

    const data: BookmarkData =
      parsed.kind === 'empty'
        ? { version: 2, items: [], collections: [] }
        : parsed.data;
    const collection = resolveCollection(args, data.collections);

    if (collection !== null && isToolError(collection)) {
      return collection;
    }

    const collectionId = collection?.id ?? null;
    const duplicate = data.items.some(
      (item) => item.uri === args.uri && item.collectionId === collectionId,
    );
    if (duplicate) {
      return toolError(
        `A bookmark for "${args.uri}" already exists in the resolved collection.`,
      );
    }

    const description = args.description?.trim();
    const item: BookmarkItem = {
      id: deps.uuid(),
      type: args.type,
      uri: args.uri,
      collectionId,
      order: data.items.filter((candidate) => candidate.collectionId === collectionId).length,
      ...(description === undefined || description.length === 0 ? {} : { description }),
    };

    data.items.push(item);
    const serialized = serialize(toCanonicalV2(data));
    await deps.writeMirrorAtomic(config.mirrorPath, serialized);

    if (config.verifyDelayMs === 0) {
      return { item, collection, survived: true };
    }

    await deps.sleep(config.verifyDelayMs);
    const verification = parseMirror(await deps.readMirror(config.mirrorPath));
    const survived =
      verification.kind === 'ok' &&
      verification.data.items.some((candidate) => candidate.id === item.id);

    return { item, collection, survived };
  };

  return {
    name: 'add_bookmark' as const,
    description: 'Adds a file or folder bookmark to this workspace.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    } as const,
    inputSchema: {
      uri: z.string(),
      type: z.enum(['file', 'folder']),
      collectionId: z.string().optional(),
      collectionName: z.string().optional(),
      description: z.string().optional(),
    },
    handler: async (args: AddBookmarkArgs): Promise<CallToolResult> => {
      const firstAttempt = await addOnce(args);
      if (isToolError(firstAttempt)) {
        return firstAttempt;
      }

      let successfulAttempt = firstAttempt;
      if (!firstAttempt.survived) {
        const secondAttempt = await addOnce(args);
        if (isToolError(secondAttempt)) {
          return secondAttempt;
        }
        successfulAttempt = secondAttempt;
      }

      if (!successfulAttempt.survived) {
        return toolError(
          'the bookmark was written but did not survive — VS Code is probably running and overwrote the file. Retry, or add it from the Bookmarks view.',
        );
      }

      const payload: Record<string, unknown> = {
        id: successfulAttempt.item.id,
        mirrorPath: config.mirrorPath,
        collection: successfulAttempt.collection,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}
