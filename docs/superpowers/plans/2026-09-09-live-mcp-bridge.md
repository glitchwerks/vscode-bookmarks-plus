# Live MCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make VS Code-native MCP sessions read and mutate live workspace and global bookmarks while preserving mirror-backed standalone behavior.

**Architecture:** The extension owns one authenticated local IPC bridge per activation. Native MCP subprocesses receive a short-lived root-bound bootstrap at resolve time, authenticate over newline-delimited JSON, and use a live backend; standalone launches keep the mirror backend. Tool registration depends only on a backend interface, and MCP initialization stays behind an absolute 10-second bridge-handshake gate.

**Tech Stack:** TypeScript 5.4, VS Code Extension API 1.101, Node.js IPC streams, MCP TypeScript SDK 1.30.0, Zod 4.4.3, Mocha, Node test runner, esbuild.

**Spec:** docs/superpowers/specs/2026-09-08-live-mcp-bridge-design.md

## Global Constraints

- Implement Issue #129 only; the public cross-extension API in #138 remains out of scope. Source: spec:L62-L73; #129; #138.
- Native sessions receive workspace and global scopes; workspace access stays pinned to one attached root. Source: spec:L49-L60 and spec:L75-L94.
- Standalone npm and Claude launches remain mirror-backed and never gain access to VS Code globalState. Source: spec:L11-L17 and spec:L62-L73.
- Bootstrap tokens are 32 random bytes, single-use, digest-only in bridge state, and expire after 60 seconds. Source: spec:L250-L288.
- Active sessions have no heartbeat, inactivity timeout, or lease. Source: spec:L462-L491.
- The private protocol is UTF-8 NDJSON, accepts LF and CRLF, and rejects frames larger than 16 MiB. Source: spec:L290-L334.
- Native startup fails closed; partial live environment configuration never falls back to mirror mode. Source: spec:L129-L142 and spec:L336-L377.
- The bridge handshake has one absolute 10-second client-side deadline that partial traffic cannot extend. Source: spec:L75-L94 and spec:L336-L371.
- Global and workspace writes use clone-validate-persist-commit queues; failed persistence cannot publish an uncommitted snapshot. Source: spec:L440-L460.
- Keep the existing public tool names and existing mirror payload fields; scope fields are additive. Source: spec:L379-L437.
- Do not document remote-host support until the packaged remote test exists. Source: spec:L62-L73 and spec:L555-L576.
- Use TDD for every behavior change and commit after every task. Source: repository AGENTS.md Testing and Git Commits sections.

---

## File Structure

### Canonical wire contract

- Create schemas/live-mcp-bridge-v1.schema.json: canonical bridge-v1 message schema.
- Create schemas/live-mcp-bridge-v1.fixtures.json: named valid and invalid wire values shared by both packages.
- Create src/liveMcpBridgeProtocol.ts: extension-side frame decoder, encoder, message types, and limits.
- Create mcp-server/src/liveBridgeProtocol.ts: independent server-side decoder with the same wire contract.
- Create src/test/suite/liveMcpBridgeProtocol.test.ts and mcp-server/test/liveBridgeProtocol.test.ts: decoder and framing tests.
- Modify mcp-server/scripts/copy-schema.mjs, mcp-server/scripts/copy-test-fixtures.mjs, mcp-server/test/copySchema.test.ts, and mcp-server/test/copyTestFixtures.test.ts: copy and verify the new tracked artifacts without leaking fixtures into production builds.

### Store commit boundary

- Modify src/bookmarkStore.ts and src/workspaceBookmarkStore.ts: normalized add descriptions, defensive reads, and serialized global commits.
- Modify src/test/suite/bookmarkStore.test.ts and src/test/suite/workspaceBookmarkStore.test.ts: persistence-failure, concurrency, cloning, and description coverage.

### MCP server backends

- Create mcp-server/src/backend.ts: BookmarkBackend and scoped result contracts.
- Create mcp-server/src/mirrorBackend.ts: current mirror read/add/retry behavior behind BookmarkBackend.
- Modify mcp-server/src/tools/list.ts, mcp-server/src/tools/add.ts, and mcp-server/src/index.ts: tools consume a backend instead of mirror files directly.
- Create mcp-server/test/mirrorBackend.test.ts and modify mcp-server/test/list.test.ts, mcp-server/test/add.test.ts, and mcp-server/test/index.test.ts: mirror compatibility and backend-focused tool tests.

### Extension bridge

- Create src/liveMcpBridgeService.ts: endpoint ownership, grant issuance, authentication, sessions, live store dispatch, ordering, and shutdown.
- Create src/test/suite/liveMcpBridgeService.test.ts: real IPC, authorization, isolation, concurrency, and lifecycle tests.

### Provider and activation

- Modify src/mcpServerProvider.ts and src/test/suite/mcpServerProvider.test.ts: token-free enumeration and fresh resolved definitions.
- Modify src/extension.ts, src/test/suite/extension.globalStore.test.ts, and src/test/suite/extension.test.ts: trusted activation, partition invalidation, and shutdown ordering.

### Bundled live client

- Create mcp-server/src/runtimeMode.ts: strict live/mirror/disabled startup selection.
- Create mcp-server/src/liveBridgeClient.ts: bridge handshake, correlation, deadline, and LiveBookmarkBackend.
- Create mcp-server/src/initializationGate.ts: MCP transport wrapper that buffers initialize until bridge readiness.
- Create mcp-server/test/runtimeMode.test.ts, mcp-server/test/liveBridgeClient.test.ts, and mcp-server/test/initializationGate.test.ts: startup, transport, timeout, and error tests.

### Integration and documentation

- Modify scripts/packaged-native-mcp-suite.cjs and scripts/test-packaged-native-mcp.mjs: packaged live workspace/global verification.
- Modify scripts/test-bundled-mcp.mjs if its standalone assertions need the new additive scope fields.
- Modify README.md and mcp-server/README.md: native live behavior, standalone mirror behavior, scope shape, failure semantics, and remote boundary.
- Modify mcp-server/test/packaging.test.ts and mcp-server/test/verifyPack.test.ts: assert all compiled live-bridge modules ship while test fixtures and extension source do not.
- Modify CHANGELOG.md: replace the unreleased workspace-only native limitation with the shipped live workspace/global behavior.

