# Versioned Cross-Extension MCP API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the approved Bookmarks Plus API v1 from `activate()` so an optional, co-hosted VS Code extension can request one short-lived, root- and scope-bound MCP stdio descriptor. (#138; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L10-L27`)

**Architecture:** Keep the dependency-free DTO contract in `src/bookmarksPlusApi.ts`, and put runtime validation, version negotiation, readiness checks, and descriptor creation in a private `src/mcpConnectionService.ts`. The service adapts the existing live bridge without exposing it, while `extension.ts` returns one frozen API object after existing activation registrations finish. The existing packaged MCP runner will add a real second-extension fixture and trusted, missing, incompatible, and Restricted Mode runs, preserving the current native-provider test and CI check identity. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L99-L186`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L336-L360`, `scripts/test-packaged-native-mcp.mjs:L103-L164`, `.github/workflows/ci.yml:L99-L132`)

**Tech Stack:** TypeScript 5.4 in strict CommonJS extension code, VS Code API/type floor 1.101, Node 20 APIs, Mocha/assert integration tests, esbuild bundles, `@vscode/test-electron`, and the existing packaged MCP JSON-RPC client. (`tsconfig.json:L2-L14`, `package.json:L12-L16`, `package.json:L130-L162`)

**Spec:** `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md`

## Global Constraints

