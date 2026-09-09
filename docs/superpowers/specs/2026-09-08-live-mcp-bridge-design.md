# Live MCP bridge design

**Date:** 2026-09-08

**Status:** Approved in conversation; written-spec review corrections incorporated

**Issue:** #129

**Depends on:** #62, #124, #137

## Goal

Give the bundled VS Code-native MCP server live, root-scoped access to the extension-owned
workspace and global bookmark stores. Reads must reflect committed extension state, and mutations
must pass through those stores rather than compete with the extension through
`.vscode/bookmarks.json`. The standalone npm/Claude server remains mirror-backed and compatible.
(#129)

## Existing boundaries

- Activation creates one partitioned workspace store from `workspaceState`, one global store from
  `globalState`, and the workspace mirror coordinator before registering the native MCP provider.
  (`src/extension.ts:L265-L305`, `src/extension.ts:L363-L375`)
- The workspace store exposes explicit owner reads and root-validated, queued mutations. It already
  commits by cloning, validating, persisting, and then publishing a new snapshot.
  (`src/workspaceBookmarkStore.ts:L242-L250`, `src/workspaceBookmarkStore.ts:L358-L400`,
  `src/workspaceBookmarkStore.ts:L857-L877`)
- The global `BookmarkStore` mutates its in-memory object before awaiting persistence and has no
  mutation queue. Concurrent UI and MCP calls therefore need a shared serialization boundary, not
  a bridge-only lock. (`src/bookmarkStore.ts:L46-L55`, `src/bookmarkStore.ts:L83-L85`,
  `src/bookmarkStore.ts:L108-L127`)
- The current provider returns one stdio definition per attached root and launches the bundled MCP
  entry point with the root path. (`src/mcpServerProvider.ts:L23-L51`)
- The current MCP tools read and write the mirror directly. `list_bookmarks` returns top-level
  collection and item arrays; `add_bookmark` resolves a collection and performs a write-then-verify
  retry against the mirror. (`mcp-server/src/tools/list.ts:L6-L95`,
  `mcp-server/src/tools/add.ts:L84-L152`, `mcp-server/src/tools/add.ts:L155-L228`)
- The approved cross-extension contract requires short-lived single-use bootstraps, root-pinned
  sessions without periodic expiry, exact scope grants, fail-closed startup, and explicit session
  invalidation. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L68-L97`,
  `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L395-L424`;
  #137)
- Workspace ownership, deepest-root validation, stable attachment, and recovery semantics are
  already implemented by #62 and must not be redefined here.
  (`docs/superpowers/specs/2026-09-07-multi-root-workspace-partitioning-design.md:L138-L196`,
  `docs/superpowers/specs/2026-09-07-multi-root-workspace-partitioning-design.md:L235-L255`;
  PR #145)

## Requirements

1. Native MCP sessions can list and add workspace and global bookmarks through the live stores.
2. Every returned bookmark and collection identifies its scope.
3. Workspace mutations remain pinned to one attached root; global mutations remain logically
   separate from every workspace partition.
4. Bootstrap authentication, extension reload, root removal, client shutdown, concurrent calls,
   and stale-session behavior are deterministic.
5. Native startup fails closed when the live bridge is unavailable. It never falls back to a mirror
   writer inside the same VS Code session.
6. Standalone npm/Claude launches remain mirror-backed; the new protocol is private to bundled live
   sessions. (#129)

## Non-goals

- Exporting the public extension API approved by #137. #129 builds the private service that #138
  will wrap; `activate()` continues to return no public API in this issue. (#138)
- Adding MCP tools beyond `list_bookmarks` and `add_bookmark`.
- Removing workspace mirrors or changing their external-file behavior.
- Giving the standalone npm package access to VS Code `globalState`.
- Transparent reconnection inside an already-running Claude process. The approved consumer contract
  acquires a fresh descriptor for a later launch instead.
  (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L595-L623`)
