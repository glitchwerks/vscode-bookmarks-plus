# Cross-Extension MCP Access Contract Design

**Status:** Revised after third architectural review and root-addition review; pending downstream issue updates
**Issue:** #137
**Approval gates:** #62 update; glitchwerks/vscode-claude-workspaces#50 update
**Implementation prerequisites:** #62, #129
**Downstream implementation:** #138
**Consumer integration:** glitchwerks/vscode-claude-workspaces#50

## Goal

Define the versioned public API that Bookmarks Plus will return from `activate()` so an optional
companion extension can request MCP access for one explicit workspace folder without importing
Bookmarks Plus internals. The first implementation of this contract ships only after multi-root
storage behavior (#62) and the live extension-to-server bridge (#129) are complete. (#137)

Before this contract is approved, #62 must own the logical root-partition, URI-identity, migration,
collection, and out-of-root semantics defined below, and glitchwerks/vscode-claude-workspaces#50
must own the bounded optional adapter plus the redacted, ephemeral carrier used to pass a bootstrap
descriptor to Claude Code. These are issue-tracking approval gates; their implementations remain in
the delivery sequence below. (#137; #62; #129; glitchwerks/vscode-claude-workspaces#50)

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
- The workspace store is one window-wide `BookmarkStore` backed by `context.workspaceState`; its
  items contain absolute URIs but neither items nor collections record an owning workspace folder.
  (`src/extension.ts:L439-L444`, `src/bookmarkStore.ts:L57-L80`, `src/types.ts:L3-L23`)
- Existing workspace utilities already choose the deepest matching root for nested folders. Root
  ownership must reuse that rule rather than depend on workspace-folder order.
  (`src/workspaceFolders.ts:L72-L94`, `src/test/suite/workspaceFolders.test.ts:L165-L184`)
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
- Claude Workspaces currently logs the complete Claude argument array, and Claude Code accepts
  `--mcp-config` as JSON files or strings. Passing authorization-bearing inline JSON would therefore
  expose the bootstrap value in diagnostics and process arguments.
  (https://github.com/glitchwerks/vscode-claude-workspaces/blob/main/src/logging/outputLogger.ts,
  fetched 2026-09-06;
  https://code.claude.com/docs/en/cli-usage, fetched 2026-09-06)
- Claude Workspaces declares `extensionKind: ["workspace"]`, while Bookmarks Plus currently has no
  extension-kind preference. Co-location is not guaranteed in remote windows until Bookmarks Plus
  declares the same workspace-host preference.
  (https://github.com/glitchwerks/vscode-claude-workspaces/blob/main/package.json,
  fetched 2026-09-06; `package.json:L1-L17`;
  https://code.visualstudio.com/api/advanced-topics/extension-host, fetched 2026-09-06)

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
8. Workspace data has one logical owner root. Root isolation is part of the public behavior even if
   #62 keeps the physical persistence inside one window-wide state object. (#62; #137)
9. API v1 trusts every installed extension in the same extension host as an authorized caller. It
   does not accept a caller-supplied identity and does not add a per-caller consent prompt. The
   bootstrap authorization authenticates the spawned MCP process to the private bridge; it does not
   authenticate which co-hosted extension requested it. (#137;
   https://code.visualstudio.com/api/advanced-topics/remote-extensions, fetched 2026-09-06)
10. Bookmarks Plus explicitly requires Workspace Trust and prefers the workspace extension host.
    The API is unavailable until the workspace is trusted, and cross-host calls remain unsupported.
    (https://code.visualstudio.com/api/extension-guides/workspace-trust, fetched 2026-09-06;
    https://code.visualstudio.com/api/advanced-topics/extension-host, fetched 2026-09-06)

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
  readonly transports: readonly McpTransport[];
  readonly scopes: readonly BookmarkScope[];
  readonly rootSelection: 'explicit-workspace-folder';
  readonly sessionLifecycle: 'pinned-root';
}

export type McpTransport = 'stdio';

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
  readonly sensitiveEnvKeys: readonly string[];
  readonly workspaceFolderUri: string;
  readonly grantedScopes: readonly BookmarkScope[];
  readonly bootstrapExpiresAt: string;
}

// API v1.0 ships only this member. A later API v1 minor may add another
// descriptor interface to this union without changing existing members.
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
  requires another descriptor version and an additive API minor that extends `McpTransport` and
  `McpConnectionDescriptor`. Existing consumers remain compatible because a success descriptor's
  version must be advertised by the producer and included in that request's
  `supportedDescriptorVersions`. (#137)
- `bootstrapExpiresAt` is an RFC 3339 UTC timestamp. The producer chooses the validity window and
  consumers must launch before the returned instant rather than assuming a fixed duration. (#137)

Descriptor v1 has these execution invariants:

- `env` is an overlay on the consumer's inherited process environment; descriptor values win on
  key collisions. It is not a complete replacement environment. This matches VS Code's stdio MCP
  environment behavior. (https://code.visualstudio.com/api/references/vscode-api,
  fetched 2026-09-06)
- `command` and every argument needed to locate an executable or file are absolute. Descriptor v1
  has no `cwd`, and server behavior must not depend on the consumer's current working directory.
- Authorization material may appear only in values whose keys are listed by `sensitiveEnvKeys`.
  It must not appear in `command`, `args`, `workspaceFolderUri`, or other metadata.
- `sensitiveEnvKeys` contains unique keys that exist in `env`. Consumers redact those values before
  diagnostics and treat the complete descriptor as ephemeral sensitive data.

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
capabilities, and degrades cleanly when any step fails. The consumer owns one finite deadline across
activation and the descriptor request, catches rejected promises, ignores late results, and logs
only a concise error class or typed failure code. A late success descriptor is abandoned and expires
unused; it is never launched after the primary fallback path begins. This uses VS Code's documented
extension discovery/activation boundary. (#137;
glitchwerks/vscode-claude-workspaces#50;
https://code.visualstudio.com/api/references/vscode-api, fetched 2026-09-06)

```ts
import * as vscode from 'vscode';

async function resolveOptionalBookmarksMcp(
  selectedRoot: vscode.WorkspaceFolder,
  timeoutMs: number
): Promise<McpConnectionDescriptor | undefined> {
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const extension = vscode.extensions.getExtension<unknown>(
      'cbeaulieu-gt.vscode-bookmarks-plus'
    );
    if (extension === undefined) {
      return undefined;
    }

    const candidate = await withDeadline(extension.activate(), remainingMs(deadlineAt));
    if (!isBookmarksPlusApiV1(candidate)) {
      reportOptionalIntegrationWarning('incompatible-api');
      return undefined;
    }

    const result = await withDeadline(
      candidate.requestMcpConnection({
        workspaceFolderUri: selectedRoot.uri.toString(true),
        scopes: ['workspace', 'global'],
        supportedDescriptorVersions: [1]
      }),
      remainingMs(deadlineAt)
    );

    if (result.kind === 'error') {
      reportOptionalIntegrationWarning(result.error.code);
      return undefined;
    }
    return result.descriptor;
  } catch (error: unknown) {
    reportOptionalIntegrationWarning(classifyRedactedFailure(error));
    return undefined;
  }
}

const descriptor = await resolveOptionalBookmarksMcp(selectedRoot, integrationTimeoutMs);
return descriptor === undefined
  ? launchWithoutBookmarks()
  : launchWithSecureMcpCarrier(descriptor);
```

`withDeadline` must cover the remaining time in one overall integration budget rather than granting
the full timeout independently to activation and request. Its timeout does not cancel or consume a
late result; the adapter attaches a rejection handler, discards any eventual descriptor, and starts
the fallback launch exactly once. The consumer chooses and tests a finite budget appropriate to its
launch UX; the public API does not prescribe that duration. (glitchwerks/vscode-claude-workspaces#50)

The v1 API is same-extension-host only. A UI-side consumer and workspace-side Bookmarks Plus instance
cannot exchange this returned object across hosts. A command-based cross-host facade may be designed
later, but commands would introduce serialization and routing rules that are outside #137.
(https://code.visualstudio.com/api/advanced-topics/remote-extensions, fetched 2026-09-06)

API v1 requires both extensions to run in a Node workspace extension host. Bookmarks Plus adds
`"extensionKind": ["workspace"]` to align with Claude Workspaces. Local desktop workspace hosts are
required coverage. Remote workspace support may be documented as supported only after the packaged
producer/consumer test runs in a real remote extension host; otherwise README documentation must
mark it unsupported rather than infer support from manifest placement alone.
(https://github.com/glitchwerks/vscode-claude-workspaces/blob/main/package.json,
fetched 2026-09-06;
https://code.visualstudio.com/api/advanced-topics/extension-host, fetched 2026-09-06)

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

## Caller trust and Workspace Trust

VS Code exposes an activation-return API to extensions in the same extension host, but the method
call does not carry an authenticated extension identity. API v1 therefore adopts the installed-
extension trust model: every co-hosted extension may request every advertised scope after Workspace
Trust is granted. A caller-provided extension ID would be informational only and is deliberately not
part of the authorization decision.
(https://code.visualstudio.com/api/advanced-topics/remote-extensions, fetched 2026-09-06)

The bootstrap authorization has a narrower purpose: it proves that one spawned MCP process holds a
fresh root- and scope-bound authorization issued by Bookmarks Plus. It does not prove which extension
called `requestMcpConnection()`. If per-extension approval is required later, it needs a separately
designed user-consent boundary and a new API major rather than an unauthenticated request field.
(#129; #137)

The #138 implementation adds these manifest declarations:

```json
{
  "extensionKind": ["workspace"],
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": false,
      "description": "Bookmarks Plus MCP access can start a process with access to workspace bookmark data."
    }
  }
}
```

VS Code already treats an undeclared main-entry extension as unsupported in Restricted Mode, but an
explicit declaration makes the security decision durable and testable. Bookmarks Plus does not
activate or export this API until trust is granted.
(https://code.visualstudio.com/api/extension-guides/workspace-trust, fetched 2026-09-06)

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
3. The consumer serializes the descriptor without interpreting or modifying its launch fields and
   starts one MCP subprocess.
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

## Secure Claude Workspaces carrier

The generic Bookmarks Plus API defines sensitivity metadata and bootstrap behavior; the concrete
Claude CLI carrier belongs to glitchwerks/vscode-claude-workspaces#50. That integration uses a
secure ephemeral JSON file, not inline `--mcp-config` JSON and not durable user/project MCP
configuration. Claude Code accepts a JSON file path for `--mcp-config`.
(glitchwerks/vscode-claude-workspaces#50;
https://code.claude.com/docs/en/cli-usage, fetched 2026-09-06)

The consumer must:

1. Translate descriptor v1 to one stdio server entry without changing `command`, `args`, `env`, or
   their ordering/values. Contract metadata such as `sensitiveEnvKeys`, root URI, scopes, and expiry
   is not copied into the Claude MCP server entry.
2. Create the file in an extension-owned temporary location with access limited to the current OS
   user. The file must not be placed under a workspace, committed configuration directory, or other
   durable project path.
3. Pass only the temporary file path to Claude through `--mcp-config`; authorization-bearing JSON
   must never appear directly in the Claude argument array.
4. Redact the value following `--mcp-config` and every value named by `sensitiveEnvKeys` from launch,
   exception, telemetry, and debug output. The existing full-argument launch log must be changed
   before integration.
   (https://github.com/glitchwerks/vscode-claude-workspaces/blob/main/src/logging/outputLogger.ts,
   fetched 2026-09-06)
5. Delete the file immediately when planning, creation, or process launch fails; when launch is
   cancelled; when the Claude process exits; or when the consumer extension disposes.
6. After a successful process spawn, retain the file only until `bootstrapExpiresAt` unless an
   earlier cleanup condition occurs. The token is already unusable after successful consumption,
   and expiry bounds the remaining file lifetime without requiring a public live-session object.
7. Ignore cleanup `FileNotFound` races and surface other cleanup failures only as redacted
   diagnostics; cleanup failure must not expose descriptor contents.

Tests in glitchwerks/vscode-claude-workspaces#50 must prove that raw descriptor values and
authorization material never enter logs or durable configuration and that cleanup runs after
success, failure, cancellation, timeout, process exit, and extension disposal. The Bookmarks Plus
packaged fixture verifies that this file-derived configuration still completes MCP initialization.
(#137; glitchwerks/vscode-claude-workspaces#50)

## Scope and root semantics

- `workspace` grants access only to bookmark state logically owned by the selected workspace folder.
- `global` grants access to the extension's global bookmark store in addition to, or independently
  from, `workspace`.
- The descriptor reports exactly the granted scopes in canonical order: `workspace`, then `global`.
- One descriptor binds one root. A consumer that needs distinct root-bound servers makes distinct
  requests; API v1 does not return an aggregate multi-root descriptor.
- Global access is never added implicitly. A session requesting only `workspace` cannot observe or
  mutate global bookmarks.
- Root selection remains explicit even for a global-only request so lifecycle, audit, and consumer
  session ownership remain deterministic.

### Logical workspace ownership required from #62

#62 may implement physical storage as one partitioned window state or as distinct per-folder stores,
but it must expose the same logical behavior:

1. Every workspace bookmark item and collection has exactly one owner: a stable root-partition
   identity or the `unassigned` preservation partition. A root-partition identity is durable and is
   not the workspace folder's display name or current URI.
2. A root partition is either attached to exactly one current workspace-folder URI or detached with
   no current URI. At most one partition may be attached to a current workspace-folder URI. Removing
   a workspace folder detaches its partition without changing the partition identity or deleting its
   data; changing only the folder's displayed workspace name does not detach it.
3. A new item is owned by the attached partition for the deepest current workspace folder containing
   its URI. A new empty collection created through MCP is owned by the session's selected attached
   partition.
4. Once assigned, an existing item's or collection's owner remains stable when workspace folders are
   added, nested, or reordered. Adding nested root B does not move items or collections from parent
   root A, and adding a root around an `unassigned` item does not claim that item.
5. A newly added root either reattaches its unique same-identity detached partition under the rules
   below or creates a new empty partition. Only items and empty collections created after that change
   use the then-current deepest-root rule. Folder addition never triggers implicit repartitioning or
   live collection splitting. (#62; #137)
6. An item outside every current root is `unassigned`. It remains available through the Bookmarks
   Plus UI but is invisible and immutable through every root-scoped MCP session.
7. Collections cannot span logical owners. A root-scoped session sees and mutates only collections
   owned by its selected partition and items owned by that same partition.
8. Every mutation carries the selected root through the bridge. An operation on existing data must
   resolve every target identifier inside the selected partition; an identifier from another
   partition is treated as not found, not as an implicit cross-root operation.
9. Before a workspace-scoped MCP create operation mutates state, the server resolves the proposed
   item's URI with the same deepest-current-root rule. The resolved partition must equal the
   session's selected partition. A URI resolving to another root or to `unassigned` returns the
   tool's defined not-found or invalid-scope error and performs no mutation.
10. Imported Claude roots receive no access merely because the selected process has filesystem access
   to them. Each additional root requires its own explicit descriptor request.
11. API v1 exposes no automatic or MCP-triggered reassignment of existing data. If #62 provides a
    user-facing reassignment or recovery action, the user must invoke and confirm it explicitly; the
    operation must update ownership and apply the collection-splitting rules below atomically. (#62;
    #137)

The deepest-root rule matches the repository's existing order-independent nested-folder behavior.
(`src/workspaceFolders.ts:L72-L94`, `src/test/suite/workspaceFolders.test.ts:L165-L184`;
glitchwerks/vscode-claude-workspaces#50)

#62 owns one deterministic root-URI canonicalization function. The same function must normalize URI
components before root containment/equality comparisons and provide the identity used for current-
folder attachment, persisted partition metadata, exact-root request validation, and detached-root
reattachment. It must not depend on process locale, current working directory, or workspace-folder
order, and it must not collapse two distinct current workspace folders to one identity. #62 must
document and test the chosen behavior for scheme and authority casing, path casing, percent-encoding,
and trailing separators for both local `file` and supported remote workspace-folder URIs. (#62;
#137; `src/workspaceFolders.ts:L1-L94`)

### Existing-data migration required from #62

The schema migration must be lossless and idempotent:

1. Assign each existing item to the stable partition for its deepest matching current root; preserve
   unmatched items in `unassigned`.
2. Treat every represented current-root partition and `unassigned` as independent preservation
   partitions when assigning a collection.
3. Keep a non-empty collection in one partition when all member items resolve to that partition. A
   collection containing only unmatched items remains one non-empty `unassigned` collection.
4. When a collection contains items assigned to multiple represented partitions, including any
   mixture of current roots and `unassigned`, create one independent collection per represented
   partition, preserve its name, description, and relative order, and rebind only that partition's
   items to it. For example, root A, root B, and unmatched members become root-A, root-B, and
   `unassigned` collections.
5. Preserve an empty existing collection in `unassigned`; do not guess a root.
6. Generate distinct collection identifiers when a collection is split so later mutations in one
   partition cannot affect another partition's collection.
7. Persist a migration marker/schema version so retries do not duplicate split collections.
8. Log counts only. Migration diagnostics must not log bookmark URIs, names, descriptions, or
   descriptor data.

When exactly one detached partition has the same canonical URI identity as a returning workspace
folder and no attached partition claims that identity, Bookmarks Plus must reattach it automatically.
A folder move or rename that changes the identity must not be inferred from a matching display name,
basename, path suffix, or bookmark contents. Rebinding a detached partition to a different current
URI requires an explicit user-confirmed recovery action, preserves the stable partition identity,
and must fail rather than merge implicitly when that URI is already attached to another partition.
Ambiguous legacy or corrupt state with multiple matching detached partitions also requires explicit
recovery and must not auto-merge. Detached partitions remain unavailable to new MCP requests until
reattached. #62 must document the recovery action before #137 is approved. (#62; #137)

These semantics implement the selected-root and least-privilege contract while leaving the physical
storage representation to #62 and the authenticated mutation path to #129. (#62; #129; #137)

## Capability and state transitions

`capabilities` describes features supported by this API implementation, not momentary readiness.
Momentary failures are returned by `requestMcpConnection()`. The API object and nested capability
objects are frozen snapshots for one activation generation. After extension reload, consumers must
activate/discover again rather than reuse the old object. (#137)

| Transition | Descriptor not started | Active session |
| --- | --- | --- |
| Folder added or reordered, including a nested root | Remains usable until bootstrap expiry; existing ownership is unchanged | Remains connected; existing ownership is unchanged |
| Unrelated folder removed | Remains usable until bootstrap expiry | Remains connected |
| Selected root removed | Startup validation fails | Bridge closes; server exits |
| Selected root temporarily unavailable | Startup validation fails | Bridge closes; server exits |
| Extension reload/disposal | Generation becomes invalid | Bridge closes; server exits |
| Bootstrap expires | Startup fails | No effect after initialization |
| Descriptor reused | Second startup fails | First active session is unaffected |
| Consumer closes stdio | Not applicable | Server exits and resources are released |

The companion extension decides whether to request a new descriptor and reconnect. Reconnection is
never required for its primary Claude launch to continue. (#137)

For Claude Workspaces v1, "reconnect" means acquiring a fresh descriptor for **New Session**,
**New in Folder**, **Retry**, or **Restart Fresh** before starting a new Claude process. The
documented `--mcp-config` launch flag does not provide a way for the extension to replace a consumed
descriptor inside an already-running Claude process. If the Bookmarks Plus server exits during a
long-running session, that Claude process continues without bookmark tools; transparent in-process
MCP reconnection is not promised. (glitchwerks/vscode-claude-workspaces#50;
https://code.claude.com/docs/en/cli-usage, fetched 2026-09-06)

## Testing strategy

### Contract unit tests

- API major/minor and capability snapshots are frozen and stable.
- Descriptor-version negotiation chooses the highest mutual version and rejects no intersection. A
  test-only second descriptor variant proves selection and discriminated-union result narrowing;
  API v1.0 does not ship an otherwise unused production v2 implementation.
- Request validation covers malformed/unknown roots, empty/duplicate scopes, unsupported scopes,
  empty/duplicate descriptor versions, disposal, and generation changes.
- Success returns only the public DTO fields, exact granted scopes, an expiry, and opaque frozen
  launch collections.
- Every expected failure maps to its documented code and retryability.
- Descriptor v1 tests prove environment overlay precedence, cwd independence, absolute launch paths,
  and that authorization appears only in `sensitiveEnvKeys` values.

### Lifecycle unit tests

- Bootstrap authorization is root-bound, scope-bound, single-use, generation-bound, and expires.
- Active sessions do not expire with the bootstrap.
- Unrelated folder changes preserve a selected-root session.
- Selected-root removal, bridge shutdown, disposal, and consumer disconnect release the session and
  terminate the subprocess boundary deterministically.
- Concurrent requests cannot consume the same bootstrap authorization or cross scope/root state.
- Nested-root ownership uses the deepest root. Selected-root reads, collections, and mutations never
  expose another root or the `unassigned` partition. Cross-root and out-of-root create attempts
  return the defined tool error and leave state unchanged.
- Existing-data migration covers single-root ownership, collections containing only unmatched items,
  mixed root-owned and unmatched items, split multi-root collections, empty collections,
  out-of-root items, and idempotent retry without data loss.
- Root lifecycle tests preserve stable partition identity across detachment, automatically reattach
  exactly one detached partition with the same canonical URI identity, ignore display-name changes,
  and require explicit recovery for changed-identity or ambiguous matches without implicitly merging
  partitions. URI-identity tests cover the documented scheme, authority, path-case, percent-encoding,
  and trailing-separator behavior for local and remote roots and prove the same canonicalization is
  used by attachment, persistence, request validation, containment, and reattachment.
- Root-addition tests prove that adding or nesting root B does not reassign root-A or `unassigned`
  items, does not split existing collections, and does not interrupt active root-A sessions or
  invalidate unstarted root-A descriptors. Items and empty collections created under B after the
  addition use B's partition, and a root-B session cannot observe the retained A-owned or
  `unassigned` data.

### Optional-consumer isolation tests

- Missing extension, incompatible API major, unsupported capabilities, and every typed request
  failure continue with the primary launch.
- Activation rejection, request rejection, and activation/request promises that never settle are
  bounded by one overall deadline and start the fallback launch exactly once.
- A descriptor that resolves after the deadline is discarded and never launched.
- Diagnostics contain only redacted classifications/codes; descriptor fields, sensitive environment
  values, bookmark content, and inline MCP JSON never appear.
- The secure temporary carrier is removed after successful launch, failed launch, cancellation,
  timeout, process exit, and extension disposal.

### Packaged producer/consumer test

Build and install the actual Bookmarks Plus VSIX plus a minimal fixture consumer extension. The
fixture discovers Bookmarks Plus with `vscode.extensions.getExtension()`, calls `activate()`, checks
the runtime API version, requests an explicit-root descriptor, serializes its launch fields through
the secure ephemeral carrier, completes MCP initialization, and verifies the granted tools/scopes.
It also proves missing/incompatible Bookmarks Plus does not prevent the fixture's primary launch
path. This directly covers #137's required supported VS Code API boundary. (#137;
https://code.visualstudio.com/api/references/vscode-api, fetched 2026-09-06)

The packaged suite asserts `extensionKind: ["workspace"]` and explicit
`capabilities.untrustedWorkspaces.supported: false`. It runs trusted and Restricted Mode cases
separately. Restricted Mode must leave Bookmarks Plus inactive and the optional consumer on its
fallback path. VS Code documents separate trusted/untrusted extension-test configurations for this
behavior. (https://code.visualstudio.com/api/working-with-extensions/testing-extension,
fetched 2026-09-06)

A real remote extension-host packaged run is required before README documentation may claim remote
workspace support. That run installs both extensions into the same workspace host, requests a root
in that host, launches the returned command there, and completes the handshake. A manifest-only test
is necessary but not sufficient because placement also depends on installed location and available
hosts. (https://code.visualstudio.com/api/advanced-topics/extension-host, fetched 2026-09-06)

Existing native provider and packaged-MCP suites remain in place to prove the new extension export
does not change VS Code Agent-mode discovery from #124. (#124; #137)

## Documentation and compatibility policy

The #138 implementation updates `README.md` with:

- the extension identifier and optional discovery sequence;
- the complete API v1 and descriptor v1 shapes;
- compatibility rules for API major/minor and descriptor negotiation;
- explicit root and scope behavior;
- installed-extension caller trust, Workspace Trust, workspace-host placement, bootstrap-expiry,
  secure-carrier, reconnection, and graceful-degradation limitations;
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
- Implementing the Claude-specific secure carrier in this repository.
- Automatic reconnection inside Bookmarks Plus.
- Changing the existing native MCP provider or standalone npm compatibility path.

## Delivery sequence

1. Update #62 to own the logical root-partition, URI-identity, migration, split-collection, and
   recovery behavior required by this contract.
2. Update glitchwerks/vscode-claude-workspaces#50 with the bounded optional adapter, redacted
   diagnostics, secure temporary carrier, and non-transparent reconnection limitation.
3. Approve and merge this #137 contract.
4. Implement the updated multi-root storage semantics in #62.
5. Implement the authenticated live bridge and lifecycle in #129 against this contract.
6. Implement and document the exported API, host placement, and Workspace Trust policy in #138.
7. Integrate the optional consumer and verify local, Restricted Mode, and claimed remote behavior.

This preserves the dependency sequence recorded by #137 and prevents the public contract from
silently changing while its private transport is implemented. (#137)

## Approval criteria

#137 is ready for approval when:

1. #62 records the stable attached/detached partition model, deterministic URI canonicalization,
   mandatory unique same-identity reattachment, lossless `unassigned` collection splitting,
   stable ownership across root additions, create-operation scope checks, and recovery
   responsibilities above without weakening selected-root isolation.
2. The contract's failure-isolation example remains bounded across activation and request and
   discards late descriptors.
3. Descriptor evolution, environment overlay, absolute-path, and cwd-independent execution rules
   are internally consistent.
4. The installed-extension caller trust model, explicit Workspace Trust requirement, and workspace-
   host placement are accepted.
5. glitchwerks/vscode-claude-workspaces#50 owns a non-logging, non-durable carrier with complete
   cleanup tests and documents that hot reconnection is unavailable.
6. The verification matrix covers root isolation/migration, thrown and non-settling optional paths,
   secret redaction, secure cleanup, descriptor negotiation, trust, and every claimed host.