- API v1.0 advertises API version `{ major: 1, minor: 0 }`, descriptor version `1`, transport `stdio`, scopes `workspace` and `global`, explicit workspace-folder selection, and pinned-root sessions. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L99-L186`)
- The API object, nested capability objects, descriptor, `args`, `env`, `sensitiveEnvKeys`, and `grantedScopes` are frozen snapshots; readiness is reported by requests, not by mutating capabilities. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L595-L624`)
- Requests name one exact current workspace-folder URI, a non-empty duplicate-free scope set, and a non-empty duplicate-free list of positive integer descriptor versions. The producer grants exactly the requested scopes in canonical `workspace`, then `global` order. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L187-L231`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L483-L495`)
- Expected runtime states resolve to typed failures; unexpected programming or internal failures reject. Consumers branch on `code` and `retryable`, not messages. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L232-L252`)
- Descriptor v1 uses absolute launch paths, has no `cwd`, treats `env` as an overlay, and keeps bootstrap authorization only in environment values named by `sensitiveEnvKeys`. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L203-L215`)
- The public module exposes DTO types only. Stores, partition owners, provider instances, bridge objects, bootstrap internals, and filesystem assumptions remain private. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L99-L104`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L354-L360`)
- API v1 is same-extension-host only, uses the installed-extension trust model, requires Workspace Trust, and declares `extensionKind: ["workspace"]`; remote support remains explicitly unclaimed until a real remote-host packaged run exists. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L307-L335`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L361-L394`)
- Existing native Agent-mode discovery and standalone npm/Claude behavior remain unchanged. (#124; #129; #138; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L726-L735`)
- Do not add a separate types package, Claude-specific carrier, command facade, web transport, or automatic reconnection. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L726-L735`)

---

### Task 1: Expose immutable bridge grant metadata and typed issuance failures

**Files:**
- Modify: `src/liveMcpBridgeService.ts:25-31`
- Modify: `src/liveMcpBridgeService.ts:67-148`
- Test: `src/test/suite/liveMcpBridgeService.test.ts:586-670`

**Interfaces:**
- Produces: `LiveMcpBridgeGrantErrorCode`, `LiveMcpBridgeGrantError`, `IssuedLiveBridgeGrant.expiresAt`, and `LiveMcpBridgeService.activationGeneration`.
- Consumed by: Task 2's private connection service.

The bridge already creates a 60-second immutable pending grant and returns its endpoint, generation, token, and revoker, but it does not return the expiry and communicates issuance outcomes through generic `Error` messages. The public adapter needs the exact expiry and must distinguish supported bridge states without classifying arbitrary errors by text. (`src/liveMcpBridgeService.ts:L25-L31`, `src/liveMcpBridgeService.ts:L123-L148`; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L187-L215`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L232-L252`)

- [ ] **Step 1: Add failing grant metadata and typed-error tests**

Add these assertions to the existing deterministic-generation and grant-validation tests:

```ts
import {
  LiveMcpBridgeGrantError,
  LiveMcpBridgeService
} from '../../liveMcpBridgeService';

test('returns the activation generation and exact immutable bootstrap expiry', () => {
  const grant = service.issueGrant(ROOT, ['workspace']);
  assert.strictEqual(service.activationGeneration, grant.generation);
  assert.strictEqual(grant.expiresAt, now + 60_000);
  assert.ok(Object.isFrozen(grant));
});

test('uses typed grant failures without classifying unrelated errors', async () => {
  assert.throws(
    () => service.issueGrant('file:///workspace/b', ['workspace']),
    (error: unknown) =>
      error instanceof LiveMcpBridgeGrantError &&
      error.code === 'workspace-folder-unavailable'
  );
  await service.stop();
  assert.throws(
    () => service.issueGrant(ROOT, ['workspace']),
    (error: unknown) =>
      error instanceof LiveMcpBridgeGrantError && error.code === 'bridge-unavailable'
  );
  assert.strictEqual(
    new Error('workspace-folder-unavailable') instanceof LiveMcpBridgeGrantError,
    false
  );
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
npm run compile-tests
npx mocha --ui tdd out/test/suite/liveMcpBridgeService.test.js --grep "grant|generation|expiry"
```

Expected: compilation fails because the grant expiry, generation accessor, and typed error do not exist.

- [ ] **Step 3: Add the typed bridge error and immutable metadata**

Add the following public-to-private adapter surface without exposing any bridge object through the extension API:

```ts
export type LiveMcpBridgeGrantErrorCode =
  | 'workspace-folder-unavailable'
  | 'scope-unavailable'
  | 'bridge-unavailable';

export class LiveMcpBridgeGrantError extends Error {
  constructor(readonly code: LiveMcpBridgeGrantErrorCode) {
    super(code);
    this.name = 'LiveMcpBridgeGrantError';
  }
}

export interface IssuedLiveBridgeGrant {
  readonly endpoint: string;
  readonly protocolVersion: 1;
  readonly generation: string;
  readonly token: string;
  readonly expiresAt: number;
  revoke(): void;
}
```

Add a read-only generation accessor:

```ts
get activationGeneration(): string {
  return this.generation;
}
```

Replace the three expected `issueGrant()` throws with `LiveMcpBridgeGrantError`, calculate one `expiresAt` value, store that value in `PendingBridgeGrant`, and return the same value in the frozen grant:

```ts
const expiresAt = this.now() + 60_000;
this.pendingGrants.set(tokenDigest, Object.freeze({
  tokenDigest,
  generation: this.generation,
  workspaceFolderUri: canonicalRoot,
  owner: Object.freeze({ ...root.owner }),
  scopes: Object.freeze([...scopes]),
  expiresAt
}));
return Object.freeze({
  endpoint: this.endpoint,
  protocolVersion: 1,
  generation: this.generation,
  token,
  expiresAt,
  revoke: this.makeRevoker(tokenDigest)
});
```

- [ ] **Step 4: Run the bridge suite**

Run:

```bash
npm test
```

Expected: all live bridge service tests pass, including existing single-use, root/scope binding, expiry, restart, shutdown, and disconnect coverage. (`src/test/suite/liveMcpBridgeService.test.ts:L586-L750`)

- [ ] **Step 5: Commit Task 1**

```bash
git add src/liveMcpBridgeService.ts src/test/suite/liveMcpBridgeService.test.ts
git commit -m "refactor: type live MCP grant outcomes"
```

---

### Task 2: Add the public API contract and private request service

**Files:**
- Create: `src/bookmarksPlusApi.ts`
- Create: `src/mcpConnectionService.ts`
- Create: `src/test/suite/mcpConnectionService.test.ts`

**Interfaces:**
- Produces: all API v1 DTOs from the approved contract, `McpConnectionServiceDependencies`, `selectHighestMutualDescriptorVersion()`, and `createBookmarksPlusApi()`.
- Consumes: `IssuedLiveBridgeGrant`, `LiveMcpBridgeGrantError`, `LiveMcpBridgeService.activationGeneration`, `canonicalizeRootUri()`, `vscode.Uri`, and `vscode.WorkspaceFolder`.
- Produces for Task 3: a frozen `BookmarksPlusApiV1` whose only method is `requestMcpConnection()`.

The canonical URI implementation already validates absolute roots, rejects query/fragment components, normalizes scheme/authority, preserves path identity, and is shared by current partition attachment. Reuse it for exact request/root comparison rather than adding a second URI policy. (`src/rootUri.ts:L21-L27`, `src/rootUri.ts:L42-L92`, `src/workspaceBookmarkStore.ts:L82-L113`; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L216-L231`)

- [ ] **Step 1: Create the dependency-free DTO module**

Create `src/bookmarksPlusApi.ts` with the approved declarations verbatim:

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

Do not import `vscode`, stores, bridge classes, filesystem modules, or provider types in this file. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L99-L186`)

- [ ] **Step 2: Add failing service tests for capabilities, validation, and negotiation**

Create a fixture in `mcpConnectionService.test.ts` with one `file:///workspace` folder, one partition attachment, an absolute executable path, a fake extension URI, a bridge fake that returns an immutable grant, and `isFile: async () => true`.

Add table-driven tests covering all of these exact inputs and results:

```ts
const invalidRequests: Array<[unknown, string]> = [
  [undefined, 'invalid-request'],
  [{}, 'invalid-request'],
  [{ workspaceFolderUri: 'relative', scopes: ['workspace'], supportedDescriptorVersions: [1] }, 'invalid-request'],
  [{ workspaceFolderUri: ROOT, scopes: [], supportedDescriptorVersions: [1] }, 'invalid-request'],
  [{ workspaceFolderUri: ROOT, scopes: ['workspace', 'workspace'], supportedDescriptorVersions: [1] }, 'invalid-request'],
  [{ workspaceFolderUri: ROOT, scopes: ['future'], supportedDescriptorVersions: [1] }, 'unsupported-scope'],
  [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [] }, 'invalid-request'],
  [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [1, 1] }, 'invalid-request'],
  [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [0] }, 'invalid-request'],
  [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [1.5] }, 'invalid-request'],
  [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [2] }, 'unsupported-descriptor-version']
];
```

Also assert:

```ts
assert.strictEqual(selectHighestMutualDescriptorVersion([1, 2], [1, 2]), 2);
assert.strictEqual(selectHighestMutualDescriptorVersion([1], [2]), undefined);

const api = createBookmarksPlusApi(deps);
assert.deepStrictEqual(api.apiVersion, { major: 1, minor: 0 });
assert.deepStrictEqual(api.capabilities.mcpConnection, {
  descriptorVersions: [1],
  transports: ['stdio'],
  scopes: ['workspace', 'global'],
  rootSelection: 'explicit-workspace-folder',
  sessionLifecycle: 'pinned-root'
});
assert.ok(Object.isFrozen(api));
assert.ok(Object.isFrozen(api.apiVersion));
assert.ok(Object.isFrozen(api.capabilities));
assert.ok(Object.isFrozen(api.capabilities.mcpConnection));
assert.ok(Object.isFrozen(api.capabilities.mcpConnection.descriptorVersions));
assert.ok(Object.isFrozen(api.capabilities.mcpConnection.transports));
assert.ok(Object.isFrozen(api.capabilities.mcpConnection.scopes));
```

The production list remains `[1]`; the injected `[1, 2]` negotiation assertion is the test-only second-version proof required by the contract. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L187-L202`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L625-L640`)

- [ ] **Step 3: Run the new test and verify the red state**

Run:

```bash
npm run compile-tests
```

Expected: compilation fails because `bookmarksPlusApi.ts` and `mcpConnectionService.ts` do not yet provide the imported service API.

- [ ] **Step 4: Implement validation, negotiation, frozen capabilities, and typed failures**

In `mcpConnectionService.ts`, define these private dependency boundaries:

```ts
export interface McpBridgeGrantIssuer {
  readonly activationGeneration: string;
  issueGrant(rootUri: string, scopes: readonly BookmarkScope[]): IssuedLiveBridgeGrant;
}

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

export function selectHighestMutualDescriptorVersion(
  requested: readonly number[],
  supported: readonly number[] = [1]
): number | undefined {
  const supportedSet = new Set(supported);
  return [...requested].filter(version => supportedSet.has(version)).sort((a, b) => b - a)[0];
}
```

Use one frozen failure factory with the required retryability mapping:

```ts
const RETRYABLE_CODES = new Set<McpConnectionErrorCode>([
  'workspace-folder-unavailable',
  'stale-request',
  'temporarily-unavailable',
  'shutting-down'
]);

function failure(code: McpConnectionErrorCode, message: string): McpConnectionFailure {
  return Object.freeze({
    kind: 'error' as const,
    error: Object.freeze({ code, message, retryable: RETRYABLE_CODES.has(code) })
  });
}
```

Validation must ignore unknown object properties for additive compatibility, but reject a non-object request, malformed/relative/query/fragment root URI, non-array/empty/duplicate scopes, non-string scope values, unknown string scopes, and non-array/empty/duplicate/non-positive/non-integer versions. Run descriptor negotiation only after list-shape validation. Use `vscode.Uri.parse(value, true)` plus `canonicalizeRootUri()`; do not compare raw strings or filesystem paths. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L187-L231`)

Create fresh frozen version/capability snapshots inside each `createBookmarksPlusApi()` call and forward only the public method:

```ts
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
```

- [ ] **Step 5: Implement exact-root readiness and descriptor creation**

Use this request sequence so the asynchronous bundle check creates a real stale-state boundary:

1. Return `shutting-down` if disposal has begun.
2. Validate request fields and select the highest mutual descriptor version.
3. Match the canonical URI against `getWorkspaceFolders()` using `canonicalizeRootUri(folder.uri)`; return `workspace-folder-not-found` if absent.
4. Resolve the selected partition; return `workspace-folder-unavailable` if the current folder has no ready attachment.
5. Capture the bridge object, `activationGeneration`, and `partitionId`; return `temporarily-unavailable` if no bridge exists.
6. Await a regular-file check for `vscode.Uri.joinPath(extensionUri, 'dist', 'bookmarks-plus-mcp.mjs').fsPath`.
7. Recheck shutdown, current-folder identity, partition identity, bridge object, and generation. Return `shutting-down` or `stale-request` before issuing a grant when state changed; return `temporarily-unavailable` when the bundle is absent.
8. Issue exactly the normalized requested scopes and recheck the same state after issuance. Revoke the grant before returning `stale-request` or `shutting-down`.
9. Map typed `bridge-unavailable` and `scope-unavailable` issuance failures to `temporarily-unavailable`; map a post-validation `workspace-folder-unavailable` to `stale-request`. Rethrow any non-`LiveMcpBridgeGrantError`.

Construct and freeze descriptor v1 exactly as follows:

```ts
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
```

The existing native provider uses the same bundled entry point and environment keys; duplicating this small private translation avoids changing the provider's public VS Code behavior in #138. (`src/mcpServerProvider.ts:L60-L93`, `src/mcpServerProvider.ts:L110-L140`; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L726-L735`)

