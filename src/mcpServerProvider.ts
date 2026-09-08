import * as vscode from 'vscode';
import type { OutputSink } from './bookmarkStore';
import { canonicalizeRootUri } from './rootUri';

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
}

export function buildMcpServerDefinitions(
  folders: readonly { uri: vscode.Uri; name?: string }[] | undefined,
  extensionUri: vscode.Uri,
  extensionVersion: string,
  output: OutputSink
): vscode.McpStdioServerDefinition[] {
  if (!folders || folders.length === 0) {
    output.appendLine(
      'Bookmarks Plus: native MCP server is unavailable — no workspace folder is open.'
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
      { ELECTRON_RUN_AS_NODE: '1' },
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
      )
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
