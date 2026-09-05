import * as vscode from 'vscode';
import type { OutputSink } from './bookmarkStore';

export const MCP_SERVER_PROVIDER_ID = 'bookmarks-plus.mcp';

interface McpProviderDependencies {
  getWorkspaceFolders: () => readonly { uri: vscode.Uri }[] | undefined;
  extensionUri: vscode.Uri;
  extensionVersion: string;
  output: OutputSink;
  registerProvider: (
    id: string,
    provider: vscode.McpServerDefinitionProvider
  ) => vscode.Disposable;
  onDidChangeWorkspaceFolders: (listener: () => void) => vscode.Disposable;
}

export function buildMcpServerDefinitions(
  folders: readonly { uri: vscode.Uri }[] | undefined,
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

  if (folders.length > 1) {
    output.appendLine(
      'Bookmarks Plus: native MCP server is unavailable — multiple workspace folders are open.'
    );
    return [];
  }

  const serverPath = vscode.Uri.joinPath(
    extensionUri,
    'dist',
    'bookmarks-plus-mcp.mjs'
  ).fsPath;

  return [
    new vscode.McpStdioServerDefinition(
      'Bookmarks Plus',
      process.execPath,
      [serverPath, folders[0].uri.fsPath],
      { ELECTRON_RUN_AS_NODE: '1' },
      extensionVersion
    )
  ];
}

export function registerBookmarksMcpProvider(
  subscriptions: vscode.Disposable[],
  deps: McpProviderDependencies
): void {
  const changeEmitter = new vscode.EventEmitter<void>();
  const resources: vscode.Disposable[] = [changeEmitter];
  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changeEmitter.event,
    provideMcpServerDefinitions: () =>
      buildMcpServerDefinitions(
        deps.getWorkspaceFolders(),
        deps.extensionUri,
        deps.extensionVersion,
        deps.output
      )
  };

  try {
    resources.push(deps.registerProvider(MCP_SERVER_PROVIDER_ID, provider));
    resources.push(deps.onDidChangeWorkspaceFolders(() => changeEmitter.fire()));
    subscriptions.push(...resources);
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
  }
}