- [ ] **Step 6: Complete service tests for every result and descriptor invariant**

Add focused tests that assert:

- unknown root -> `workspace-folder-not-found`, non-retryable;
- current root without attachment -> `workspace-folder-unavailable`, retryable;
- absent bridge or missing bundle -> `temporarily-unavailable`, retryable;
- pre-request or post-grant shutdown -> `shutting-down`, retryable, and post-grant revokes exactly once;
- attachment or bridge generation replacement during `isFile()` -> `stale-request`, retryable, with no grant;
- replacement caused by the grant fake -> `stale-request` and one revocation;
- a typed bridge failure maps as specified, while `new Error('bridge-unavailable')` rejects;
- request `['global', 'workspace']` grants and reports `['workspace', 'global']`, while `['global']` remains exactly `['global']`;
- `command`, both `args`, and the bundle path are absolute; no `cwd` exists;
- the bootstrap token occurs only in `env.BOOKMARKS_PLUS_BRIDGE_TOKEN`, and that key is the only `sensitiveEnvKeys` member;
- `bootstrapExpiresAt` equals `new Date(grant.expiresAt).toISOString()`;
- the API, capabilities, result, descriptor, arrays, and environment are frozen;
- a second request receives a distinct token; reuse protection remains the bridge's responsibility.

