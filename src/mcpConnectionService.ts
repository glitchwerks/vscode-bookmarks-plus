import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  BookmarkScope,
  BookmarksPlusApiV1,
  McpConnectionErrorCode,
  McpConnectionFailure,
  McpConnectionRequest,
  McpConnectionResult
} from './bookmarksPlusApi';
import {
  IssuedLiveBridgeGrant,
  LiveMcpBridgeGrantError
} from './liveMcpBridgeService';
import { canonicalizeRootUri } from './rootUri';

/** The private bridge capability needed to issue one external connection descriptor. */
export interface McpBridgeGrantIssuer {
  readonly activationGeneration: string;
  issueGrant(rootUri: string, scopes: readonly BookmarkScope[]): IssuedLiveBridgeGrant;
}

/** Runtime dependencies kept behind the private API request adapter. */
export interface McpConnectionServiceDependencies {
  readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  readonly getAttachedRoot: (canonicalRootUri: string) =>
    | { readonly canonicalRootUri: string; readonly partitionId: string }
    | undefined;
  readonly getBridge: () => McpBridgeGrantIssuer | undefined;
  readonly isShuttingDown: () => boolean;
  readonly extensionUri: vscode.Uri;
  readonly executablePath: string;
  readonly isFile?: (filePath: string) => Promise<boolean>;
}

interface ValidatedRequest {
  readonly canonicalRootUri: string;
  readonly scopes: readonly BookmarkScope[];
  readonly descriptorVersion: number;
}

type ValidationResult = ValidatedRequest | McpConnectionFailure;

const RETRYABLE_CODES = new Set<McpConnectionErrorCode>([
  'workspace-folder-unavailable',
  'stale-request',
  'temporarily-unavailable',
  'shutting-down'
]);

/** Returns the greatest descriptor version advertised by both participants. */
export function selectHighestMutualDescriptorVersion(
  requested: readonly number[],
  supported: readonly number[] = [1]
): number | undefined {
  const supportedSet = new Set(supported);
  return [...requested].filter(version => supportedSet.has(version)).sort((a, b) => b - a)[0];
}

/** Creates an immutable expected failure with contract-defined retryability. */
function failure(code: McpConnectionErrorCode, message: string): McpConnectionFailure {
  return Object.freeze({
    kind: 'error' as const,
    error: Object.freeze({ code, message, retryable: RETRYABLE_CODES.has(code) })
  });
}

/** Validates untrusted cross-extension request data without rejecting additive fields. */
function validateRequest(request: unknown): ValidationResult {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return failure('invalid-request', 'The MCP connection request must be an object.');
  }

  const value = request as Record<string, unknown>;
  if (typeof value.workspaceFolderUri !== 'string') {
    return failure('invalid-request', 'The workspace folder URI must be a string.');
  }

  let canonicalRootUri: string;
  try {
    canonicalRootUri = canonicalizeRootUri(vscode.Uri.parse(value.workspaceFolderUri, true));
  } catch {
    return failure('invalid-request', 'The workspace folder URI must identify an absolute root.');
  }

  if (!Array.isArray(value.scopes) || value.scopes.length === 0
    || new Set(value.scopes).size !== value.scopes.length
    || value.scopes.some(scope => typeof scope !== 'string')) {
    return failure('invalid-request', 'Scopes must be a non-empty list of unique strings.');
  }
  if (value.scopes.some(scope => scope !== 'workspace' && scope !== 'global')) {
    return failure('unsupported-scope', 'One or more requested scopes are not supported.');
  }

  const versions = value.supportedDescriptorVersions;
  if (!Array.isArray(versions) || versions.length === 0
    || new Set(versions).size !== versions.length
    || versions.some(version => typeof version !== 'number'
      || !Number.isInteger(version) || version <= 0)) {
    return failure(
      'invalid-request',
      'Descriptor versions must be a non-empty list of unique positive integers.'
    );
  }

  const descriptorVersion = selectHighestMutualDescriptorVersion(versions);
  if (descriptorVersion === undefined) {
    return failure('unsupported-descriptor-version', 'No requested descriptor version is supported.');
  }

  const requestedScopes = value.scopes as BookmarkScope[];
  const scopes = Object.freeze(
    (['workspace', 'global'] as const).filter(scope => requestedScopes.includes(scope))
  );
  return { canonicalRootUri, scopes, descriptorVersion };
}

/** Finds one current folder by canonical URI identity while ignoring invalid folder entries. */
function findWorkspaceFolder(
  folders: readonly vscode.WorkspaceFolder[] | undefined,
  canonicalRootUri: string
): vscode.WorkspaceFolder | undefined {
  return folders?.find(folder => {
    try {
      return canonicalizeRootUri(folder.uri) === canonicalRootUri;
    } catch {
      return false;
    }
  });
}

/** Returns whether the exact selected folder, partition, bridge, and activation remain current. */
function isCurrentState(
  deps: McpConnectionServiceDependencies,
  selectedFolder: vscode.WorkspaceFolder,
  canonicalRootUri: string,
  partitionId: string,
  bridge: McpBridgeGrantIssuer,
  activationGeneration: string
): boolean {
  const attachment = deps.getAttachedRoot(canonicalRootUri);
  return findWorkspaceFolder(deps.getWorkspaceFolders(), canonicalRootUri) === selectedFolder
    && attachment?.canonicalRootUri === canonicalRootUri
    && attachment.partitionId === partitionId
    && deps.getBridge() === bridge
    && bridge.activationGeneration === activationGeneration;
}