- Claiming remote-extension-host support before a real remote packaged test exists.
  (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L322-L334`)

## Decisions

1. Use one private Node IPC listener per Bookmarks Plus activation: a Unix domain socket on Unix and
   a named pipe on Windows.
2. Keep MCP lifecycle and tool registration in the subprocess. Use a narrow private RPC protocol
   between the subprocess and extension rather than forwarding the complete MCP protocol.
3. Put the tool handlers behind a bookmark-backend interface. Bundled native sessions use a live
   backend; standalone sessions use the existing mirror backend.
4. Every root-specific native server receives both `workspace` and `global` grants. Global data may
   therefore appear through each root-specific server in a multi-root window; workspace data does
   not cross root boundaries.
5. Keep the current tool names and top-level result arrays. Add `scope` to every returned item and
   collection. Add an optional `scope` input to `add_bookmark`.
6. An omitted add scope resolves to the only granted scope, or to `workspace` when both scopes are
   granted. Explicit ungranted scopes fail without mutation.
7. A bootstrap expires after 60 seconds and is single-use. An authenticated session has no lease or
   heartbeat and may remain connected for the life of a persistent MCP client.
8. Native bridge failure blocks MCP initialization; there is no workspace-mirror fallback.

## Transport comparison

| Transport | Advantages | Costs | Decision |
| --- | --- | --- | --- |
| Unix domain socket / Windows named pipe | Local IPC namespace, no network listener, supported through Node's `net` stream API, same extension-host machine as the spawned child | Platform-specific endpoint naming; Unix crash cleanup | **Selected** |
| Loopback TCP on an ephemeral port | One address shape and no socket file | Opens a local network listener and makes the token the only meaningful access boundary | Rejected |
| Filesystem request/response mailbox | Inspectable and requires no listener | Polling latency, stale files, race-prone concurrency, and additional sensitive artifacts | Rejected |

Node documents `net.Socket` as the common abstraction for TCP and IPC, with Unix domain sockets on
Unix and named pipes on Windows. IPC listeners default to `readableAll: false` and
`writableAll: false`. (https://nodejs.org/api/net.html, fetched 2026-09-08)

VS Code starts an `McpStdioServerDefinition` process as a child of the extension host. Workspace
extensions run on the workspace machine in remote environments, so the selected IPC topology keeps
the extension and bundled child co-located. Remote support still requires the real-host test named
in Non-goals before documentation claims it.
(https://code.visualstudio.com/api/references/vscode-api#McpStdioServerDefinition,
fetched 2026-09-08;
https://code.visualstudio.com/api/advanced-topics/remote-extensions, fetched 2026-09-08)

## Architecture

```text
VS Code MCP client
    | MCP JSON-RPC over subprocess stdio
    v
bundled bookmarks-plus MCP process
    | private bridge v1 over local IPC
    v
LiveMcpBridgeService in the Bookmarks Plus extension host
    | direct typed calls
    +--> WorkspaceBookmarkStore (one selected attached partition)
    +--> BookmarkStore (global)
```

Activation creates `LiveMcpBridgeService` after both stores are ready and before native provider
registration. The service owns the listener, activation generation, pending bootstrap grants, active
sessions, protocol decoding, and store adapter. It exposes only internal descriptor issuance and
disposal methods in #129.

The MCP subprocess selects its backend at startup:

- A complete live-bridge environment selects `LiveBookmarkBackend`.
- No live-bridge environment selects `MirrorBookmarkBackend` and preserves standalone behavior.
- A partial or malformed live-bridge environment is an explicit startup error; it does not fall
  through to mirror mode.

This keeps the standalone package independent from extension source code, matching the existing
package boundary. (`docs/superpowers/specs/2026-08-09-mcp-dynamic-workspace-resolution.md:L196-L210`)

### Component boundaries

`LiveMcpBridgeService`:

- Opens and closes the per-activation listener.
- Issues pending grants for current attached roots.
- Atomically validates and consumes bootstrap tokens.
- Creates authenticated sessions with immutable root and scope grants.
- Validates every bridge request before calling a store.
- Invalidates pending grants and sessions for an unavailable selected root.
- Stops all activity during extension disposal.

`LiveMcpBridgeClient` in the bundled server:

- Reads the endpoint and raw token from environment variables.
- Authenticates before allowing MCP initialization to complete.
- Correlates concurrent bridge requests and responses.
- Converts bridge errors into safe MCP initialization or tool errors.
- Closes the bridge socket when stdio closes.

`BookmarkBackend` in the MCP server:

```ts
interface BookmarkBackend {
  readonly mode: 'mirror' | 'live';
  list(): Promise<ScopedBookmarkResult>;
  add(input: AddBookmarkInput): Promise<AddBookmarkResult>;
  close(): Promise<void>;
}
```

Tool registration depends only on this interface. Mirror parsing, atomic file writes, and
write-survival verification remain private to `MirrorBookmarkBackend`. Bridge framing and
correlation remain private to `LiveBookmarkBackend`.

## Native provider and late bootstrap issuance

`provideMcpServerDefinitions()` is called eagerly, while `resolveMcpServerDefinition()` is called
when VS Code needs to start a server and permits last-moment authentication work. VS Code retains
the objects returned by enumeration and passes the retained object to resolution. Therefore the
provider must not create bootstrap tokens while enumerating definitions or mutate an enumerated
definition during resolution.
(https://code.visualstudio.com/api/references/vscode-api#McpServerDefinitionProvider,
fetched 2026-09-09;
https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostMcp.ts,
fetched 2026-09-09)

Provider flow:

1. `provideMcpServerDefinitions()` returns one unauthenticated definition per available attached
   root, preserving the current labels and server count.
2. The definition carries a non-secret canonical root URI so the resolve hook can identify and
   revalidate the intended root without relying on object identity or display labels. Enumeration
   places it in `BOOKMARKS_PLUS_ROOT_URI` together with `BOOKMARKS_PLUS_LIVE_MODE=1`.
3. `resolveMcpServerDefinition()` rechecks extension state, root attachment, bridge generation, and
   bridge readiness.
4. It asks the bridge service for a 60-second grant with `['workspace', 'global']`.
5. It constructs and returns a new `McpStdioServerDefinition` for every resolve. The new definition
   copies all applicable base fields from the supplied definition, including `label`, `command`,
   `version`, and `cwd`, while using fresh `args` and `env` containers. Its environment adds
   `BOOKMARKS_PLUS_BRIDGE_ENDPOINT`, `BOOKMARKS_PLUS_BRIDGE_PROTOCOL`,
   `BOOKMARKS_PLUS_BRIDGE_GENERATION`, and `BOOKMARKS_PLUS_BRIDGE_TOKEN`. Only the token value is
   authorization material. The future #138 descriptor lists only `BOOKMARKS_PLUS_BRIDGE_TOKEN` in
   `sensitiveEnvKeys`. The supplied enumerated definition remains token-free and unmodified.
6. If resolution fails after grant issuance, the provider revokes that grant. If the supplied
   cancellation token is observably cancelled before resolution returns, the provider revokes the
   grant and does not return the resolved definition.
7. A successfully returned definition whose process launch is later abandoned has no observable
   provider callback. Its unused grant remains pending until the 60-second expiry, after which
   request-time validation or the cleanup timer removes it. The current VS Code extension host calls
   the resolver with `CancellationToken.None`, so expiry is the required cleanup path for abandoned
   successful resolutions.
   (https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostMcp.ts,
   fetched 2026-09-09)

The future #138 service adapter will call the same internal grant issuer after validating its public
request. It will not reach into the native provider. (#138;
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L336-L359`)