Use the exact expected failure-code/retryability table from the design. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L232-L252`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L625-L640`)

- [ ] **Step 7: Run the focused API service suite**

Run:

```bash
npm test
```

Expected: all public contract, validation, negotiation, lifecycle fence, error mapping, and descriptor-invariant tests pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/bookmarksPlusApi.ts src/mcpConnectionService.ts src/test/suite/mcpConnectionService.test.ts
git commit -m "feat: add versioned MCP connection API"
```

---

### Task 3: Return the API from trusted activation and declare host/trust policy

**Files:**
- Modify: `src/extension.ts:29-70`
- Modify: `src/extension.ts:273-352`
- Modify: `src/extension.ts:397-501`
- Modify: `src/test/suite/extension.test.ts:20-34`
- Modify: `src/test/suite/extension.globalStore.test.ts:17-67`
- Modify: `src/test/suite/extension.globalStore.test.ts:299-365`
- Modify: `package.json:12-20`
- Modify: `src/test/suite/mcpManifest.test.ts:5-32`

**Interfaces:**
- Consumes: `createBookmarksPlusApi()` and its `McpConnectionServiceDependencies`.
- Produces: trusted `activate()` result `Promise<BookmarksPlusApiV1>`; injected/untrusted activation returns `undefined` and starts neither bridge nor native provider.
- Preserves: native provider registration and shutdown ownership.

Current activation builds partitioned workspace/global stores, starts the trusted live bridge, registers the native provider independently, and currently returns `Promise<void>`. Wire the API around those existing resources and return it only after the existing registrations succeed. (`src/extension.ts:L273-L352`, `src/extension.ts:L397-L501`; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L336-L360`)

- [ ] **Step 1: Change the packaged activation test to expect the frozen API**

Replace the obsolete assertion in `extension.test.ts`:

```ts
test('normal activation returns the frozen public API and exposes no packaged state commands', async () => {
  const ext = vscode.extensions.getExtension<BookmarksPlusApiV1>(
    'cbeaulieu-gt.vscode-bookmarks-plus'
  )!;
  const api = await ext.activate();
  assert.deepStrictEqual(api.apiVersion, { major: 1, minor: 0 });
  assert.deepStrictEqual(api.capabilities.mcpConnection.descriptorVersions, [1]);
  assert.strictEqual(typeof api.requestMcpConnection, 'function');
  assert.ok(Object.isFrozen(api));
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'bookmarks.test.resolveMcpServerDefinition',
    'bookmarks.test.getScopedBookmarkState'
  ]) {
    assert.strictEqual(commands.includes(command), false);
  }
});
```