These boundaries implement the surface approved in spec:L578-L594.

---

### Task 1: Canonical Bridge-v1 Schema, Fixtures, and Decoders

**Files:**
- Create: schemas/live-mcp-bridge-v1.schema.json
- Create: schemas/live-mcp-bridge-v1.fixtures.json
- Create: src/liveMcpBridgeProtocol.ts
- Create: src/test/suite/liveMcpBridgeProtocol.test.ts
- Create: mcp-server/src/liveBridgeProtocol.ts
- Create: mcp-server/test/liveBridgeProtocol.test.ts
- Modify: mcp-server/scripts/copy-schema.mjs
- Modify: mcp-server/scripts/copy-test-fixtures.mjs
- Modify: mcp-server/test/copySchema.test.ts
- Modify: mcp-server/test/copyTestFixtures.test.ts

**Interfaces:**
- Produces in both protocol modules:

~~~ts
export const LIVE_BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_LIVE_BRIDGE_FRAME_BYTES = 16 * 1024 * 1024;
export type BridgeStartupCode =
  | 'bootstrap-expired'
  | 'bootstrap-consumed'
  | 'producer-restarted'
  | 'workspace-folder-unavailable'
  | 'scope-unavailable'
  | 'bridge-unavailable';
export type BridgeOperationCode =
  | 'invalid-request'
  | 'invalid-session'
  | 'scope-unavailable'
  | 'workspace-folder-unavailable'
  | 'collection-not-found'
  | 'duplicate-bookmark'
  | 'bookmark-outside-root'
  | 'payload-too-large'
  | 'store-unavailable'
  | 'internal-error';
export interface BridgeHello {
  kind: 'hello';
  version: 1;
  generation: string;
  token: string;
}
export interface BridgeReady {
  kind: 'ready';
  version: 1;
  sessionId: string;
  workspaceFolderUri: string;
  grantedScopes: BookmarkScope[];
}
export interface BridgeRequest {
  kind: 'request';
  id: string;
  sessionId: string;
  workspaceFolderUri: string;
  method: 'list' | 'add';
  params: Record<string, unknown>;
}
export interface BridgeResponse {
  kind: 'response';
  id: string;
  result?: unknown;
  error?: { code: BridgeStartupCode | BridgeOperationCode; message: string };
}
export class NdjsonFrameDecoder {
  push(chunk: Buffer): string[];
  finish(): void;
}
export function encodeBridgeMessage(value: object): string;
~~~

- The extension protocol imports the existing BookmarkScope from src/types.ts. The server protocol
  exports its own BookmarkScope = 'workspace' | 'global'; Task 3 re-exports that exact type rather
  than declaring a competing union.
- Extension decoder produces decodeClientBridgeMessage(value): BridgeHello | BridgeRequest.
- Server decoder produces decodeServerBridgeMessage(value): BridgeReady | BridgeResponse.
- Later tasks consume these names exactly.

Source: spec:L290-L334 and spec:L494-L509.

- [ ] **Step 1: Write failing schema-copy and decoder tests**

Create fixtures with these exact named cases:

~~~json
{
  "validClient": [
    { "name": "hello", "value": { "kind": "hello", "version": 1, "generation": "g1", "token": "token" } },
    { "name": "list", "value": { "kind": "request", "id": "1", "sessionId": "s1", "workspaceFolderUri": "file:///root", "method": "list", "params": {} } },
    { "name": "global-add", "value": { "kind": "request", "id": "2", "sessionId": "s1", "workspaceFolderUri": "file:///root", "method": "add", "params": { "scope": "global", "uri": "file:///target", "type": "file" } } }
  ],
  "validServer": [
    { "name": "ready", "value": { "kind": "ready", "version": 1, "sessionId": "s1", "workspaceFolderUri": "file:///root", "grantedScopes": ["workspace", "global"] } },
    { "name": "result", "value": { "kind": "response", "id": "1", "result": { "items": [], "collections": [] } } },
    { "name": "error", "value": { "kind": "response", "id": "2", "error": { "code": "scope-unavailable", "message": "Scope is unavailable." } } }
  ],
  "invalidClient": [
    { "name": "wrong-version", "value": { "kind": "hello", "version": 2, "generation": "g1", "token": "token" } },
    { "name": "missing-session", "value": { "kind": "request", "id": "1", "workspaceFolderUri": "file:///root", "method": "list", "params": {} } },
    { "name": "unknown-method", "value": { "kind": "request", "id": "1", "sessionId": "s1", "workspaceFolderUri": "file:///root", "method": "delete", "params": {} } }
  ],
  "invalidServer": [
    { "name": "empty-scopes", "value": { "kind": "ready", "version": 1, "sessionId": "s1", "workspaceFolderUri": "file:///root", "grantedScopes": [] } },
    { "name": "result-and-error", "value": { "kind": "response", "id": "1", "result": {}, "error": { "code": "internal-error", "message": "bad" } } },
    { "name": "unknown-code", "value": { "kind": "response", "id": "1", "error": { "code": "unknown", "message": "bad" } } }
  ]
}
~~~

In each decoder suite, read the committed fixture, accept its side's valid values, and reject its side's invalid values. Add frame tests for split UTF-8, two frames in one chunk, LF, CRLF, malformed JSON, finish with an incomplete frame, and a 16 MiB plus one byte unterminated frame. Extend the copy tests to assert the schema reaches dist/live-mcp-bridge-v1.schema.json, the fixture reaches dist/test/fixtures only during tests, and a production schema copy never creates dist/test.

- [ ] **Step 2: Run the tests and verify the red state**

Run:

~~~bash
npm run compile-tests
npm --prefix mcp-server test
~~~

Expected: compilation or tests fail because the new protocol modules and copied artifacts do not exist.

- [ ] **Step 3: Add the canonical JSON schema and both independent decoders**