## Endpoint construction

- The endpoint name is derived from a SHA-256 hash of VS Code's editor-session ID and the extension
  identity. It is stable across extension reactivation within one editor session, while the separate
  activation generation always changes. This lets a stale bootstrap that reaches a restarted
  listener receive `producer-restarted` rather than authenticate accidentally.
- Windows uses `\\.\pipe\bookmarks-plus-<session-hash>`.
- Unix uses a short deterministic directory under the operating-system temporary directory, sets
  the directory to owner-only access, and listens on `<directory>/bridge.sock` to stay below Unix
  socket path limits.
- The Unix socket is owner-only after bind. Clean disposal closes the server and removes the private
  directory. Startup validates the exact application-owned directory before removing a stale socket
  inside it; it never deletes the operating-system temporary directory or another broad parent.
- Endpoint names are routing data, not secrets or authorization. Every connection must authenticate
  with a valid bootstrap token.

VS Code documents `env.sessionId` as unique for the current editor session and changing each time
the editor starts. (https://code.visualstudio.com/api/references/vscode-api#env,
fetched 2026-09-08)

Node documents that Unix socket paths have operating-system length limits and may remain after a
crash, while Windows named pipes disappear when the final reference closes.
(https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections, fetched 2026-09-08)

## Bootstrap authorization