Import `BookmarksPlusApiV1` from `../../bookmarksPlusApi` as a type.

- [ ] **Step 2: Add activation-fixture tests for trusted, unavailable, and untrusted outcomes**

Capture the `activate()` return value in `activationFixture.start()` and add tests that prove:

```ts
const api = await f.start();
assert.deepStrictEqual(api?.apiVersion, { major: 1, minor: 0 });
const result = await api!.requestMcpConnection({
  workspaceFolderUri: 'file:///a',
  scopes: ['workspace'],
  supportedDescriptorVersions: [1]
});
assert.strictEqual(result.kind, 'success');
```

Inject `isMcpBundleFile: async () => true` and an absolute `mcpExecutablePath` in the fixture. For bridge startup failure, assert the API is still returned and the request yields `temporarily-unavailable`. For `isWorkspaceTrusted: () => false`, assert `start()` returns `undefined`, `registeredMcp` is undefined, and the lifecycle contains neither `bridge` nor `provider`. This preserves the existing UI-store regression assertion. (`src/test/suite/extension.globalStore.test.ts:L299-L365`)

- [ ] **Step 3: Run the activation tests and verify the red state**

Run:

```bash
npm test
```

Expected: assertions fail because `activate()` still returns `undefined` and the manifest lacks explicit placement/trust declarations.

- [ ] **Step 4: Wire the private service into activation**

Extend `McpActivationDependencies` with only these test seams:

```ts
isMcpBundleFile?: (filePath: string) => Promise<boolean>;
mcpExecutablePath?: string;
```

Change the return type to:

```ts
): Promise<BookmarksPlusApiV1 | undefined> {
```

After bridge startup, build the frozen API only when `trusted` is true:

```ts
const publicApi = trusted ? createBookmarksPlusApi({
  getWorkspaceFolders: mcpDeps.getWorkspaceFolders,
  getAttachedRoot: canonicalRootUri => {
    const root = getAttachedRoot(canonicalRootUri);
    return root?.owner.kind === 'partition'
      ? { canonicalRootUri: root.canonicalRootUri, partitionId: root.owner.partitionId }
      : undefined;
  },
  getBridge: () => runtime.bridge,
  isShuttingDown: () => runtime.stopping,
  extensionUri: context.extensionUri,
  executablePath: mcpDeps.mcpExecutablePath ?? process.execPath,
  isFile: mcpDeps.isMcpBundleFile
}) : undefined;
```

Return `publicApi` after command/view/provider registrations complete. Do not put the API or service into `context.subscriptions`; they own no resources, while bridge/store/mirror disposal remains in `shutdownRuntime()`. (`src/extension.ts:L535-L567`)

- [ ] **Step 5: Add explicit workspace-host and trust declarations**

Add these top-level manifest fields, leaving the existing MCP provider contribution unchanged:

```json
"extensionKind": ["workspace"],
"capabilities": {
  "untrustedWorkspaces": {
    "supported": false,
    "description": "Bookmarks Plus MCP access can start a process with access to workspace bookmark data."
  }
}
```

Extend `ExtensionManifest` in `mcpManifest.test.ts` and assert the exact values. VS Code disables an extension with `untrustedWorkspaces.supported: false` in Restricted Mode, and `extensionKind: ["workspace"]` selects the Node workspace extension host. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L307-L335`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L361-L394`; https://code.visualstudio.com/api/extension-guides/workspace-trust, fetched 2026-09-12; https://code.visualstudio.com/api/references/extension-manifest, fetched 2026-09-12)

- [ ] **Step 6: Run activation, manifest, provider, and full extension suites**

Run:

```bash
npm test
```

Expected: all API export, trust, placement, native provider, bridge, and activation failure-isolation tests pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add package.json src/extension.ts src/test/suite/extension.test.ts src/test/suite/extension.globalStore.test.ts src/test/suite/mcpManifest.test.ts
git commit -m "feat: export MCP API from trusted activation"
```

---

### Task 4: Prove the API through a real second extension and packaged VSIX

**Files:**
- Create: `scripts/fixtures/bookmarks-api-consumer/package.json`
- Create: `scripts/fixtures/bookmarks-api-consumer/extension.cjs`
- Create: `scripts/fixtures/incompatible-bookmarks-plus/package.json`
- Create: `scripts/fixtures/incompatible-bookmarks-plus/extension.cjs`
- Create: `scripts/packaged-extension-api-suite.cjs`
- Modify: `scripts/test-packaged-native-mcp.mjs:103-164`
- Preserve: `scripts/packaged-native-mcp-suite.cjs:52-225`

**Interfaces:**
- Consumer fixture produces: `{ connect(workspaceFolderUri): Promise<ConsumerOutcome> }` as its own activation export.
- Consumer fixture consumes: only `vscode.extensions.getExtension()`, `extension.activate()`, API version/capabilities, and `requestMcpConnection()`.
- Packaged test consumes: public descriptor DTO fields and the existing `createJsonRpcClient()` helper.

`@vscode/test-electron` accepts multiple `extensionDevelopmentPath` values, and VS Code's extension-test guidance requires separate trusted and untrusted runs with isolated user data. Use those supported boundaries rather than importing the producer bundle directly. (https://github.com/microsoft/vscode-test, fetched 2026-09-12; https://code.visualstudio.com/api/working-with-extensions/testing-extension, fetched 2026-09-12; `scripts/test-packaged-native-mcp.mjs:L143-L160`)

- [ ] **Step 1: Add the optional consumer fixture**

Create a manifest with ID `bookmarks-plus-tests.api-consumer`, `extensionKind: ["workspace"]`, `capabilities.untrustedWorkspaces.supported: true`, `activationEvents: ["onStartupFinished"]`, `main: "./extension.cjs"`, and no `extensionDependencies`.

Implement this bounded optional adapter:

```js
'use strict';