The schema must use oneOf for hello, ready, request, and response; set additionalProperties to false on envelopes; require exactly one of result or error on response; restrict protocol version to 1; restrict scopes and error codes to the unions above; and leave result/params payload bodies open for method-specific validation in later tasks.

Implement NdjsonFrameDecoder with a StringDecoder('utf8'), byte-count the buffered unterminated frame, strip one trailing carriage return, and throw a typed payload-too-large error before the buffer can exceed 16 MiB. Do not import either runtime decoder across the extension/package boundary.

- [ ] **Step 4: Update copy scripts**

copy-schema.mjs copies both tracked schemas into dist and never writes under dist/test. copy-test-fixtures.mjs copies the bridge fixture into dist/test/fixtures along with the existing mirror fixtures. Update the isolated copy-script tests with both new source files.

- [ ] **Step 5: Run protocol verification**

Run:

~~~bash
npm test
npm --prefix mcp-server test
~~~

Expected: both suites pass the same fixtures and framing cases.

- [ ] **Step 6: Commit**

~~~bash
git add schemas/live-mcp-bridge-v1.schema.json schemas/live-mcp-bridge-v1.fixtures.json src/liveMcpBridgeProtocol.ts src/test/suite/liveMcpBridgeProtocol.test.ts mcp-server/src/liveBridgeProtocol.ts mcp-server/test/liveBridgeProtocol.test.ts mcp-server/scripts/copy-schema.mjs mcp-server/scripts/copy-test-fixtures.mjs mcp-server/test/copySchema.test.ts mcp-server/test/copyTestFixtures.test.ts
git commit -m "feat: define live MCP bridge protocol"
~~~

### Task 2: Atomic Store Reads and Mutations

**Files:**
- Modify: src/bookmarkStore.ts
- Modify: src/workspaceBookmarkStore.ts
- Modify: src/test/suite/bookmarkStore.test.ts
- Modify: src/test/suite/workspaceBookmarkStore.test.ts

**Interfaces:**
- AddItemInput gains description?: string.
- BookmarkStore.getAll() and WorkspaceBookmarkStore.getOwnerData() return defensive copies.
- BookmarkStore mutation signatures remain unchanged.

Source: src/bookmarkStore.ts:L27-L31, src/bookmarkStore.ts:L46-L127, src/workspaceBookmarkStore.ts:L241-L247, src/workspaceBookmarkStore.ts:L373-L400, and spec:L440-L460.

- [ ] **Step 1: Write failing global-store atomicity tests**

Add tests proving:

~~~ts
const first = store.getAll();
first.items.push({ id: 'outside', type: 'file', uri: 'file:///outside', collectionId: null, order: 0 });
assert.strictEqual(store.getAll().items.length, 0);

const firstAdd = store.addItem({ type: 'file', uri: 'file:///a' });
const secondAdd = store.addItem({ type: 'file', uri: 'file:///b' });
await Promise.all([firstAdd, secondAdd]);
assert.deepStrictEqual(store.getAll().items.map(item => item.order), [0, 1]);
~~~

Use a controllable Memento whose first update is held. Assert the second update does not begin until the first settles. Configure the held update to reject and assert data, events, and subsequent successful operations still reflect only committed snapshots.

- [ ] **Step 2: Write failing description tests for both stores**

Call addItem with description containing surrounding whitespace. Assert the returned item and persisted item contain the trimmed value. Call with whitespace-only description and assert the property is absent.

- [ ] **Step 3: Run the extension suite and verify failures**

Run:

~~~bash
npm test
~~~

Expected: defensive-read, serialization, persistence-failure, and add-description assertions fail against the current global store.

- [ ] **Step 4: Implement clone-validate-persist-commit in BookmarkStore**

Add a local cloneData helper, an operationTail initialized to Promise.resolve(), a disposed flag, and this exact commit shape:

~~~ts
private enqueue<T>(operation: (draft: BookmarkData) => { value: T; changed: boolean }): Promise<T> {
  const run = this.operationTail.then(async () => {
    this.assertAvailable();
    const draft = cloneData(this.data);
    const outcome = operation(draft);
    if (!outcome.changed) return outcome.value;
    if (!isCompleteBookmarkData(draft)) throw new Error('Global bookmark draft is invalid.');
    await this.state.update(STORAGE_KEY, draft);
    this.data = draft;
    this._onBookmarksChanged.fire();
    return outcome.value;
  });
  this.operationTail = run.then(() => undefined, () => undefined);
  return run;
}
~~~

Convert addItem, removeItem, addCollection, moveItem, renameCollection, setItemDescription, setCollectionDescription, and deleteCollection to mutate only the queued draft. getAll returns cloneData(this.data). dispose marks the store unavailable and disposes the emitter.

Define isCompleteBookmarkData locally from the existing validators:

~~~ts
function isCompleteBookmarkData(value: unknown): value is BookmarkData {
  return isValidBookmarkData(value)
    && value.items.every(isValidBookmarkItem)
    && value.collections.every(isValidBookmarkCollection);
}
~~~

- [ ] **Step 5: Add normalized description to both add paths**

Normalize input.description once while constructing the item and spread the property only when defined. Keep duplicate, collection, order, and workspace-boundary checks unchanged.

- [ ] **Step 6: Run store and full extension verification**

Run:

~~~bash
npm test
~~~

Expected: all extension tests pass, including concurrent global writes and failed-persistence rollback.

- [ ] **Step 7: Commit**

~~~bash
git add src/bookmarkStore.ts src/workspaceBookmarkStore.ts src/test/suite/bookmarkStore.test.ts src/test/suite/workspaceBookmarkStore.test.ts
git commit -m "refactor: serialize bookmark store commits"
~~~

### Task 3: Backend Contract and Mirror Compatibility

**Files:**
- Create: mcp-server/src/backend.ts
- Create: mcp-server/src/mirrorBackend.ts
- Create: mcp-server/test/mirrorBackend.test.ts
- Modify: mcp-server/src/tools/list.ts
- Modify: mcp-server/src/tools/add.ts
- Modify: mcp-server/src/index.ts
- Modify: mcp-server/test/list.test.ts
- Modify: mcp-server/test/add.test.ts
- Modify: mcp-server/test/index.test.ts

