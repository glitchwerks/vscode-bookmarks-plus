# Cross-Extension MCP Access Contract Design

**Status:** Proposed for review  
**Issue:** #137  
**Prerequisites:** #62, #129  
**Downstream implementation:** #138

## Goal

Define the versioned public API that Bookmarks Plus will return from `activate()` so an optional
companion extension can request MCP access for one explicit workspace folder without importing
Bookmarks Plus internals. The first implementation of this contract ships only after multi-root
storage behavior (#62) and the live extension-to-server bridge (#129) are complete. (#137)

The returned connection information is an opaque, serializable stdio bootstrap descriptor. The
consumer may translate that descriptor into its own launch configuration, but it must not infer
Bookmarks Plus installation paths, persistence details, or bridge implementation from the
descriptor fields. (#137)

## Current boundary

- Bookmarks Plus currently returns `void` from `activate()`, so it has no extension API surface.
  (`src/extension.ts:L417-L426`)
- The merged native MCP provider constructs an internal `McpStdioServerDefinition` from the
  extension bundle path and currently rejects no-folder and multi-root windows.
  (`src/mcpServerProvider.ts:L22-L56`)
- Workspace and global stores already exist separately inside activation, but the current native
  server exposes only the single-folder workspace mirror.
  (`src/extension.ts:L439-L444`, `README.md:L108-L117`)
- VS Code supports extension APIs by returning a value from `activate()`; another extension can
  discover the provider with `extensions.getExtension()`, activate it, and read that returned API.
  (https://code.visualstudio.com/api/references/vscode-api, fetched 2026-09-06)
- An exported extension API is available only to extensions running in the same extension host.
  Cross-host communication would require a different boundary, such as commands, and is outside
  API v1. (https://code.visualstudio.com/api/advanced-topics/remote-extensions, fetched 2026-09-06)
- Claude Workspaces already plans launches from an immutable selected-root snapshot and represents
  expected launch failures as typed results. The Bookmarks Plus adapter should fit that boundary
  instead of exposing its stores or provider objects.
  (https://github.com/glitchwerks/vscode-claude-workspaces/blob/main/src/launch/launchPlanner.ts,
  fetched 2026-09-06)

## Design decisions

1. API v1 returns a generic stdio launch descriptor, not a Claude-specific configuration fragment
   and not a live JavaScript session object. (#137)
2. Every request names one current workspace-folder URI and a non-empty set of requested scopes.
   Bookmarks Plus grants exactly those scopes or returns a typed error; it never adds access
   implicitly. (#137)
3. Bootstrap descriptors are short-lived and single-use. Their expiry applies only before startup;
   an initialized MCP session has no periodic expiry. (#137)
4. An active session is pinned to its selected root. Unrelated workspace-folder changes do not
   interrupt it; selected-root removal, bridge shutdown, extension reload, or consumer disconnect
   ends it explicitly. (#137)
5. The companion extension owns optional reconnection and must preserve its primary launch when
   Bookmarks Plus is absent, incompatible, or unavailable. (#137)
6. The exported API and the serialized descriptor are versioned independently. This allows a
   compatible API major to negotiate a newer descriptor without changing extension discovery.
   (#137)
7. Consumers treat `command`, `args`, and `env` as opaque and potentially sensitive. They forward
   them unchanged, do not persist them, and do not log their values. (#137)

## Public API

The producer owns these types in a dependency-free public contract module. A consumer may declare
the same structural types locally; API v1 does not add a separately published types package. Runtime
version checks remain mandatory because TypeScript types do not validate another installed
extension. This keeps Bookmarks Plus optional and avoids adding a new package-release lane to #137.

```ts
export type BookmarkScope = 'workspace' | 'global';

export interface BookmarksPlusApiVersion {
  readonly major: 1;
  readonly minor: number;
}

export interface McpConnectionCapabilities {
  readonly descriptorVersions: readonly number[];
  readonly transports: readonly ['stdio'];
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
  requestMcpConnection(
    request: McpConnectionRequest
  ): Promise<McpConnectionResult>;
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
  readonly workspaceFolderUri: string;
  readonly grantedScopes: readonly BookmarkScope[];
  readonly bootstrapExpiresAt: string;
}

export interface McpConnectionSuccess {
  readonly kind: 'success';
  readonly descriptor: McpStdioDescriptorV1;
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

export type McpConnectionResult =
  | McpConnectionSuccess
  | McpConnectionFailure;
```

### API compatibility

- Consumers accept API major `1` and may accept any minor version whose advertised capabilities
  satisfy their needs. Unknown properties and capabilities must be ignored. (#137)
- A consumer that does not recognize the API major does not call it and continues without Bookmarks
  Plus integration. (#137)
- `supportedDescriptorVersions` must be non-empty. Bookmarks Plus selects the highest mutually
  supported version; no intersection returns `unsupported-descriptor-version`. (#137)
- Descriptor version `1` is the stdio shape above. A future transport or incompatible field change
  requires another descriptor version but does not inherently require another API major. (#137)
- `bootstrapExpiresAt` is an RFC 3339 UTC timestamp. The producer chooses the validity window and
  consumers must launch before the returned instant rather than assuming a fixed duration. (#137)

### Request validation

The request is valid only when all of these conditions hold:

1. `workspaceFolderUri` parses as an absolute URI and exactly identifies a current VS Code
   workspace folder.
2. `scopes` is non-empty, contains no duplicates, and contains only advertised values.
3. `supportedDescriptorVersions` is non-empty, contains positive integers without duplicates, and
   intersects the advertised descriptor versions.
4. The selected root, requested stores, bridge, and bundled server are ready for a new session.
5. The extension has not started disposal.

Validation uses URI identity rather than a consumer-supplied filesystem path. Bookmarks Plus alone
derives any host-specific path needed by the private descriptor. This preserves the explicit-root
requirement without making an internal path part of the public contract. (#137)

### Result semantics

Expected conditions return `McpConnectionFailure`; they do not reject the promise. Programming
faults and unexpected internal failures may reject so they are not misclassified as supported
runtime states. (#137)

| Code | Meaning | Retryable |
| --- | --- | --- |
| `invalid-request` | URI, scopes, or version list is malformed | No |
| `unsupported-descriptor-version` | No requested descriptor version is supported | No |
| `workspace-folder-not-found` | URI is not a current workspace folder | No, until folder state changes |
| `workspace-folder-unavailable` | Selected root exists but its storage/bridge is not ready | Yes |
| `unsupported-scope` | A requested scope is not advertised | No |
| `stale-request` | Root or bridge generation changed while the request was being issued | Yes |
| `temporarily-unavailable` | MCP service cannot issue a descriptor now | Yes |
| `shutting-down` | Extension disposal has begun | Yes, after reactivation |

Messages are diagnostic, not machine-readable. Consumers branch only on `code` and `retryable`.
The result contains no mutable store, provider, disposable, callback, or private bridge object.
(#137)

## Consumer discovery

The full extension identifier is `cbeaulieu-gt.vscode-bookmarks-plus`, derived from the manifest's
publisher and extension name. (`package.json:L2-L6`)

An optional consumer does not declare `extensionDependencies`, because absence must not block its
primary feature. It discovers and activates Bookmarks Plus at runtime, validates the API major and
capabilities, and degrades cleanly when any step fails. This uses VS Code's documented extension
discovery/activation boundary. (#137;
https://code.visualstudio.com/api/references/vscode-api, fetched 2026-09-06)

```ts
import * as vscode from 'vscode';

const extension = vscode.extensions.getExtension<unknown>(
  'cbeaulieu-gt.vscode-bookmarks-plus'
);

if (extension === undefined) {
  return launchWithoutBookmarks();
}

const candidate = await extension.activate();
if (!isBookmarksPlusApiV1(candidate)) {
  return launchWithoutBookmarks();
}

const result = await candidate.requestMcpConnection({
  workspaceFolderUri: selectedRoot.uri.toString(true),
  scopes: ['workspace', 'global'],
  supportedDescriptorVersions: [1]
});

if (result.kind === 'error') {
  reportOptionalIntegrationWarning(result.error);
  return launchWithoutBookmarks();
}

return launchWithOpaqueMcpDescriptor(result.descriptor);
```

The v1 API is same-extension-host only. A UI-side consumer and workspace-side Bookmarks Plus instance
cannot exchange this returned object across hosts. A command-based cross-host facade may be designed
later, but commands would introduce serialization and routing rules that are outside #137.
(https://code.visualstudio.com/api/advanced-topics/remote-extensions, fetched 2026-09-06)

## Producer construction

Activation creates the bridge/session service after both scoped stores are available, builds one
frozen API object over that service, and returns it after existing registrations complete. Existing
native MCP provider registration remains independent, so VS Code Agent-mode discovery from #124 is
unchanged. (`src/extension.ts:L439-L496`; #137)

```ts
export function activate(context: vscode.ExtensionContext): BookmarksPlusApiV1 {
  // Existing stores, views, commands, and native provider registration.
  const connectionService = createMcpConnectionService(/* private dependencies */);
  context.subscriptions.push(connectionService);

  return Object.freeze({
    apiVersion: Object.freeze({ major: 1, minor: 0 }),
    capabilities: freezeCapabilities(connectionService.capabilities),
    requestMcpConnection: (request) => connectionService.request(request)
  });
}
```

The public module contains only DTO types, literal unions, and the API interface. Store adapters,
bootstrap authorization, bridge endpoints, process paths, and provider instances remain private.
(#137)

## Descriptor and startup lifecycle

MCP stdio clients launch the server as a subprocess and exchange JSON-RPC through stdin/stdout. MCP
shutdown is signaled through the underlying transport: the client closes input, or the server closes
output and exits. (https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle,
fetched 2026-09-06;
https://modelcontextprotocol.io/specification/2024-11-05/basic/transports,
fetched 2026-09-06)

The private #129 bridge must provide the following observable lifecycle:

1. `requestMcpConnection()` captures one root/bridge generation and validates the request.
2. It creates a cryptographically unguessable, root- and scope-bound bootstrap authorization with an
   expiry, then embeds the private launch data in the descriptor.
3. The consumer forwards the descriptor without inspection and starts one MCP subprocess.
4. Before reporting MCP initialization success, the subprocess proves and consumes the bootstrap
   authorization through the private bridge.
5. A consumed authorization cannot start another process. An expired, consumed, wrong-generation,
   or wrong-root authorization fails initialization with structured error data containing a stable
   `bookmarksPlusCode`.
6. Successful initialization creates an active session pinned to the selected root and granted
   scopes. The bootstrap expiry no longer applies.
7. Closing stdio ends the subprocess and releases the bridge session. Selected-root removal, bridge
   shutdown, or extension disposal closes the bridge; the subprocess closes stdout and exits.
8. Adding, removing, or reordering other workspace folders does not affect the session while its
   selected root remains available.

These are required outcomes, not a prescribed IPC transport. #129 owns endpoint selection,
authentication storage, bootstrap entropy, cleanup, and reconnect internals. (#129; #137)

### Initialization failure data

The subprocess uses an MCP initialization error whose `data.bookmarksPlusCode` is one of:

- `bootstrap-expired`
- `bootstrap-consumed`
- `producer-restarted`
- `workspace-folder-unavailable`
- `scope-unavailable`
- `bridge-unavailable`

The JSON-RPC numeric error code and human message may follow the MCP SDK's supported initialization
error mechanism; consumers use `bookmarksPlusCode` when they can observe it. A consumer that cannot
surface initialization details still observes server startup failure and continues without bookmark
tools. MCP requires implementations to handle protocol/capability negotiation errors, so explicit
startup failure fits the protocol lifecycle.
(https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle,
fetched 2026-09-06)

## Scope and root semantics

- `workspace` grants access only to bookmark state owned by the selected workspace folder.
- `global` grants access to the extension's global bookmark store in addition to, or independently
  from, `workspace`.
- The descriptor reports exactly the granted scopes in canonical order: `workspace`, then `global`.
- One descriptor binds one root. A consumer that needs distinct root-bound servers makes distinct
  requests; API v1 does not return an aggregate multi-root descriptor.
- Global access is never added implicitly. A session requesting only `workspace` cannot observe or
  mutate global bookmarks.
- Root selection remains explicit even for a global-only request so lifecycle, audit, and consumer
  session ownership remain deterministic.

These semantics implement the explicit-root and least-privilege decisions approved for #137 while
leaving the storage model itself to #62 and #129. (#62; #129; #137)

## Capability and state transitions

`capabilities` describes features supported by this API implementation, not momentary readiness.
Momentary failures are returned by `requestMcpConnection()`. The API object and nested capability
objects are frozen snapshots for one activation generation. After extension reload, consumers must
activate/discover again rather than reuse the old object. (#137)

| Transition | Descriptor not started | Active session |
| --- | --- | --- |
| Unrelated folder added/removed/reordered | Remains usable until bootstrap expiry | Remains connected |
| Selected root removed | Startup validation fails | Bridge closes; server exits |
| Selected root temporarily unavailable | Startup validation fails | Bridge closes; server exits |
| Extension reload/disposal | Generation becomes invalid | Bridge closes; server exits |
| Bootstrap expires | Startup fails | No effect after initialization |
| Descriptor reused | Second startup fails | First active session is unaffected |
| Consumer closes stdio | Not applicable | Server exits and resources are released |

The companion extension decides whether to request a new descriptor and reconnect. Reconnection is
never required for its primary Claude launch to continue. (#137)

## Testing strategy

### Contract unit tests

- API major/minor and capability snapshots are frozen and stable.
- Descriptor-version negotiation chooses the highest mutual version and rejects no intersection.
- Request validation covers malformed/unknown roots, empty/duplicate scopes, unsupported scopes,
  empty/duplicate descriptor versions, disposal, and generation changes.
- Success returns only the public DTO fields, exact granted scopes, an expiry, and opaque frozen
  launch collections.
- Every expected failure maps to its documented code and retryability.

### Lifecycle unit tests

- Bootstrap authorization is root-bound, scope-bound, single-use, generation-bound, and expires.
- Active sessions do not expire with the bootstrap.
- Unrelated folder changes preserve a selected-root session.
- Selected-root removal, bridge shutdown, disposal, and consumer disconnect release the session and
  terminate the subprocess boundary deterministically.
- Concurrent requests cannot consume the same bootstrap authorization or cross scope/root state.

### Packaged producer/consumer test

Build and install the actual Bookmarks Plus VSIX plus a minimal fixture consumer extension. The
fixture discovers Bookmarks Plus with `vscode.extensions.getExtension()`, calls `activate()`, checks
the runtime API version, requests an explicit-root descriptor, forwards it unchanged, completes MCP
initialization, and verifies the granted tools/scopes. It also proves missing/incompatible Bookmarks
Plus does not prevent the fixture's primary launch path. This directly covers #137's required
supported VS Code API boundary. (#137;
https://code.visualstudio.com/api/references/vscode-api, fetched 2026-09-06)

Existing native provider and packaged-MCP suites remain in place to prove the new extension export
does not change VS Code Agent-mode discovery from #124. (#124; #137)

## Documentation and compatibility policy

The #138 implementation updates `README.md` with:

- the extension identifier and optional discovery sequence;
- the complete API v1 and descriptor v1 shapes;
- compatibility rules for API major/minor and descriptor negotiation;
- explicit root and scope behavior;
- same-extension-host, bootstrap-expiry, reconnect, and graceful-degradation limitations;
- a consumer example that does not declare Bookmarks Plus as a mandatory extension dependency.

Breaking changes to an existing field, result code meaning, or method contract require a new API
major. Additive optional capability fields and new descriptor versions may use a higher API minor.
A descriptor field change that an existing consumer cannot safely ignore requires a new descriptor
version. These rules are the compatibility boundary approved for #137. (#137)

## Out of scope

- Implementing #62, #129, or #138.
- Modifying Claude Workspaces.
- Publishing a separate TypeScript types package.
- Cross-extension-host or web-extension transport.
- Consumer-specific Claude configuration syntax.
- Automatic reconnection inside Bookmarks Plus.
- Changing the existing native MCP provider or standalone npm compatibility path.

## Delivery sequence

1. Approve and merge this #137 contract.
2. Implement multi-root storage semantics in #62.
3. Implement the authenticated live bridge and lifecycle in #129 against this contract.
4. Implement and document the exported API in #138.
5. Integrate the optional consumer in its own repository and verify graceful degradation.

This preserves the dependency sequence recorded by #137 and prevents the public contract from
silently changing while its private transport is implemented. (#137)
