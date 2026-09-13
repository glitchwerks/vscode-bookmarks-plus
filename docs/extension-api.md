# Extension API consumer guide

Bookmarks Plus exposes an optional, versioned API to extensions running in the same Node workspace
extension host. Discover it with the extension ID `cbeaulieu-gt.vscode-bookmarks-plus`.

Do not declare Bookmarks Plus as an `extensionDependencies` dependency when your primary feature
works without it. The producer may be absent, incompatible, unavailable, or disabled in Restricted
Mode, so consumers must retain their normal fallback.

## Discovery and fallback

Check Workspace Trust before looking up or activating Bookmarks Plus. In Restricted Mode, continue
with the fallback instead of attempting to obtain an MCP connection:

```ts
import * as vscode from 'vscode';

async function startWithOptionalBookmarksMcp(
  selectedRoot: vscode.WorkspaceFolder
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return launchWithoutBookmarks();
  }

  // Example consumer-owned budget, shared by discovery, activation, and the request.
  const timeoutMs = 5_000;
  const deadline = performance.now() + timeoutMs;
  const discoverDescriptor = async (): Promise<McpConnectionDescriptor | undefined> => {
    const extension = vscode.extensions.getExtension<unknown>(
      'cbeaulieu-gt.vscode-bookmarks-plus'
    );
    if (extension === undefined || performance.now() >= deadline) {
      return undefined;
    }

    const candidate = await extension.activate();
    if (performance.now() >= deadline || !isBookmarksPlusApiV1(candidate) ||
        !candidate.capabilities.mcpConnection.transports.includes('stdio') ||
        !candidate.capabilities.mcpConnection.descriptorVersions.includes(1)) {
      return undefined;
    }

    const result = await candidate.requestMcpConnection({
      workspaceFolderUri: selectedRoot.uri.toString(true),
      scopes: ['workspace', 'global'],
      supportedDescriptorVersions: [1]
    });
    return performance.now() < deadline && result.kind === 'success'
      ? result.descriptor : undefined;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const descriptor = await Promise.race([discoverDescriptor(), timedOut])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));

  // Only the race winner selects a launch. Late promises have no launch side effects.
  // Keep launch errors outside the discovery catch so they cannot start a second launch.
  return descriptor === undefined || performance.now() >= deadline
    ? launchWithoutBookmarks()
    : launchWithMcpDescriptor(descriptor);
}
```

The example uses one finite overall deadline and treats a timeout, rejected promise, or typed
`McpConnectionFailure` as the same graceful fallback. Five seconds is an example, not an API
requirement. A timed-out operation can still settle later, but its descriptor is discarded.

`isBookmarksPlusApiV1` is a consumer-owned runtime type guard. It must validate
`apiVersion.major === 1` and every capability the consumer needs.

## Public API v1

```ts
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
```

## Compatibility

API major `1` is the compatibility boundary. Minor releases may add optional capabilities or
fields. Consumers and producers negotiate the highest mutually supported descriptor version and
ignore unknown fields. A field change that an existing descriptor consumer cannot safely ignore
requires a new descriptor version. Breaking method or result semantics requires a new API major.

## Descriptor handling

Treat a successful descriptor as opaque, short-lived launch material:

- Forward `command`, `args`, and `env` unchanged to the subprocess.
- Overlay `env` on the inherited environment, with descriptor values winning on collisions.
- Do not require a `cwd`.
- Redact every value named by `sensitiveEnvKeys`.
- Never log or persist the descriptor.
- Start the process before `bootstrapExpiresAt`.

Each descriptor identifies exactly one current workspace root. `grantedScopes` uses canonical
order: `workspace`, then `global`. Request scopes explicitly; there is no implicit Global access.
Workspace access excludes other roots and the Unassigned partition. Global access includes global
bookmarks outside the selected root. Every new process or reconnect attempt requires a fresh
request and descriptor.

## Trust and lifecycle

After Workspace Trust is granted, any installed extension in the same host may call API v1; the
API does not authenticate individual callers. Both extensions must run in the Node workspace
extension host (`extensionKind` is `"workspace"`). Remote extension-host support is not claimed.

Bootstrap authorization is single-use. Its expiry applies only before initialization; an active
session has no periodic expiry. Removing the selected root, reloading Bookmarks Plus, or disposing
it closes the server. Unrelated root changes do not close it. Bookmarks Plus does not hot-reconnect
a running client, so consumers must request a fresh descriptor and retain fallback behavior.