**Interfaces:**

~~~ts
import type {
  BookmarkScope,
  BridgeOperationCode
} from './liveBridgeProtocol.js';
export type { BookmarkScope };
export type ScopedBookmarkItem = BookmarkItem & { scope: BookmarkScope };
export type ScopedBookmarkCollection = BookmarkCollection & { scope: BookmarkScope };
export interface MirrorListResult {
  workspacePath: string;
  mirrorPath: string;
  version?: number;
  collections: ScopedBookmarkCollection[];
  items: ScopedBookmarkItem[];
}
export interface LiveListResult {
  version: number;
  workspaceFolderUri: string;
  grantedScopes: BookmarkScope[];
  collections: ScopedBookmarkCollection[];
  items: ScopedBookmarkItem[];
}
export type ScopedBookmarkResult = MirrorListResult | LiveListResult;
export interface AddBookmarkInput {
  uri: string;
  type: 'file' | 'folder';
  scope?: BookmarkScope;
  collectionId?: string;
  collectionName?: string;
  description?: string;
}
export interface AddBookmarkResult {
  id: string;
  scope: BookmarkScope;
  collection: ScopedBookmarkCollection | null;
}
export interface MirrorAddBookmarkResult extends AddBookmarkResult {
  mirrorPath: string;
}
export interface BookmarkBackend {
  readonly mode: 'mirror' | 'live';
  list(): Promise<ScopedBookmarkResult>;
  add(input: AddBookmarkInput): Promise<AddBookmarkResult>;
  close(): Promise<void>;
}
export class BackendError extends Error {
  constructor(readonly code: BridgeOperationCode, message: string);
}
export class MirrorBookmarkBackend implements BookmarkBackend {
  readonly mode = 'mirror';
}
~~~

Source: spec:L146-L180 and spec:L379-L437.

- [ ] **Step 1: Rewrite tool tests against a fake backend**

Use a fake backend that records add input and returns deterministic list/add payloads. Assert list_bookmarks returns backend.list unchanged. Assert add_bookmark exposes the optional scope schema, forwards all fields unchanged, and returns backend.add unchanged. Preserve isError mapping with a typed BackendError carrying a safe code and message.

- [ ] **Step 2: Add mirror-backend compatibility tests**

Move the existing mirror read/write/retry scenarios from tool tests to mirrorBackend.test.ts. Assert exact additive results:

~~~ts
assert.deepStrictEqual(result, {
  id: 'new-id',
  mirrorPath,
  scope: 'workspace',
  collection: { id: 'c1', name: 'Work', order: 0, scope: 'workspace' }
});
~~~

Also assert list keeps workspacePath, mirrorPath, version, collections, and items while adding scope: 'workspace' to every record. Explicit global scope must throw scope-unavailable without reading or writing the mirror.

- [ ] **Step 3: Run MCP tests and verify the red state**

Run:

~~~bash
npm --prefix mcp-server test
~~~

Expected: tests fail because BookmarkBackend and MirrorBookmarkBackend do not exist and tools still own mirror I/O.

- [ ] **Step 4: Extract MirrorBookmarkBackend**

Move parse, collection resolution, duplicate detection, atomic write, verification delay, and one retry from tools/add.ts into MirrorBookmarkBackend.add. Move list parsing and payload construction into MirrorBookmarkBackend.list. Keep existing error text where compatibility tests assert it. Mirror mode treats omitted or workspace scope as workspace and rejects global.

- [ ] **Step 5: Make tools backend-only**

createListHandler and createAddHandler receive BookmarkBackend | undefined plus disabledReason. Their handlers perform schema parsing, call the backend, serialize structuredContent, and map BackendError to an MCP tool error. Remove mirror filesystem dependencies from both tool modules.

Change createServer to:

~~~ts
export function createServer(
  backend: BookmarkBackend | undefined,
  options?: { disabledReason?: string }
): McpServer
~~~

main constructs MirrorBookmarkBackend only for the existing successful mirror configuration.

- [ ] **Step 6: Run compatibility verification**

Run:

~~~bash
npm --prefix mcp-server test
npm run test:mcp-bundle
~~~

Expected: standalone list/add behavior passes with only additive scope fields.

- [ ] **Step 7: Commit**

~~~bash
git add mcp-server/src/backend.ts mcp-server/src/mirrorBackend.ts mcp-server/src/tools/list.ts mcp-server/src/tools/add.ts mcp-server/src/index.ts mcp-server/test/list.test.ts mcp-server/test/add.test.ts mcp-server/test/index.test.ts mcp-server/test/mirrorBackend.test.ts
git commit -m "refactor: put MCP tools behind bookmark backend"
~~~

### Task 4: Bridge Endpoint and Bootstrap Authentication

**Files:**
- Create: src/liveMcpBridgeService.ts
- Create: src/test/suite/liveMcpBridgeService.test.ts

**Interfaces:**

~~~ts
export interface IssuedLiveBridgeGrant {
  readonly endpoint: string;
  readonly protocolVersion: 1;
  readonly generation: string;
  readonly token: string;
  revoke(): void;
}
export interface LiveMcpBridgeServiceOptions {
  readonly workspaceStore: WorkspaceBookmarkStore;
  readonly globalStore: BookmarkStore;
  readonly editorSessionId: string;
  readonly extensionId: string;
  readonly output: OutputSink;
  readonly getAttachedRoot: (canonicalRootUri: string) =>
    | { rootUri: string; canonicalRootUri: string; owner: WorkspaceOwnerRef }
    | undefined;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly createId?: () => string;
  readonly tempDirectory?: string;
}
export class LiveMcpBridgeService {
  static start(options: LiveMcpBridgeServiceOptions): Promise<LiveMcpBridgeService>;
  issueGrant(rootUri: string, scopes: readonly BookmarkScope[]): IssuedLiveBridgeGrant;
  refreshAvailableRoots(): void;
  stop(): Promise<void>;
}
~~~