Each pending grant contains:

```ts
interface PendingBridgeGrant {
  readonly tokenDigest: string;
  readonly generation: string;
  readonly workspaceFolderUri: string;
  readonly owner: WorkspaceOwnerRef;
  readonly scopes: readonly ('workspace' | 'global')[];
  readonly expiresAt: number;
}
```

The bridge generates 32 random bytes with `crypto.randomBytes()`, passes the base64url token only to
the resolved subprocess environment, and retains only its SHA-256 digest. Node specifies
`randomBytes()` as generating cryptographically strong pseudorandom data.
(https://nodejs.org/api/crypto.html#cryptorandombytessize-callback, fetched 2026-09-08)

Handshake validation is one atomic state transition:

1. Parse and bound the first frame.
2. Hash the supplied token and remove the matching pending grant from the map before awaiting any
   later work.
3. Reject missing, expired, wrong-generation, unavailable-root, or unsupported-scope grants.
4. On success, create the active session from the removed immutable grant.

Removing before awaiting guarantees that simultaneous reuse attempts cannot both authenticate.
Expired grants are removed by request-time validation and a coarse cleanup timer. Bootstrap expiry
has no effect after the active session is created, matching the approved persistent-session
behavior. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L404-L424`)

The service retains a bounded digest-only retirement cache for recently expired and consumed grants
so immediate retries receive `bootstrap-expired` or `bootstrap-consumed`. The cache holds at most
4,096 entries for at most five minutes; oldest entries are evicted first. A token absent from both
pending and retirement maps is an invalid bootstrap and receives a generic `bridge-unavailable`
startup classification. The bridge service never retains raw tokens after constructing the fresh
resolved definition; the supplied enumerated definition remains token-free.

## Bridge protocol v1

The protocol is UTF-8 newline-delimited JSON. JSON strings escape embedded newlines, so one newline
terminates one frame. The decoder accepts either LF or CRLF by stripping one trailing carriage
return before JSON parsing. It must support partial frames and multiple frames per socket chunk.
Each frame is limited to 16 MiB; an oversized unterminated frame closes only that connection. The
limit bounds extension-host memory while leaving headroom for bookmark collections larger than
ordinary MCP tool results.

The first frame is always a handshake:

```json
{"kind":"hello","version":1,"generation":"...","token":"..."}
```

Success:

```json
{"kind":"ready","version":1,"sessionId":"...","workspaceFolderUri":"...","grantedScopes":["workspace","global"]}
```

After readiness, the client sends requests with a session-local unique ID:

```json
{"kind":"request","id":"1","sessionId":"...","workspaceFolderUri":"...","method":"list","params":{}}
{"kind":"request","id":"2","sessionId":"...","workspaceFolderUri":"...","method":"add","params":{"scope":"global","uri":"file:///...","type":"file"}}
```

The extension returns exactly one response for each accepted ID:

```json
{"kind":"response","id":"1","result":{}}
{"kind":"response","id":"2","error":{"code":"duplicate-bookmark","message":"..."}}
```

The selected root and session ID travel with every request even though the socket is already bound
to the session. The extension compares them with the immutable session before dispatch, preserving
the contract requirement that every mutation carries and revalidates the selected root.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L523-L531`)