const vscode = require('vscode');
const PRODUCER_ID = 'cbeaulieu-gt.vscode-bookmarks-plus';

function fallback(reason) {
  return Object.freeze({ kind: 'fallback', reason });
}

async function connect(workspaceFolderUri) {
  const extension = vscode.extensions.getExtension(PRODUCER_ID);
  if (!extension) return fallback('missing-extension');
  try {
    const api = await extension.activate();
    const capability = api?.capabilities?.mcpConnection;
    if (
      api?.apiVersion?.major !== 1 ||
      !Array.isArray(capability?.descriptorVersions) ||
      !capability.descriptorVersions.includes(1) ||
      !Array.isArray(capability?.transports) ||
      !capability.transports.includes('stdio') ||
      !Array.isArray(capability?.scopes) ||
      !capability.scopes.includes('workspace') ||
      !capability.scopes.includes('global')
    ) {
      return fallback('incompatible-api');
    }
    const result = await api.requestMcpConnection({
      workspaceFolderUri,
      scopes: ['workspace', 'global'],
      supportedDescriptorVersions: [1]
    });
    return result.kind === 'success'
      ? Object.freeze({ kind: 'descriptor', descriptor: result.descriptor })
      : fallback(result.error.code);
  } catch {
    return fallback('activation-or-request-rejected');
  }
}

function activate() {
  return Object.freeze({ connect });
}

module.exports = { activate };
```

This fixture intentionally does not implement Claude Workspaces' deadline, redaction, or temporary carrier; those remain owned by its downstream issue. It proves producer discovery and graceful absence/incompatibility only. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L253-L306`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L445-L482`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L726-L735`)

- [ ] **Step 2: Add the incompatible producer fixture**

Create a fixture manifest whose publisher/name produce the real ID `cbeaulieu-gt.vscode-bookmarks-plus`, with `extensionKind: ["workspace"]`, `capabilities.untrustedWorkspaces.supported: true`, `activationEvents: ["onStartupFinished"]`, and `main: "./extension.cjs"`.

Its activation export is deliberately incompatible and must never expose secrets or start a process:

```js
'use strict';

function activate() {
  return Object.freeze({
    apiVersion: Object.freeze({ major: 2, minor: 0 }),
    capabilities: Object.freeze({})
  });
}

module.exports = { activate };
```

- [ ] **Step 3: Add the packaged API test suite**

Create `scripts/packaged-extension-api-suite.cjs`. Read `BOOKMARKS_PACKAGED_API_SCENARIO`, the producer/consumer paths, workspace path, and MCP version from the environment.

For `missing`, assert the producer is absent and the consumer returns `{ kind: 'fallback', reason: 'missing-extension' }`.

For `incompatible`, assert the fixture producer is present and the consumer returns `{ kind: 'fallback', reason: 'incompatible-api' }`.

For `restricted`, assert `vscode.workspace.isTrusted === false`, the real producer is present but inactive, and the consumer returns a fallback without activating it.

For `trusted`, assert both extensions are loaded from the supplied fixture/VSIX paths, call the consumer's `connect()` with the selected folder's `uri.toString(true)`, and verify:

```js
assert.equal(outcome.kind, 'descriptor');
const descriptor = outcome.descriptor;
assert.equal(descriptor.version, 1);
assert.equal(descriptor.transport, 'stdio');
assert.equal(path.isAbsolute(descriptor.command), true);
assert.equal(descriptor.args.every(value => path.isAbsolute(value)), true);
assert.equal(Object.hasOwn(descriptor, 'cwd'), false);
assert.deepEqual(descriptor.grantedScopes, ['workspace', 'global']);
assert.deepEqual(descriptor.sensitiveEnvKeys, ['BOOKMARKS_PLUS_BRIDGE_TOKEN']);
assert.equal(typeof descriptor.env.BOOKMARKS_PLUS_BRIDGE_TOKEN, 'string');
assert.equal(JSON.stringify({
  ...descriptor,
  env: { ...descriptor.env, BOOKMARKS_PLUS_BRIDGE_TOKEN: '[redacted]' }
}).includes(descriptor.env.BOOKMARKS_PLUS_BRIDGE_TOKEN), false);
```