Source: spec:L116-L162, spec:L226-L288, and spec:L462-L491.

- [ ] **Step 1: Write failing endpoint tests**

Assert the Windows endpoint matches the named-pipe form and the Unix endpoint stays under the injected private temporary directory. On Unix, verify owner-only directory/socket permissions, stale socket removal only inside the exact application-owned directory, cleanup after stop, and rejection when the expected directory resolves outside the injected parent.

- [ ] **Step 2: Write failing grant and handshake tests**

Use deterministic random bytes and a fake clock. Assert issueGrant returns a 32-byte base64url token, then use a test-only narrow cast of the service's TypeScript-private pending-grant map to verify that the entry contains only its SHA-256 digest and never the raw token. Do not add a production inspection API or ECMAScript-private field solely for this assertion. Cover valid hello, wrong generation, wrong root, wrong scope, 60-second expiry, same-token simultaneous reuse, explicit revoke, 4,096-entry retirement bound, and five-minute retirement expiry.

- [ ] **Step 3: Run extension tests and verify failures**

Run:

~~~bash
npm test
~~~

Expected: compilation fails because LiveMcpBridgeService does not exist.

- [ ] **Step 4: Implement endpoint lifecycle**

Derive the endpoint name from SHA-256(editorSessionId plus extensionId). Generate a fresh activation generation in start. On Unix, create a deterministic owner-only directory under tempDirectory, validate its resolved parent before stale cleanup, listen on bridge.sock, chmod the socket owner-only, and remove the owned directory after server close. On Windows, listen on the deterministic named pipe and do not perform filesystem cleanup.

- [ ] **Step 5: Implement digest-only grant state and atomic hello consumption**

Pending entries contain tokenDigest, generation, workspaceFolderUri, owner, immutable scopes, and expiresAt. Hash the raw token immediately; the returned revoke closure captures only the digest. During hello, remove the pending entry synchronously before awaiting any later action, validate it, then create the active session. Record expired and consumed digests in the bounded retirement cache. A cleanup timer removes expired pending and retired entries and is stopped during service shutdown.

- [ ] **Step 6: Run authentication verification**

Run:

~~~bash
npm test
~~~

Expected: endpoint and bootstrap tests pass on the current platform.

- [ ] **Step 7: Commit**

~~~bash
git add src/liveMcpBridgeService.ts src/test/suite/liveMcpBridgeService.test.ts
git commit -m "feat: authenticate live MCP bridge sessions"
~~~

### Task 5: Live Store Dispatch, Ordering, and Root Isolation

**Files:**
- Modify: src/liveMcpBridgeService.ts
- Modify: src/test/suite/liveMcpBridgeService.test.ts

**Interfaces:**
- LiveMcpBridgeService handles BridgeRequest method list and add after authentication.
- refreshAvailableRoots closes sessions and revokes pending grants only for roots no longer returned by getAttachedRoot.

Source: spec:L379-L460 and spec:L462-L491.

- [ ] **Step 1: Write failing list and scope tests**

Seed one workspace owner and the global store. Authenticate a session with both scopes and assert:

~~~ts
assert.deepStrictEqual(result.collections.map(value => value.scope), ['workspace', 'global']);
assert.deepStrictEqual(result.items.map(value => value.scope), ['workspace', 'global']);
assert.deepStrictEqual(result.grantedScopes, ['workspace', 'global']);
~~~

Assert workspace records precede global records, store order is preserved, workspacePath and mirrorPath are absent, and one-scope sessions see only their granted scope.

- [ ] **Step 2: Write failing add and isolation tests**

Cover both-scope omitted scope defaults to workspace; one-scope omission infers that scope; explicit ungranted scope fails without mutation; same collection ID in both stores resolves only in the selected scope; workspace URI outside the selected deepest root fails; global URI outside the root succeeds; description is preserved; collection results repeat scope; null collection keeps top-level scope.

- [ ] **Step 3: Write failing ordering and lifecycle tests**

Send two requests without awaiting the first and hold the first store write. Assert the second request does not begin until the first finishes. Run two sessions concurrently against global add and assert both committed items survive. Remove the selected root and call refreshAvailableRoots; assert only matching pending grants and sockets close. Reorder or add an unrelated root and assert the session remains connected beyond 60 seconds.

- [ ] **Step 4: Run extension tests and verify failures**

Run:

~~~bash
npm test
~~~

Expected: dispatch tests fail because authenticated sockets do not yet process requests.

- [ ] **Step 5: Implement per-session request dispatch**

Maintain one promise tail per active socket. Validate id uniqueness, sessionId, workspaceFolderUri, method, params, root availability, and scope before touching stores. list clones owner/global committed data and decorates every record. add resolves collection only inside the chosen store and maps DuplicateBookmarkError, PartitionBoundaryError, unavailable store, and unexpected errors to the stable operation codes from Task 1.

- [ ] **Step 6: Implement selective invalidation and shutdown**

refreshAvailableRoots revalidates every pending grant and active session through getAttachedRoot. Revoke or close only entries whose selected root is unavailable. stop marks the service stopping, clears timers and grants, closes the listener and sockets, waits for admitted per-session tails, and becomes idempotent.

- [ ] **Step 7: Run live dispatch verification**

Run:

~~~bash
npm test
~~~

Expected: live list/add, ordering, isolation, persistent-session, and shutdown tests pass.

- [ ] **Step 8: Commit**

~~~bash
git add src/liveMcpBridgeService.ts src/test/suite/liveMcpBridgeService.test.ts
git commit -m "feat: dispatch live bookmark bridge requests"
~~~

### Task 6: Native Provider Late Grant Resolution

**Files:**
- Modify: src/mcpServerProvider.ts
- Modify: src/test/suite/mcpServerProvider.test.ts

**Interfaces:**
- McpProviderDependencies gains issueGrant(rootUri, scopes) and isBridgeReady().
- provideMcpServerDefinitions remains token-free.
- resolveMcpServerDefinition returns a fresh vscode.McpStdioServerDefinition.

Source: src/mcpServerProvider.ts:L23-L69 and spec:L182-L220.

