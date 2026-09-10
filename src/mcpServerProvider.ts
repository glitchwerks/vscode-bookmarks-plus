import * as vscode from 'vscode';
import type { OutputSink } from './bookmarkStore';
import type { IssuedLiveBridgeGrant } from './liveMcpBridgeService';
import { canonicalizeRootUri } from './rootUri';
import type { BookmarkScope } from './types';

export const MCP_SERVER_PROVIDER_ID = 'bookmarks-plus.mcp';

export type BookmarksMcpProvider = vscode.McpServerDefinitionProvider<
  vscode.McpStdioServerDefinition
>;

interface McpProviderDependencies {
  getAttachedRoots: () => readonly { uri: vscode.Uri; name?: string }[] | undefined;
  extensionUri: vscode.Uri;
  extensionVersion: string;
  output: OutputSink;
  registerProvider: (
    id: string,
    provider: vscode.McpServerDefinitionProvider
  ) => vscode.Disposable;
  onDidChangePartitions: (listener: () => void) => vscode.Disposable;
  isBridgeReady?: () => boolean;
  issueGrant?: (
    rootUri: string,
    scopes: readonly BookmarkScope[]
  ) => IssuedLiveBridgeGrant;
}

const LIVE_MODE_ENV = 'BOOKMARKS_PLUS_LIVE_MODE';
const ROOT_URI_ENV = 'BOOKMARKS_PLUS_ROOT_URI';
const LIVE_GRANT_SCOPES: readonly BookmarkScope[] = ['workspace', 'global'];

/** Returns the selected root only when the retained definition still names an attached root. */
function resolveAttachedRoot(
  definition: vscode.McpStdioServerDefinition,
  getAttachedRoots: McpProviderDependencies['getAttachedRoots']
): string | undefined {
  const rootUri = definition.env[ROOT_URI_ENV];
  if (typeof rootUri !== 'string') {
    return undefined;
  }

  let canonicalRootUri: string;
  try {
    canonicalRootUri = canonicalizeRootUri(vscode.Uri.parse(rootUri, true));
  } catch {
    return undefined;
  }

  return getAttachedRoots()?.some(folder => {
    try {
      return canonicalizeRootUri(folder.uri) === canonicalRootUri;
    } catch {
      return false;
    }
  }) ? canonicalRootUri : undefined;
}

export function buildMcpServerDefinitions(
  folders: readonly { uri: vscode.Uri; name?: string }[] | undefined,
  extensionUri: vscode.Uri,
  extensionVersion: string,
  output: OutputSink
): vscode.McpStdioServerDefinition[] {
  if (!folders || folders.length === 0) {
    output.appendLine(
      'Bookmarks Plus: native MCP server is unavailable — no attached workspace roots are available.'
    );
    return [];
  }

  const serverPath = vscode.Uri.joinPath(
    extensionUri,
    'dist',
    'bookmarks-plus-mcp.mjs'
  ).fsPath;

  const labels = folders.map(folder => folder.name ?? folder.uri.path.split('/').at(-1) ?? '');
  return folders.map((folder, index) =>
    new vscode.McpStdioServerDefinition(
      folders.length === 1 ? 'Bookmarks Plus' : `Bookmarks Plus (${labels[index]}${labels.filter(label => label === labels[index]).length > 1 ? ` — ${canonicalizeRootUri(folder.uri)}` : ''})`,
      process.execPath,
      [serverPath, folder.uri.fsPath],
      {
        ELECTRON_RUN_AS_NODE: '1',
        [LIVE_MODE_ENV]: '1',
        [ROOT_URI_ENV]: canonicalizeRootUri(folder.uri)
      },
      extensionVersion
    )
  );
}

export function registerBookmarksMcpProvider(
  subscriptions: vscode.Disposable[],
  deps: McpProviderDependencies
): BookmarksMcpProvider | undefined {
  const changeEmitter = new vscode.EventEmitter<void>();
  const resources: vscode.Disposable[] = [changeEmitter];
  const provider: BookmarksMcpProvider = {
    onDidChangeMcpServerDefinitions: changeEmitter.event,
    provideMcpServerDefinitions: () =>
      buildMcpServerDefinitions(
        deps.getAttachedRoots(),
        deps.extensionUri,
        deps.extensionVersion,
        deps.output
      ),
    resolveMcpServerDefinition: (definition, token) => {
      const rootUri = resolveAttachedRoot(definition, deps.getAttachedRoots);
      if (!rootUri || !deps.isBridgeReady?.() || !deps.issueGrant) {
        return undefined;
      }

      let grant: IssuedLiveBridgeGrant | undefined;
      try {
        grant = deps.issueGrant(rootUri, LIVE_GRANT_SCOPES);
        const resolved = new vscode.McpStdioServerDefinition(
          definition.label,
          definition.command,
          [...definition.args],
          {
            ...definition.env,
            BOOKMARKS_PLUS_BRIDGE_ENDPOINT: grant.endpoint,
            BOOKMARKS_PLUS_BRIDGE_PROTOCOL: String(grant.protocolVersion),
            BOOKMARKS_PLUS_BRIDGE_GENERATION: grant.generation,
            BOOKMARKS_PLUS_BRIDGE_TOKEN: grant.token
          },
          definition.version
        );
        resolved.cwd = definition.cwd;
        if (token.isCancellationRequested) {
          grant.revoke();
          return undefined;
        }
        return resolved;
      } catch {
        grant?.revoke();
        return undefined;
      }
    }
  };

  try {
    resources.push(deps.registerProvider(MCP_SERVER_PROVIDER_ID, provider));
    resources.push(deps.onDidChangePartitions(() => changeEmitter.fire()));
    subscriptions.push(...resources);
    return provider;
  } catch (error: unknown) {
    for (const resource of resources.reverse()) {
      try {
        resource.dispose();
      } catch {
        // Preserve the registration failure as the actionable diagnostic.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.output.appendLine(
      `Bookmarks Plus: native MCP provider registration failed — ${message}`
    );
    return undefined;
  }
}