Launch the returned command/args from an unrelated temporary `cwd`, overlay descriptor `env` on `process.env`, complete MCP initialization through `createJsonRpcClient()`, assert `list_bookmarks` and `add_bookmark` work in both granted scopes, remove the selected folder, and assert the subprocess exits. Reuse the current native suite's JSON-RPC request shapes and state-cleanup commands; do not read bridge fields from private production modules. (`scripts/packaged-native-mcp-suite.cjs:L108-L225`; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L395-L444`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L683-L708`)

- [ ] **Step 4: Extend the packaged runner with four isolated API scenarios**

Keep the existing native run unchanged, then call `runTests()` four more times:

```js
const consumerPath = join(repoRoot, 'scripts', 'fixtures', 'bookmarks-api-consumer');
const incompatiblePath = join(repoRoot, 'scripts', 'fixtures', 'incompatible-bookmarks-plus');
const apiSuitePath = join(repoRoot, 'scripts', 'packaged-extension-api-suite.cjs');

const scenarios = [
  { name: 'trusted', paths: [extensionPath, consumerPath], disableTrust: true },
  { name: 'missing', paths: [consumerPath], disableTrust: true },
  { name: 'incompatible', paths: [incompatiblePath, consumerPath], disableTrust: true },
  { name: 'restricted', paths: [extensionPath, consumerPath], disableTrust: false }
];
```