- [ ] **Step 1: Write failing enumeration and resolve tests**

Assert enumerated env is exactly:

~~~ts
{
  ELECTRON_RUN_AS_NODE: '1',
  BOOKMARKS_PLUS_LIVE_MODE: '1',
  BOOKMARKS_PLUS_ROOT_URI: 'file:///workspaces/project'
}
~~~

Resolve the same enumerated definition twice. Assert the original remains token-free, returned definitions are different objects, args and env containers are not shared, tokens differ, and mutating the second result cannot alter the first.

- [ ] **Step 2: Write failing failure/cancellation tests**

Remove the root between enumerate and resolve and assert no grant is issued. Make issueGrant throw and assert resolution fails closed. Use a synthetic CancellationTokenSource cancelled before return and assert the grant revoke closure runs. Assert a successful unused resolve is not immediately revoked.

- [ ] **Step 3: Run extension tests and verify failures**

Run:

~~~bash
npm test
~~~

Expected: provider tests fail because resolveMcpServerDefinition and live environment fields are absent.

- [ ] **Step 4: Implement fresh-definition resolution**

Revalidate root membership and bridge readiness. Issue workspace and global scopes. Construct a new definition with copied label, command, version, cwd, a spread copy of args, and a spread copy of env plus endpoint, protocol, generation, and token. Never assign to the supplied definition. Revoke only when issuance/resolution throws or the supplied token is observably cancelled before return.

- [ ] **Step 5: Run provider verification**

Run:

~~~bash
npm test
~~~

Expected: all provider lifecycle and two-resolution isolation tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/mcpServerProvider.ts src/test/suite/mcpServerProvider.test.ts
git commit -m "feat: resolve native MCP bridge grants"
~~~

### Task 7: Live Bridge Client and Backend

**Files:**
- Create: mcp-server/src/liveBridgeClient.ts
- Create: mcp-server/test/liveBridgeClient.test.ts

**Interfaces:**

