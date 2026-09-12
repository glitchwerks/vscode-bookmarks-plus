export type BookmarkScope = 'workspace' | 'global';

export interface BookmarksPlusApiVersion {
  readonly major: 1;
  readonly minor: number;
}

export type McpTransport = 'stdio';

export interface McpConnectionCapabilities {
  readonly descriptorVersions: readonly number[];
  readonly transports: readonly McpTransport[];
  readonly scopes: readonly BookmarkScope[];
  readonly rootSelection: 'explicit-workspace-folder';
  readonly sessionLifecycle: 'pinned-root';
}

export interface BookmarksPlusCapabilities {
  readonly mcpConnection: McpConnectionCapabilities;
}

export interface BookmarksPlusApiV1 {
  readonly apiVersion: BookmarksPlusApiVersion;
  readonly capabilities: BookmarksPlusCapabilities;
  requestMcpConnection(request: McpConnectionRequest): Promise<McpConnectionResult>;
}

export interface McpConnectionRequest {
  readonly workspaceFolderUri: string;
  readonly scopes: readonly BookmarkScope[];
  readonly supportedDescriptorVersions: readonly number[];
}

export interface McpStdioDescriptorV1 {
  readonly version: 1;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly sensitiveEnvKeys: readonly string[];
  readonly workspaceFolderUri: string;
  readonly grantedScopes: readonly BookmarkScope[];
  readonly bootstrapExpiresAt: string;
}

export type McpConnectionDescriptor = McpStdioDescriptorV1;

export interface McpConnectionSuccess {
  readonly kind: 'success';
  readonly descriptor: McpConnectionDescriptor;
}

export type McpConnectionErrorCode =
  | 'invalid-request'
  | 'unsupported-descriptor-version'
  | 'workspace-folder-not-found'
  | 'workspace-folder-unavailable'
  | 'unsupported-scope'
  | 'stale-request'
  | 'temporarily-unavailable'
  | 'shutting-down';

export interface McpConnectionFailure {
  readonly kind: 'error';
  readonly error: {
    readonly code: McpConnectionErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type McpConnectionResult = McpConnectionSuccess | McpConnectionFailure;