The extension and subprocess have independent runtime decoders so the standalone package does not
import extension source. A canonical bridge-v1 JSON schema and shared valid/invalid wire fixtures
are committed under `schemas/` and copied into the server's build-test inputs using the repository's
existing schema-copy pattern. Both test suites must accept and reject the same fixtures.
(`mcp-server/scripts/copy-schema.mjs:L1-L24`, `mcp-server/test/copySchema.test.ts:L1-L85`)

## MCP initialization gate

The live client begins connecting as the subprocess starts. A small transport wrapper sits around
`StdioServerTransport` and holds the MCP `initialize` request until the bridge handshake completes:

- On success, it forwards the untouched initialize request to the MCP SDK, which performs normal
  version and capability negotiation.
- On failure, it sends one JSON-RPC initialization error with
  `data.bookmarksPlusCode`, closes stdio, and exits nonzero.
- It never forwards tool discovery or tool calls before initialization succeeds.

This preserves the SDK's normal initialization implementation while satisfying the approved rule
that the subprocess prove and consume its bootstrap before reporting MCP success.
(`mcp-server/src/index.ts:L1-L98`;
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L395-L443`)

Initialization codes remain the approved set:

- `bootstrap-expired`
- `bootstrap-consumed`
- `producer-restarted`
- `workspace-folder-unavailable`
- `scope-unavailable`
- `bridge-unavailable`

## Tool behavior

### `list_bookmarks`

The tool retains top-level `collections` and `items` arrays. Every record adds
`scope: 'workspace' | 'global'`.

A live result contains:

```ts
interface LiveListResult {
  readonly version: number;
  readonly workspaceFolderUri: string;
  readonly grantedScopes: readonly ('workspace' | 'global')[];
  readonly collections: readonly (BookmarkCollection & { readonly scope: BookmarkScope })[];
  readonly items: readonly (BookmarkItem & { readonly scope: BookmarkScope })[];
}
```

Workspace records precede global records, and each scope retains its store order. The live result
does not contain `workspacePath` or `mirrorPath`. Sessions see only granted scopes.

Mirror-backed results retain their existing `workspacePath`, `mirrorPath`, `version`, collections,
and items. Adding `scope: 'workspace'` to each record is an additive compatibility change; no
existing property is removed or reinterpreted. (#129;
`mcp-server/src/tools/list.ts:L60-L92`)

### `add_bookmark`

The existing input gains `scope?: 'workspace' | 'global'`.

- One granted scope plus omitted `scope`: use that scope.
- Both scopes plus omitted `scope`: use `workspace`.
- Explicit ungranted scope: `scope-unavailable`; no mutation.
- Resolve `collectionId` or `collectionName` only inside the selected scope.
- Workspace scope: the proposed URI must resolve to the session's selected attached partition.
- Global scope: the URI may be outside the selected root.
- The store-level add input gains normalized optional `description` support so live adds preserve
  the existing MCP field in both scopes.
- Success has this exact common shape:

  ```ts
  interface AddBookmarkResult {
    readonly id: string;
    readonly scope: BookmarkScope;
    readonly collection:
      | (BookmarkCollection & { readonly scope: BookmarkScope })
      | null;
  }
  ```

  When a collection is returned, its nested `scope` equals the top-level bookmark `scope`, so the
  collection retains its provenance when consumed independently. An uncollected bookmark returns
  `collection: null` and is identified by the top-level scope.

Mirror mode grants only workspace scope, preserves the current write-and-verify behavior and
existing `mirrorPath`, and adds workspace scope to both the top level and any returned collection.
Its exact payload is `AddBookmarkResult & { readonly mirrorPath: string }`. Live mode returns
`AddBookmarkResult` and never writes or verifies a mirror.
(#129; `mcp-server/src/tools/add.ts:L216-L225`)

## Store integration and concurrency

Each authenticated socket processes requests in arrival order. Request IDs still correlate results
and allow the client implementation to accept concurrent callers without confusing responses.

Across sessions:

- `WorkspaceBookmarkStore` continues using its existing mutation queue and partition boundary
  checks. The live adapter resolves the selected attached partition once at authentication and
  revalidates attachment before every operation.
- `BookmarkStore` changes to clone-validate-persist-commit serialization for every mutation. The
  queue lives inside the store so UI commands and MCP calls share it. Failed persistence leaves the
  previously committed snapshot visible.
- Reads return cloned committed data. A read after an earlier request on the same socket observes
  that earlier mutation. A read concurrent with another session's mutation may observe the complete
  state immediately before or after that commit, never a partially mutated object.
- Workspace and global collection identifiers are resolved within their explicit scopes, so an ID
  collision cannot cross stores.

The workspace store's current queue is the reference commit model.
(`src/workspaceBookmarkStore.ts:L857-L877`)

## Lifecycle

| Event | Pending grant | Active session | Subprocess |
| --- | --- | --- | --- |
| Bootstrap reaches 60 seconds | Removed; authentication returns `bootstrap-expired` when distinguishable | No effect | Startup fails if not already authenticated |
| Resolve succeeds but launch is abandoned | Remains pending until 60-second expiry and cleanup | Not created | Never starts |
| Same token reused | Second attempt returns `bootstrap-consumed` when distinguishable | First session unaffected | Reusing process fails initialization |
| Consumer closes stdio | Not applicable | Socket closes and resources release | Exits normally |
| Subprocess crashes | Not applicable | Socket close releases session | Already exited |
| Unrelated root changes | Remains valid | Remains connected | Continues |
| Selected root removed or unavailable | Revoked | Bridge closes socket | Closes stdout and exits |
| Extension disposal or reload | All revoked | Listener and sockets close | Observes bridge close and exits |
| Listener startup failure | No grants issued | None | Native definition resolution fails closed |

There is no heartbeat, inactivity timeout, or active-session lease. Socket liveness is the session
liveness signal. This supports clients that connect once and remain active for a long-running Claude
or VS Code session. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L595-L623`)