/** Checks that the bundled MCP entry point is a regular file. */
async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** Maps the bridge's typed issuance outcomes to the public failure contract. */
function mapGrantError(error: LiveMcpBridgeGrantError): McpConnectionFailure {
  return error.code === 'workspace-folder-unavailable'
    ? failure('stale-request', 'The workspace attachment changed while issuing the request.')
    : failure('temporarily-unavailable', 'The live MCP bridge cannot issue a connection now.');
}

/** Issues a grant only while the selected runtime state remains stable across async work. */
async function requestMcpConnection(
  deps: McpConnectionServiceDependencies,
  request: unknown
): Promise<McpConnectionResult> {
  if (deps.isShuttingDown()) {
    return failure('shutting-down', 'Bookmarks Plus is shutting down.');
  }

  const validated = validateRequest(request);
  if ('kind' in validated) {
    return validated;
  }

  const { canonicalRootUri, scopes } = validated;
  const selectedFolder = findWorkspaceFolder(deps.getWorkspaceFolders(), canonicalRootUri);
  if (!selectedFolder) {
    return failure('workspace-folder-not-found', 'The requested workspace folder is not open.');
  }

  const attachment = deps.getAttachedRoot(canonicalRootUri);
  if (!attachment || attachment.canonicalRootUri !== canonicalRootUri) {
    return failure('workspace-folder-unavailable', 'The requested workspace folder is not ready.');
  }

  const bridge = deps.getBridge();
  if (!bridge) {
    return failure('temporarily-unavailable', 'The live MCP bridge is not available.');
  }
  const activationGeneration = bridge.activationGeneration;
  const partitionId = attachment.partitionId;
  const serverPath = vscode.Uri.joinPath(
    deps.extensionUri,
    'dist',
    'bookmarks-plus-mcp.mjs'
  ).fsPath;
  const bundlePresent = await (deps.isFile ?? isRegularFile)(serverPath);

  if (deps.isShuttingDown()) {
    return failure('shutting-down', 'Bookmarks Plus is shutting down.');
  }
  if (!isCurrentState(
    deps,
    selectedFolder,
    canonicalRootUri,
    partitionId,
    bridge,
    activationGeneration
  )) {
    return failure('stale-request', 'Workspace or bridge state changed while handling the request.');
  }
  if (!bundlePresent) {
    return failure('temporarily-unavailable', 'The bundled MCP server is not available.');
  }

  let grant: IssuedLiveBridgeGrant;
  try {
    grant = bridge.issueGrant(canonicalRootUri, scopes);
  } catch (error) {
    if (error instanceof LiveMcpBridgeGrantError) {
      return mapGrantError(error);
    }
    throw error;
  }

  try {
    if (deps.isShuttingDown()) {
      grant.revoke();
      return failure('shutting-down', 'Bookmarks Plus is shutting down.');
    }
    if (!isCurrentState(
      deps,
      selectedFolder,
      canonicalRootUri,
      partitionId,
      bridge,
      activationGeneration
    )) {
      grant.revoke();
      return failure('stale-request', 'Workspace or bridge state changed while issuing the grant.');
    }

    const env = Object.freeze({
      ELECTRON_RUN_AS_NODE: '1',
      BOOKMARKS_PLUS_LIVE_MODE: '1',
      BOOKMARKS_PLUS_ROOT_URI: canonicalRootUri,
      BOOKMARKS_PLUS_BRIDGE_ENDPOINT: grant.endpoint,
      BOOKMARKS_PLUS_BRIDGE_PROTOCOL: String(grant.protocolVersion),
      BOOKMARKS_PLUS_BRIDGE_GENERATION: grant.generation,
      BOOKMARKS_PLUS_BRIDGE_TOKEN: grant.token
    });
    const descriptor = Object.freeze({
      version: 1 as const,
      transport: 'stdio' as const,
      command: deps.executablePath,
      args: Object.freeze([serverPath, selectedFolder.uri.fsPath]),
      env,
      sensitiveEnvKeys: Object.freeze(['BOOKMARKS_PLUS_BRIDGE_TOKEN']),
      workspaceFolderUri: canonicalRootUri,
      grantedScopes: Object.freeze([...scopes]),
      bootstrapExpiresAt: new Date(grant.expiresAt).toISOString()
    });
    return Object.freeze({ kind: 'success' as const, descriptor });
  } catch (error) {
    grant.revoke();
    throw error;
  }
}

/** Creates one dependency-isolated, immutable snapshot of the public API v1 contract. */
export function createBookmarksPlusApi(
  deps: McpConnectionServiceDependencies
): BookmarksPlusApiV1 {
  const apiVersion = Object.freeze({ major: 1 as const, minor: 0 });
  const mcpConnection = Object.freeze({
    descriptorVersions: Object.freeze([1]),
    transports: Object.freeze(['stdio'] as const),
    scopes: Object.freeze(['workspace', 'global'] as const),
    rootSelection: 'explicit-workspace-folder' as const,
    sessionLifecycle: 'pinned-root' as const
  });
  const capabilities = Object.freeze({ mcpConnection });
  return Object.freeze({
    apiVersion,
    capabilities,
    requestMcpConnection: (request: McpConnectionRequest) => requestMcpConnection(deps, request)
  });
}
