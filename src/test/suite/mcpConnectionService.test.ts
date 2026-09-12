import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BookmarkScope,
  McpConnectionErrorCode,
  McpConnectionFailure,
  McpConnectionRequest,
  McpConnectionResult,
  McpConnectionSuccess
} from '../../bookmarksPlusApi';
import {
  McpBridgeGrantIssuer,
  McpConnectionServiceDependencies,
  createBookmarksPlusApi,
  selectHighestMutualDescriptorVersion
} from '../../mcpConnectionService';
import {
  IssuedLiveBridgeGrant,
  LiveMcpBridgeGrantError
} from '../../liveMcpBridgeService';

const ROOT = 'file:///workspace';
const EXPIRES_AT = 1_800_000_000_000;

interface MutableBridge extends McpBridgeGrantIssuer {
  activationGeneration: string;
}

interface ServiceFixture {
  deps: McpConnectionServiceDependencies;
  readonly folder: vscode.WorkspaceFolder;
  readonly issuedRequests: Array<{ rootUri: string; scopes: readonly BookmarkScope[] }>;
  readonly grants: IssuedLiveBridgeGrant[];
  folders: readonly vscode.WorkspaceFolder[] | undefined;
  attachment: { readonly canonicalRootUri: string; readonly partitionId: string } | undefined;
  bridge: MutableBridge | undefined;
  bundlePresent: boolean;
  shuttingDown: boolean;
  revokeCount: number;
  issueError: Error | undefined;
  onIsFile: (() => void) | undefined;
  onIssueGrant: (() => void) | undefined;
  checkedBundlePath: string | undefined;
}

function createFixture(): ServiceFixture {
  const folder: vscode.WorkspaceFolder = {
    uri: vscode.Uri.parse(ROOT, true),
    name: 'workspace',
    index: 0
  };
  const issuedRequests: Array<{ rootUri: string; scopes: readonly BookmarkScope[] }> = [];
  const grants: IssuedLiveBridgeGrant[] = [];
  const fixture = {
    deps: undefined!,
    folder,
    issuedRequests,
    grants,
    folders: [folder],
    attachment: { canonicalRootUri: ROOT, partitionId: 'partition-1' },
    bridge: undefined,
    bundlePresent: true,
    shuttingDown: false,
    revokeCount: 0,
    issueError: undefined,
    onIsFile: undefined,
    onIssueGrant: undefined,
    checkedBundlePath: undefined
  } as ServiceFixture;
  let tokenSequence = 0;
  fixture.bridge = {
    activationGeneration: 'generation-1',
    issueGrant: (rootUri, scopes) => {
      if (fixture.issueError) {
        throw fixture.issueError;
      }
      issuedRequests.push({ rootUri, scopes: [...scopes] });
      const grant = Object.freeze({
        endpoint: '\\\\.\\pipe\\bookmarks-plus-test',
        protocolVersion: 1 as const,
        generation: fixture.bridge!.activationGeneration,
        token: `bootstrap-token-${++tokenSequence}`,
        expiresAt: EXPIRES_AT,
        revoke: () => fixture.revokeCount++
      });
      grants.push(grant);
      fixture.onIssueGrant?.();
      return grant;
    }
  };
  fixture.deps = {
    getWorkspaceFolders: () => fixture.folders,
    getAttachedRoot: canonicalRootUri => fixture.attachment?.canonicalRootUri === canonicalRootUri
      ? fixture.attachment
      : undefined,
    getBridge: () => fixture.bridge,
    isShuttingDown: () => fixture.shuttingDown,
    extensionUri: vscode.Uri.file(path.join(path.parse(process.execPath).root, 'extensions', 'bookmarks-plus')),
    executablePath: path.join(path.parse(process.execPath).root, 'runtime', 'electron.exe'),
    isFile: async filePath => {
      fixture.checkedBundlePath = filePath;
      fixture.onIsFile?.();
      return fixture.bundlePresent;
    }
  };
  return fixture;
}

function request(overrides: Partial<McpConnectionRequest> = {}): McpConnectionRequest {
  return {
    workspaceFolderUri: ROOT,
    scopes: ['workspace'],
    supportedDescriptorVersions: [1],
    ...overrides
  };
}

function requireFailure(result: McpConnectionResult, code: McpConnectionErrorCode): McpConnectionFailure {
  if (result.kind !== 'error') {
    assert.fail(`Expected ${code}, received success.`);
  }
  assert.strictEqual(result.error.code, code);
  assert.ok(result.error.message.length > 0);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.error));
  return result;
}

function requireSuccess(result: McpConnectionResult): McpConnectionSuccess {
  if (result.kind !== 'success') {
    assert.fail(`Expected success, received ${result.error.code}.`);
  }
  return result;
}