For every scenario, use a distinct `--user-data-dir` and `--extensions-dir`. Add `--disable-workspace-trust` only to the first three; leave Workspace Trust enabled for `restricted`. Pass the scenario and exact paths through `extensionTestsEnv`. The official VS Code guidance requires separate runs because an extension test cannot grant/revoke trust programmatically. (https://code.visualstudio.com/api/working-with-extensions/testing-extension#testing-workspace-trust-behavior, fetched 2026-09-12)

- [ ] **Step 5: Run the packaged integration and verify all scenarios**

Run:

```bash
npm run test:packaged-mcp
```

Expected: the original native-provider run and all four public-API scenarios pass. Trusted mode completes MCP initialization through the consumer-returned descriptor; missing, incompatible, and Restricted Mode follow the fallback path without starting Bookmarks Plus MCP.

- [ ] **Step 6: Commit Task 4**

```bash
git add scripts/fixtures/bookmarks-api-consumer/package.json scripts/fixtures/bookmarks-api-consumer/extension.cjs scripts/fixtures/incompatible-bookmarks-plus/package.json scripts/fixtures/incompatible-bookmarks-plus/extension.cjs scripts/packaged-extension-api-suite.cjs scripts/test-packaged-native-mcp.mjs
git commit -m "test: exercise packaged MCP API consumer"
```

The current Linux/Windows `packaged-native-mcp` jobs in CI and publish already invoke `npm run test:packaged-mcp`, so extending that command keeps the existing required check identity and makes these scenarios release-gating without a workflow mutation. (`.github/workflows/ci.yml:L99-L132`, `.github/workflows/publish.yml:L70-L106`, `package.json:L137-L144`)

---

### Task 5: Document discovery, compatibility, security, and limitations

**Files:**
- Modify: `README.md:100-160`
- Modify: `README.md:343-364`

**Interfaces:**
- Documents: the complete structural API contract, optional discovery flow, descriptor handling rules, trust model, lifecycle, compatibility policy, and current host limitations.
- Preserves: the standalone mirror-based Claude/npm section beginning at `README.md:160`.

- [ ] **Step 1: Add a public API section after native MCP usage**

Add `## Using Bookmarks Plus from another VS Code extension` containing:

1. Extension ID `cbeaulieu-gt.vscode-bookmarks-plus`.
2. A consumer example using `vscode.extensions.getExtension<unknown>()`, optional activation, runtime API-major/capability checks, and one request with explicit `workspaceFolderUri`, explicit scopes, and `[1]` descriptor versions.
3. The complete API v1 and descriptor v1 TypeScript shapes copied from `src/bookmarksPlusApi.ts`.
4. Compatibility rules: major `1`, additive minor changes, highest mutual descriptor version, unknown fields ignored, incompatible field changes require a new descriptor version, breaking method/result semantics require a new API major.
5. Descriptor handling: forward `command`, `args`, and `env` unchanged; overlay `env`; do not set a required `cwd`; redact every `sensitiveEnvKeys` value; do not log or persist the descriptor; launch before `bootstrapExpiresAt`.
6. Root/scope rules: one exact current root per descriptor, canonical granted scope order, no implicit global scope, no cross-root/unassigned access, and new request per new process.
7. Lifecycle: single-use bootstrap, no periodic active-session expiry, selected-root removal/reload/disposal closes the server, unrelated root changes do not, and Bookmarks Plus does not hot-reconnect a running client.
8. Trust/placement: any installed same-host extension can call API v1 after Workspace Trust, both extensions must run in the Node workspace host, and remote support is not claimed.
9. Graceful degradation: consumers must not declare Bookmarks Plus as a mandatory dependency when their primary feature works without it; absence, incompatibility, typed failure, rejection, or timeout uses their fallback.

Every behavior above comes directly from the approved compatibility/security contract. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L187-L335`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L361-L444`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L595-L624`, `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L709-L725`)

- [ ] **Step 2: Update development commands**

Change the `npm run test:packaged-mcp` description to state that it packages a real VSIX, verifies native provider behavior, and exercises a second extension consuming the returned public API in trusted, missing, incompatible, and Restricted Mode scenarios. Keep the Linux/Windows release-gate statement because the same CI/publish job still owns the expanded command. (`README.md:L351-L364`, `.github/workflows/ci.yml:L99-L132`, `.github/workflows/publish.yml:L70-L106`)

- [ ] **Step 3: Verify documentation matches exported names and literals**

Run:

```bash
rg -n "BookmarksPlusApiV1|requestMcpConnection|bootstrapExpiresAt|sensitiveEnvKeys|extensionKind|Restricted Mode|remote" README.md src/bookmarksPlusApi.ts package.json
git diff --check
```

Expected: README names and literals match the public module/manifest, remote support is explicitly unclaimed, and whitespace validation passes.

- [ ] **Step 4: Commit Task 5**

```bash
git add README.md
git commit -m "docs: describe the cross-extension MCP API"
```

---

### Task 6: Run the complete compatibility and artifact-persistence gate

**Files:**
- Verify only; modify earlier task files only if a failing check identifies a defect.

**Interfaces:**
- Verifies: extension unit/integration tests, standalone bundled MCP compatibility, packaged native/public API behavior, lint, production packaging, and referenced artifacts.

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
git diff --check main...HEAD
npm run lint
npm run compile-tests
npm run package
```

Expected: all commands exit 0 with no lint or TypeScript errors.

- [ ] **Step 2: Run the complete extension suite**

Run:

```bash
npm test
```

Expected: all extension-host tests pass with zero failures, including the new API, activation, trust manifest, existing multi-root storage, native provider, and live bridge suites.

- [ ] **Step 3: Run bundled and packaged MCP compatibility suites**

Run:

```bash
npm run test:mcp-bundle
npm run test:packaged-mcp
```

Expected: the standalone bundle/VSIX checks, native provider run, trusted second-extension handshake, missing/incompatible fallbacks, and Restricted Mode run all pass. The existing standalone behavior remains workspace-mirror-only. (`README.md:L160-L168`, `package.json:L137-L144`)

- [ ] **Step 4: Reconcile the final diff with #138**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD --name-status
git status --short
```

Confirm the diff contains:

- public DTO contract and private connection service;
- bridge grant expiry/typed error adapter;
- trusted activation export plus explicit workspace-host/trust manifest;
- unit/lifecycle regression tests;
- real consumer and incompatible-producer fixtures;
- expanded packaged test runner/suite;
- README API and development documentation.

Confirm it does not contain Claude Workspaces code, a public types package, command transport, automatic reconnection, or unrelated refactors. (#138; `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L726-L750`)

- [ ] **Step 5: Verify every committed path reference exists**

For each path newly named by README, scripts, or this plan, run `git ls-tree HEAD -- <path>`. At minimum verify:

```bash
git ls-tree HEAD -- src/bookmarksPlusApi.ts
git ls-tree HEAD -- src/mcpConnectionService.ts
git ls-tree HEAD -- scripts/fixtures/bookmarks-api-consumer/package.json
git ls-tree HEAD -- scripts/fixtures/bookmarks-api-consumer/extension.cjs
git ls-tree HEAD -- scripts/fixtures/incompatible-bookmarks-plus/package.json
git ls-tree HEAD -- scripts/fixtures/incompatible-bookmarks-plus/extension.cjs
git ls-tree HEAD -- scripts/packaged-extension-api-suite.cjs
git ls-tree HEAD -- docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md
git ls-tree HEAD -- docs/superpowers/plans/2026-09-12-versioned-extension-api.md
```

Expected: every command prints one tracked entry. Record any durable rationale in the PR body or Issue #138 before this plan is deleted after the issue closes.

- [ ] **Step 6: Commit only if verification required corrections**

If Steps 1-5 required corrections, stage only those corrections and commit:

```bash
git add src package.json README.md scripts
git commit -m "fix: complete MCP API verification"
```

If no corrections were required, do not create an empty commit.