~~~ts
export interface LiveBridgeConfig {
  endpoint: string;
  protocolVersion: 1;
  generation: string;
  token: string;
  workspaceFolderUri: string;
}
export const LIVE_BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000;
export class LiveMcpBridgeClient {
  static connect(
    config: LiveBridgeConfig,
    options?: { handshakeTimeoutMs?: number }
  ): Promise<LiveMcpBridgeClient>;
  request(method: 'list' | 'add', params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export class LiveBookmarkBackend implements BookmarkBackend {
  readonly mode = 'live';
  constructor(client: LiveMcpBridgeClient);
}
~~~

Source: spec:L146-L162, spec:L290-L371, and spec:L379-L437.

- [ ] **Step 1: Write failing handshake and correlation tests**

Start a real local net.Server fixture. Assert connect sends hello first, accepts ready only when generation/root/version/scopes match, correlates concurrent out-of-order responses by request ID, rejects duplicate response IDs, and rejects every pending call when the socket closes.

- [ ] **Step 2: Write failing absolute-deadline tests**

Inject a 30 ms test deadline. Cover an endpoint that accepts and stays silent; one that sends an incomplete ready frame one byte at a time; one that sends ready after 40 ms; and one that closes before ready. Assert all deadline cases reject with bridge-unavailable, destroy the socket, and ignore late readiness. Assert the production exported constant remains exactly 10_000.

- [ ] **Step 3: Write failing LiveBookmarkBackend tests**

Assert list sends method list with empty params. Assert add sends every AddBookmarkInput field unchanged. Validate returned list/add shapes before exposing them to tools; malformed result data must become internal-error rather than pass through.

- [ ] **Step 4: Run MCP tests and verify failures**

Run:

~~~bash
npm --prefix mcp-server test
~~~

Expected: compilation fails because liveBridgeClient.ts does not exist.

- [ ] **Step 5: Implement the client state machine**

Start one setTimeout before net.createConnection and never reset it. Encode hello after connect. Feed bytes through Task 1's decoder. Clear the timer only after a valid ready transitions connecting to ready. On every terminal path, set the state once, clear the timer, destroy the socket, and reject pending promises. Generate monotonic string request IDs and delete each pending entry before resolving it.

- [ ] **Step 6: Implement LiveBookmarkBackend**

Map backend list/add directly to client requests and validate required properties, scopes, and nested collection scope. close delegates to the client. Do not import extension source or access mirror files.

- [ ] **Step 7: Run client verification**

Run:

~~~bash
npm --prefix mcp-server test
~~~

Expected: handshake, deadline, correlation, malformed-result, and backend tests pass.

- [ ] **Step 8: Commit**

~~~bash
git add mcp-server/src/liveBridgeClient.ts mcp-server/test/liveBridgeClient.test.ts
git commit -m "feat: connect MCP server to live bridge"
~~~

### Task 8: Runtime Selection and MCP Initialization Gate

**Files:**
- Create: mcp-server/src/runtimeMode.ts
- Create: mcp-server/src/initializationGate.ts
- Create: mcp-server/test/runtimeMode.test.ts
- Create: mcp-server/test/initializationGate.test.ts
- Modify: mcp-server/src/index.ts
- Modify: mcp-server/test/index.test.ts

**Interfaces:**

~~~ts
export type RuntimeMode =
  | { kind: 'live'; config: LiveBridgeConfig }
  | { kind: 'mirror'; config: Config }
  | { kind: 'disabled'; reason: string };
export function resolveRuntimeMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): RuntimeMode;

export class InitializationGate implements Transport {
  constructor(inner: Transport);
  start(): Promise<void>;
  open(): void;
  fail(code: BridgeStartupCode, message: string): Promise<void>;
  close(): Promise<void>;
}
~~~

The pinned SDK supports a stdio transport over injected Readable and Writable streams and a Transport interface suitable for a wrapper. Source: package.json:L147-L159; https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/server/stdio.ts (fetched 2026-09-09).

- [ ] **Step 1: Write failing runtime-mode tests**

Cover complete live environment, no live fields plus successful mirror resolution, no live fields plus disabled mirror state, and every partial/malformed live combination. Assert any presence of a live-only field requires all six values: live mode marker, root URI, endpoint, protocol 1, generation, and token. A malformed live configuration must throw bridge-unavailable and must not read or write a mirror.

- [ ] **Step 2: Write failing gate unit tests**

Use PassThrough streams and a fake inner Transport. Feed initialize followed by tools/list while closed and assert neither reaches the SDK callback. Call open and assert both arrive in order unchanged. Call fail and assert exactly one deterministic error uses this shape, the send completes before close, later messages are ignored, and repeated fail/close calls do not duplicate output:

~~~ts
{
  jsonrpc: '2.0',
  id: initializeId,
  error: {
    code: -32000,
    message,
    data: { bookmarksPlusCode: 'bridge-unavailable' }
  }
}
~~~

- [ ] **Step 3: Write failing subprocess deadline tests**

Spawn the compiled entrypoint with a fake bridge endpoint and a valid initialize request. Exercise silent, trickled, and late-ready endpoints using an internal test-only timeout dependency passed through an exported runServer function, not an environment variable accepted by production parsing. Assert one initialization error, bridge-unavailable, closed stdio, and nonzero exit.

- [ ] **Step 4: Run MCP tests and verify failures**

Run:

~~~bash
npm --prefix mcp-server test
~~~

Expected: runtime-mode and initialization-gate tests fail because the new modules and live startup path do not exist.

- [ ] **Step 5: Implement strict runtime selection**

Parse live mode before calling resolveWorkspaceState. Complete live fields return kind live. Zero live fields delegate to the existing mirror resolver. Any partial field set, protocol other than 1, empty value, or invalid root URI throws a safe bridge-unavailable startup error.

- [ ] **Step 6: Implement the buffering transport**

InitializationGate.start is idempotent: it starts the inner transport only on the first call and returns the same successful startup state on later calls. The gate captures incoming messages while closed and delegates outgoing messages. open forwards buffered messages in arrival order and then streams new messages. fail finds the held initialize request, sends one JSON-RPC error through the inner transport, awaits send, and closes. It never forwards discovery or tool calls after failure.

- [ ] **Step 7: Wire main without changing mirror startup**

Export runServer(argv, env, dependencies) for tests. Mirror and disabled modes keep direct StdioServerTransport startup. Live mode starts the gate so initialize can be buffered, awaits LiveMcpBridgeClient.connect, creates LiveBookmarkBackend and McpServer, connects the server to the already-started gate, then opens it. Failure calls gate.fail, closes the backend/client, and sets a nonzero exit code.

- [ ] **Step 8: Run MCP and bundle verification**

Run:

~~~bash
npm --prefix mcp-server test
npm run test:mcp-bundle
~~~

Expected: all runtime selection, initialize gating, deadline, and existing standalone bundle tests pass.

- [ ] **Step 9: Commit**

~~~bash
git add mcp-server/src/runtimeMode.ts mcp-server/src/initializationGate.ts mcp-server/src/index.ts mcp-server/test/runtimeMode.test.ts mcp-server/test/initializationGate.test.ts mcp-server/test/index.test.ts
git commit -m "feat: gate MCP startup on live authentication"
~~~

### Task 9: Extension Activation, Invalidation, and Packaged Live Integration

**Files:**
- Modify: src/extension.ts
- Modify: src/test/suite/extension.globalStore.test.ts
- Modify: src/test/suite/extension.test.ts
- Modify: scripts/packaged-native-mcp-suite.cjs
- Modify: scripts/test-packaged-native-mcp.mjs
- Modify: scripts/test-bundled-mcp.mjs

**Interfaces:**
- Active runtime owns bridge alongside workspace store, global store, and mirror coordinator.
- Test-only packaged commands can resolve one enumerated native definition and read committed scoped state; activate still returns void and exposes no public API.

Add these optional members to the existing McpActivationDependencies test seam without changing activate's public signature:

~~~ts
isWorkspaceTrusted?: () => boolean;
startLiveBridge?: (
  options: LiveMcpBridgeServiceOptions
) => Promise<LiveMcpBridgeService>;
~~~

Production defaults return vscode.workspace.isTrusted and call LiveMcpBridgeService.start.

Source: src/extension.ts:L265-L375, src/extension.ts:L476-L488, spec:L116-L142, spec:L462-L491, and spec:L555-L576.

- [ ] **Step 1: Write failing activation-order tests**

Inject bridge creation through McpActivationDependencies. Assert trusted activation creates the bridge after both stores are ready and before provider registration. Assert untrusted activation starts no listener and does not register the native provider. Assert provider resolution receives the bridge grant issuer.

- [ ] **Step 2: Write failing root and shutdown tests**

Fire PartitionLifecycleChange for removal of the selected root and assert bridge.refreshAvailableRoots runs after reconciliation. Fire only reorder/add changes and assert no unrelated session closes. During deactivate, hold one admitted bridge store request and assert shutdown order is: fence new work, revoke/close bridge, finish admitted request, drain mirrors, dispose workspace/global stores.

- [ ] **Step 3: Rewrite the packaged suite for live state**

Add test-only commands behind BOOKMARKS_PACKAGED_MCP_TEST=1:

~~~ts
bookmarks.test.resolveMcpServerDefinition
bookmarks.test.getScopedBookmarkState
~~~

The first enumerates then resolves the selected definition through the actual provider. The second returns defensive workspace-owner and global snapshots only inside the packaged test host. The packaged suite must spawn the resolved definition, list both scopes, add one workspace and one global item, verify both in the extension-owned snapshots, assert live results contain no mirrorPath, remove each item through normal extension commands, and observe the live MCP list update. Unit tests from Tasks 3, 5, and 8 prove that a missing live bridge never selects or invokes MirrorBookmarkBackend; the packaged test must not require the workspace mirror to remain byte-for-byte unchanged because the extension's normal mirror coordinator may flush committed live workspace state afterward. Source: src/extension.ts:L297-L310 and spec:L129-L142.

- [ ] **Step 4: Add packaged failure and lifecycle cases**

Stop the bridge before resolving and assert native startup fails closed without invoking an MCP mutation. Remove the selected folder while the child is connected and assert the child closes. Run the real endpoint path on Windows and Unix CI; keep remote-host documentation disabled. The active-session-beyond-bootstrap-expiry case remains in Task 5's service lifecycle suite, where the clock is injectable without adding a packaged-only production seam.

- [ ] **Step 5: Run the red verification**

Run:

~~~bash
npm test
npm run test:mcp-bundle
npm run test:packaged-mcp
~~~

Expected: activation and packaged assertions fail until bridge construction, resolve, state seams, and shutdown wiring are added.

- [ ] **Step 6: Wire activation and deactivation**

When vscode.workspace.isTrusted is true, await LiveMcpBridgeService.start after stores initialize and before registerBookmarksMcpProvider. Pass env.sessionId, the extension identifier, stores, output, and an attached-root resolver derived from store.getView. Subscribe partition changes to both provider refresh and bridge.refreshAvailableRoots. Add bridge to activeRuntime. deactivate first sets stopping, awaits pending reconciliation, awaits bridge.stop, then drains mirrors and disposes stores.

- [ ] **Step 7: Update packaged scripts and standalone assertions**

Use the new test-only resolve command before spawning. Apply resolved env fields exactly. Replace mirror-race assertions for native mode with extension-owned live state assertions and assert mirrorPath is absent from native list/add results. Update standalone bundle expected list/add payloads only for additive workspace scope.

- [ ] **Step 8: Run full integration verification**

Run:

~~~bash
npm test
npm run test:mcp-bundle
npm run test:packaged-mcp
~~~

Expected: extension, bundled standalone, and packaged native live scenarios pass.

- [ ] **Step 9: Commit**

~~~bash
git add src/extension.ts src/test/suite/extension.globalStore.test.ts src/test/suite/extension.test.ts scripts/packaged-native-mcp-suite.cjs scripts/test-packaged-native-mcp.mjs scripts/test-bundled-mcp.mjs
git commit -m "feat: activate native live MCP bridge"
~~~

### Task 10: Documentation, Packaging, and Release Verification

**Files:**
- Modify: README.md
- Modify: mcp-server/README.md
- Modify: mcp-server/test/packaging.test.ts
- Modify: mcp-server/test/verifyPack.test.ts
- Modify: CHANGELOG.md

**Interfaces:**
- No new runtime interface.

Source: spec:L555-L594; package.json:L132-L143; mcp-server/package.json scripts and files fields.

- [ ] **Step 1: Write failing packaging assertions**

Assert npm pack contains the compiled backend, live client, initialization gate, runtime-mode module, bridge schema, and no test fixtures or extension source. Assert the VSIX contains dist/bookmarks-plus-mcp.mjs and both README descriptions match the shipped scope fields and startup behavior.

- [ ] **Step 2: Run packaging tests and verify the red state**

Run:

~~~bash
npm --prefix mcp-server test:packaging
~~~

Expected: new artifact assertions fail until build/copy output and package expectations are updated.

- [ ] **Step 3: Update user documentation**

README.md must state that VS Code-native definitions use live workspace and global stores, each returned record includes scope, add defaults to workspace when both scopes are granted, native bridge failure blocks initialization, and remote support is not claimed. mcp-server/README.md must state that direct npm/Claude launches remain workspace-mirror-only and show the additive list/add result shapes. Replace the Unreleased changelog statement that native integration is workspace-only and global/multi-root support remain tracked with the shipped live workspace/global behavior for #129. Source: CHANGELOG.md:L5-L13 and spec:L555-L594.

- [ ] **Step 4: Run all static and behavioral verification**

Run:

~~~bash
npm run lint
npm --prefix mcp-server run lint
npm test
npm --prefix mcp-server test
npm run test:mcp-bundle
npm run package
npm run test:packaged-mcp
npm --prefix mcp-server run verify-pack
~~~

Expected: every command exits zero with no failing tests.

- [ ] **Step 5: Audit artifact persistence**

Run:

~~~bash
git diff main...HEAD --stat
git ls-tree HEAD -- schemas/live-mcp-bridge-v1.schema.json
git ls-tree HEAD -- schemas/live-mcp-bridge-v1.fixtures.json
git ls-tree HEAD -- docs/superpowers/specs/2026-09-08-live-mcp-bridge-design.md
git ls-tree HEAD -- docs/superpowers/plans/2026-09-09-live-mcp-bridge.md
~~~

Expected: every path is present and the diff matches the plan's claimed deliverables.

- [ ] **Step 6: Commit**

~~~bash
git add README.md mcp-server/README.md mcp-server/test/packaging.test.ts mcp-server/test/verifyPack.test.ts
git add CHANGELOG.md
git commit -m "docs: explain live MCP bridge behavior"
~~~

- [ ] **Step 7: Prepare the pull request**

Before pushing, verify whether a PR already exists for codex/issue-129-live-mcp-bridge. The PR body must summarize live versus mirror behavior, list the verification commands actually run, include Closes #129 as plain text, and end with:

> 🤖 _Generated by Codex on behalf of @cbeaulieu-gt_

Before merge, re-read all live review comments, pending review requests, changes-requested reviews, CodeRabbit/Copilot output, and CI checks on the exact head commit.

---

## Self-Review Mapping

| Approved requirement | Implementing tasks |
| --- | --- |
| Canonical private protocol and bounded framing | Task 1 |
| Atomic workspace/global store access and descriptions | Task 2 |
| Mirror-backed standalone compatibility | Tasks 3 and 10 |
| Endpoint, authentication, expiry, and single use | Task 4 |
| Live workspace/global list and add with exact scope | Task 5 |
| Root isolation, persistent sessions, and deterministic shutdown | Tasks 5 and 9 |
| Token-free enumeration and fresh resolve definitions | Task 6 |
| Client correlation and socket failure behavior | Task 7 |
| Absolute 10-second initialization deadline and fail-closed startup | Task 8 |
| Packaged native integration and documentation | Tasks 9 and 10 |

The mapping covers all six requirements in spec:L49-L60 and every verification category in spec:L525-L576.