suite('Bookmarks Plus API v1 MCP connection service (#138)', () => {
  test('selects the highest mutual descriptor version', () => {
    assert.strictEqual(selectHighestMutualDescriptorVersion([1, 2], [1, 2]), 2);
    assert.strictEqual(selectHighestMutualDescriptorVersion([1], [2]), undefined);
  });

  test('publishes a deeply frozen v1.0 capability snapshot', () => {
    const fixture = createFixture();
    const api = createBookmarksPlusApi(fixture.deps);

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
  });

  test('creates fresh capability snapshots for separate API instances', () => {
    const fixture = createFixture();
    const first = createBookmarksPlusApi(fixture.deps);
    const second = createBookmarksPlusApi(fixture.deps);

    assert.notStrictEqual(first.apiVersion, second.apiVersion);
    assert.notStrictEqual(first.capabilities, second.capabilities);
    assert.notStrictEqual(first.capabilities.mcpConnection, second.capabilities.mcpConnection);
  });

  const invalidRequests: Array<[unknown, McpConnectionErrorCode]> = [
    [undefined, 'invalid-request'],
    [{}, 'invalid-request'],
    [{ workspaceFolderUri: 'relative', scopes: ['workspace'], supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: 'file:///workspace?query=1', scopes: ['workspace'], supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: 'file:///workspace#fragment', scopes: ['workspace'], supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: 42, scopes: ['workspace'], supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: [], supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: 'workspace', supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace', 'workspace'], supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: [1], supportedDescriptorVersions: [1] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['future'], supportedDescriptorVersions: [1] }, 'unsupported-scope'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: '1' }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [1, 1] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [0] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [-1] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [1.5] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [Number.NaN] }, 'invalid-request'],
    [{ workspaceFolderUri: ROOT, scopes: ['workspace'], supportedDescriptorVersions: [2] }, 'unsupported-descriptor-version']
  ];

  invalidRequests.forEach(([input, code], index) => {
    test(`rejects malformed request case ${index + 1} as ${code}`, async () => {
      const api = createBookmarksPlusApi(createFixture().deps);

      const failure = requireFailure(await api.requestMcpConnection(input as McpConnectionRequest), code);

      assert.strictEqual(failure.error.retryable, false);
    });
  });

  test('ignores unknown request properties for additive compatibility', async () => {
    const fixture = createFixture();
    const api = createBookmarksPlusApi(fixture.deps);

    const result = await api.requestMcpConnection({ ...request(), futureProperty: true } as McpConnectionRequest);

    assert.strictEqual(result.kind, 'success');
  });

  test('returns non-retryable workspace-folder-not-found for an unknown canonical root', async () => {
    const result = await createBookmarksPlusApi(createFixture().deps).requestMcpConnection(
      request({ workspaceFolderUri: 'file:///unknown' })
    );

    assert.strictEqual(requireFailure(result, 'workspace-folder-not-found').error.retryable, false);
  });

  test('matches a request by canonical URI identity rather than raw spelling', async () => {
    const fixture = createFixture();
    fixture.folders = [{
      uri: vscode.Uri.parse('FILE:///workspace/', true),
      name: 'workspace',
      index: 0
    }];

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(result.kind, 'success');
  });

  test('returns retryable workspace-folder-unavailable when the current root has no attachment', async () => {
    const fixture = createFixture();
    fixture.attachment = undefined;

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'workspace-folder-unavailable').error.retryable, true);
  });

  test('returns retryable temporarily-unavailable when no bridge exists', async () => {
    const fixture = createFixture();
    fixture.bridge = undefined;

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'temporarily-unavailable').error.retryable, true);
  });

  test('returns retryable temporarily-unavailable when the bundled server is absent', async () => {
    const fixture = createFixture();
    fixture.bundlePresent = false;

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'temporarily-unavailable').error.retryable, true);
    assert.strictEqual(fixture.issuedRequests.length, 0);
  });

  test('returns retryable shutting-down before doing request work', async () => {
    const fixture = createFixture();
    fixture.shuttingDown = true;

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'shutting-down').error.retryable, true);
    assert.strictEqual(fixture.checkedBundlePath, undefined);
    assert.strictEqual(fixture.issuedRequests.length, 0);
  });

  test('returns stale-request without a grant when the attachment changes during the bundle check', async () => {
    const fixture = createFixture();
    fixture.onIsFile = () => {
      fixture.attachment = { canonicalRootUri: ROOT, partitionId: 'partition-2' };
    };

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'stale-request').error.retryable, true);
    assert.strictEqual(fixture.issuedRequests.length, 0);
  });

  test('returns stale-request without a grant when bridge generation changes during the bundle check', async () => {
    const fixture = createFixture();
    fixture.onIsFile = () => {
      fixture.bridge!.activationGeneration = 'generation-2';
    };

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'stale-request').error.retryable, true);
    assert.strictEqual(fixture.issuedRequests.length, 0);
  });

  test('returns stale-request without a grant when the selected folder disappears during the bundle check', async () => {
    const fixture = createFixture();
    fixture.onIsFile = () => {
      fixture.folders = [];
    };

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'stale-request').error.retryable, true);
    assert.strictEqual(fixture.issuedRequests.length, 0);
  });

  test('revokes once and returns shutting-down when shutdown begins during grant issuance', async () => {
    const fixture = createFixture();
    fixture.onIssueGrant = () => {
      fixture.shuttingDown = true;
    };

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'shutting-down').error.retryable, true);
    assert.strictEqual(fixture.revokeCount, 1);
  });

  test('revokes once and returns stale-request when the bridge is replaced during grant issuance', async () => {
    const fixture = createFixture();
    fixture.onIssueGrant = () => {
      fixture.bridge = {
        activationGeneration: 'generation-2',
        issueGrant: () => assert.fail('Replacement bridge must not issue the retained request.')
      };
    };

    const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

    assert.strictEqual(requireFailure(result, 'stale-request').error.retryable, true);
    assert.strictEqual(fixture.revokeCount, 1);
  });

  for (const [bridgeCode, expectedCode] of [
    ['bridge-unavailable', 'temporarily-unavailable'],
    ['scope-unavailable', 'temporarily-unavailable'],
    ['workspace-folder-unavailable', 'stale-request']
  ] as const) {
    test(`maps typed ${bridgeCode} issuance failure to ${expectedCode}`, async () => {
      const fixture = createFixture();
      fixture.issueError = new LiveMcpBridgeGrantError(bridgeCode);

      const result = await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request());

      assert.strictEqual(requireFailure(result, expectedCode).error.retryable, true);
    });
  }

  test('rejects an untyped issuance error instead of classifying its message', async () => {
    const fixture = createFixture();
    fixture.issueError = new Error('bridge-unavailable');

    await assert.rejects(
      createBookmarksPlusApi(fixture.deps).requestMcpConnection(request()),
      (error: unknown) => error === fixture.issueError
    );
  });

  test('normalizes a two-scope request while preserving a one-scope request exactly', async () => {
    const fixture = createFixture();
    const api = createBookmarksPlusApi(fixture.deps);

    const both = requireSuccess(await api.requestMcpConnection(request({ scopes: ['global', 'workspace'] })));
    const global = requireSuccess(await api.requestMcpConnection(request({ scopes: ['global'] })));

    assert.deepStrictEqual(fixture.issuedRequests.map(value => value.scopes), [
      ['workspace', 'global'],
      ['global']
    ]);
    assert.deepStrictEqual(both.descriptor.grantedScopes, ['workspace', 'global']);
    assert.deepStrictEqual(global.descriptor.grantedScopes, ['global']);
  });

  test('returns an absolute cwd-independent descriptor with isolated sensitive bootstrap material', async () => {
    const fixture = createFixture();

    const success = requireSuccess(await createBookmarksPlusApi(fixture.deps).requestMcpConnection(request()));
    const { descriptor } = success;
    const token = fixture.grants[0].token;

    assert.strictEqual(descriptor.version, 1);
    assert.strictEqual(descriptor.transport, 'stdio');
    assert.ok(path.isAbsolute(descriptor.command));
    assert.strictEqual(descriptor.command, fixture.deps.executablePath);
    assert.strictEqual(descriptor.args.length, 2);
    assert.ok(descriptor.args.every(value => path.isAbsolute(value)));
    assert.strictEqual(descriptor.args[0], fixture.checkedBundlePath);
    assert.strictEqual(descriptor.args[1], fixture.folder.uri.fsPath);
    assert.strictEqual('cwd' in descriptor, false);
    assert.deepStrictEqual(descriptor.env, {
      ELECTRON_RUN_AS_NODE: '1',
      BOOKMARKS_PLUS_LIVE_MODE: '1',
      BOOKMARKS_PLUS_ROOT_URI: ROOT,
      BOOKMARKS_PLUS_BRIDGE_ENDPOINT: fixture.grants[0].endpoint,
      BOOKMARKS_PLUS_BRIDGE_PROTOCOL: '1',
      BOOKMARKS_PLUS_BRIDGE_GENERATION: fixture.grants[0].generation,
      BOOKMARKS_PLUS_BRIDGE_TOKEN: token
    });
    assert.deepStrictEqual(descriptor.sensitiveEnvKeys, ['BOOKMARKS_PLUS_BRIDGE_TOKEN']);
    assert.strictEqual(descriptor.bootstrapExpiresAt, new Date(EXPIRES_AT).toISOString());
    assert.strictEqual(JSON.stringify(descriptor).split(token).length - 1, 1);
    assert.strictEqual(descriptor.env.BOOKMARKS_PLUS_BRIDGE_TOKEN, token);
    assert.ok(Object.isFrozen(success));
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(descriptor.args));
    assert.ok(Object.isFrozen(descriptor.env));
    assert.ok(Object.isFrozen(descriptor.sensitiveEnvKeys));
    assert.ok(Object.isFrozen(descriptor.grantedScopes));
  });

  test('issues a distinct bootstrap token for each successful request', async () => {
    const fixture = createFixture();
    const api = createBookmarksPlusApi(fixture.deps);

    const first = requireSuccess(await api.requestMcpConnection(request()));
    const second = requireSuccess(await api.requestMcpConnection(request()));

    assert.notStrictEqual(
      first.descriptor.env.BOOKMARKS_PLUS_BRIDGE_TOKEN,
      second.descriptor.env.BOOKMARKS_PLUS_BRIDGE_TOKEN
    );
    assert.strictEqual(fixture.grants.length, 2);
    assert.strictEqual(fixture.revokeCount, 0);
  });
});