Shutdown order:

1. Mark the bridge as stopping so provider resolution and handshakes fail.
2. Revoke pending grants.
3. Close the listener so no new socket is accepted.
4. Close active session sockets.
5. Await in-flight store operations already admitted.
6. Continue the existing mirror drain and store disposal sequence.

`deactivate()` already fences new workspace reconciliation and drains mirrors before disposing stores;
the bridge is inserted before store disposal so no live call reaches a disposed store.
(`src/extension.ts:L476-L488`)

## Errors and diagnostics

Bridge protocol errors use stable codes:

- Startup: the six approved initialization codes above.
- Operations: `invalid-request`, `invalid-session`, `scope-unavailable`,
  `workspace-folder-unavailable`, `collection-not-found`, `duplicate-bookmark`,
  `bookmark-outside-root`, `payload-too-large`, `store-unavailable`, and `internal-error`.

Expected errors return safe messages and do not reject unrelated requests. Unexpected exceptions map
to `internal-error`; detailed local output contains only error category, session ID, and partition ID
when relevant. It never logs tokens, endpoint values, bookmark URIs, names, descriptions, collection
names, or raw frames. One malformed or oversized connection is closed without stopping the listener
or other sessions. This follows the existing privacy rule for workspace partition diagnostics.
(`docs/superpowers/specs/2026-09-07-multi-root-workspace-partitioning-design.md:L229-L231`,
`docs/superpowers/specs/2026-09-07-multi-root-workspace-partitioning-design.md:L414-L430`;
#129)

## Workspace Trust and caller trust

The bridge starts only when the workspace is trusted. #129 does not export a caller-facing method,
so its immediate clients are definitions produced by Bookmarks Plus itself. #138 will apply the
approved same-extension-host caller trust model and explicit manifest declarations when it exposes
descriptor issuance to other extensions.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L361-L393`;
#138)

The endpoint is not a trust boundary. The single-use token authenticates the subprocess and binds it
to an immutable root, scopes, expiry, and activation generation. A process that discovers only the
pipe or socket name receives no data.

## Verification strategy

### Protocol unit tests

- Partial frames, combined frames, LF and CRLF delimiters, malformed JSON, unknown versions,
  unknown message kinds, duplicate IDs, and 16 MiB enforcement.
- Canonical schema fixtures accepted and rejected identically by extension and server decoders.
- Client correlation for concurrent requests and safe rejection of pending calls on socket close.

### Authentication and lifecycle tests

- Valid bootstrap, expiry, atomic single-use consumption, wrong generation, wrong root, wrong scope,
  resolve failure after issuance, observable cancellation with a synthetic token, abandoned-success
  expiry, and service disposal. Abandoned-success expiry is the required VS Code lifecycle path.
- A persistent session remains valid beyond bootstrap expiry.
- Selected-root removal closes only matching sessions; unrelated add/remove/reorder changes do not.
- Extension shutdown closes the listener and every socket, and admitted store operations finish
  before store disposal.

### Store and tool tests

- Workspace and global list results contain explicit scope and stable ordering.
- Both-scope, one-scope, omitted-scope, and ungranted-scope add behavior, including exact workspace
  and global result shapes and matching nested collection scope.
- Same collection ID in both stores resolves only within the selected scope.
- Workspace URI containment and global URIs outside the selected root.
- Concurrent global UI/MCP mutations serialize without lost updates; persistence failure does not
  publish an uncommitted snapshot.
- Mirror-backed list/add fixtures retain current fields and behavior with only additive scope data.

### Integration and packaging tests

- Native provider enumeration contains no token; resolve issues a fresh token and revalidates root
  state at start time. Resolving the same enumerated definition twice leaves that definition
  token-free, returns distinct single-use tokens in separate fresh definitions, and does not let the
  second resolve alter the first result's `args` or `env`.
- A packaged extension launches the bundled server, completes MCP initialization through the live
  bridge, lists both scopes, adds to each store, and observes the committed extension state.
- Bridge rejection prevents MCP initialization and never creates or mutates a mirror.
- Stdio closure and extension disposal terminate the bundled process.
- The standalone server builds, tests, packs, and runs without extension source files or live
  environment variables.
- Windows executes a real named-pipe integration test. Unix endpoint construction and cleanup run in
  platform CI where available. A real remote extension-host test remains the gate for documenting
  remote support.

## Expected implementation surface

The implementation plan assigns these ownership boundaries:

- New extension modules: bridge service plus extension-side protocol decoder.
- Existing extension stores: serialized global commits and optional add-description persistence.
  (`src/bookmarkStore.ts`, `src/workspaceBookmarkStore.ts`)
- Existing activation and provider integration: service construction, shutdown, unauthenticated
  enumeration, and late resolution. (`src/extension.ts`, `src/mcpServerProvider.ts`)
- New server modules: backend contract, mirror adapter, live IPC client, and initialization gate.
- Existing server tools: backend use and explicit scopes.
  (`mcp-server/src/tools/list.ts`, `mcp-server/src/tools/add.ts`)
- New canonical bridge-v1 schema and fixtures under `schemas/`, with drift tests beside the existing
  extension and server tests.
- `README.md` and `mcp-server/README.md`: native live/global behavior, standalone mirror behavior,
  scope fields, startup failures, and the remote-support boundary.
- Unit, integration, packaging, and extension-host tests in the existing test trees.

## Acceptance mapping

| #129 acceptance criterion | Design coverage |
| --- | --- |
| Compare IPC transports | Transport comparison |
| Document lifecycle, authentication, and failure behavior | Bootstrap authorization, MCP initialization gate, Lifecycle, Errors and diagnostics |
| List workspace and global bookmarks with explicit scope | Tool behavior: `list_bookmarks` |
| Apply mutations through extension-owned stores | Architecture, Tool behavior, Store integration and concurrency |
| Deterministic shutdown, reload, and stale sessions | Lifecycle |
| Reconnect, shutdown, concurrency, and isolation tests | Verification strategy |
| Preserve external Claude/npm behavior | Architecture, Tool behavior, Integration and packaging tests |
