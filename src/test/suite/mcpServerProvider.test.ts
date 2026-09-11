import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  buildMcpServerDefinitions,
  registerBookmarksMcpProvider
} from '../../mcpServerProvider';
import { activate, deactivate } from '../../extension';
import { createFakeExtensionContext, FakeOutput } from './fixtures';

const NO_CANCELLATION = { isCancellationRequested: false } as vscode.CancellationToken;

interface TestGrant {
  readonly endpoint: string;
  readonly protocolVersion: 1;
  readonly generation: string;
  readonly token: string;
  revoke(): void;
}

interface LiveProviderFixture {
  provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>;
  readonly root: vscode.Uri;
  readonly grants: TestGrant[];
  readonly issueRequests: { rootUri: string; scopes: readonly string[] }[];
  roots: readonly { uri: vscode.Uri; name?: string }[] | undefined;
  ready: boolean;
  throwOnIssue: boolean;
  revokeCount: number;
  onIssueGrant?: () => void;
}

/** Registers a provider whose grant source mimics the bridge boundary without opening IPC. */
function createLiveProviderFixture(): LiveProviderFixture {
  const root = vscode.Uri.file('/workspaces/project');
  const grants: TestGrant[] = [];
  const fixture: LiveProviderFixture = {
    provider: undefined!,
    root,
    grants,
    issueRequests: [],
    roots: [{ uri: root }],
    ready: true,
    throwOnIssue: false,
    revokeCount: 0
  };
  let nextToken = 1;
  const dependencies = {
    getAttachedRoots: () => fixture.roots,
    extensionUri: vscode.Uri.file('/extensions/bookmarks-plus'),
    extensionVersion: '1.3.0',
    output: new FakeOutput(),
    registerProvider: (_id: string, provider: vscode.McpServerDefinitionProvider) => {
      fixture.provider = provider as vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>;
      return new vscode.Disposable(() => undefined);
    },
    onDidChangePartitions: () => new vscode.Disposable(() => undefined),
    isBridgeReady: () => fixture.ready,
    issueGrant: (rootUri: string, scopes: readonly string[]) => {
      if (fixture.throwOnIssue) {
        throw new Error('bridge-unavailable');
      }
      fixture.issueRequests.push({ rootUri, scopes: [...scopes] });
      const grant: TestGrant = {
        endpoint: 'bridge-endpoint',
        protocolVersion: 1,
        generation: 'bridge-generation',
        token: `token-${nextToken++}`,
        revoke: () => fixture.revokeCount++
      };
      grants.push(grant);
      fixture.onIssueGrant?.();
      return grant;
    }
  };
  fixture.provider = registerBookmarksMcpProvider([], dependencies)!;
  return fixture;
}

suite('MCP server definitions (#126)', () => {
  test('a single-root workspace launches the bundled server with an explicit workspace path', () => {
    const extensionUri = vscode.Uri.file('/extensions/bookmarks-plus');
    const workspaceUri = vscode.Uri.file('/workspaces/project');

    const definitions = buildMcpServerDefinitions(
      [{ uri: workspaceUri }],
      extensionUri,
      '1.3.0',
      new FakeOutput()
    );

    assert.strictEqual(definitions.length, 1);
    const definition = definitions[0];
    assert.ok(definition instanceof vscode.McpStdioServerDefinition);
    assert.strictEqual(definition.label, 'Bookmarks Plus');
    assert.strictEqual(definition.command, process.execPath);
    assert.deepStrictEqual(definition.args, [
      vscode.Uri.joinPath(extensionUri, 'dist', 'bookmarks-plus-mcp.mjs').fsPath,
      workspaceUri.fsPath
    ]);
    assert.deepStrictEqual(definition.env, {
      ELECTRON_RUN_AS_NODE: '1',
      BOOKMARKS_PLUS_LIVE_MODE: '1',
      BOOKMARKS_PLUS_ROOT_URI: 'file:///workspaces/project'
    });
    assert.strictEqual(definition.version, '1.3.0');
  });

  for (const roots of [undefined, []]) {
    test(`no attached roots (${roots === undefined ? 'undefined' : 'empty'}) publishes no server and explains why`, () => {
      const output = new FakeOutput();

      const definitions = buildMcpServerDefinitions(
        roots,
        vscode.Uri.file('/extensions/bookmarks-plus'),
        '1.3.0',
        output
      );

      assert.deepStrictEqual(definitions, []);
      assert.strictEqual(output.lines.length, 1);
      assert.match(output.lines[0], /native MCP server is unavailable/i);
      assert.match(output.lines[0], /no attached workspace roots are available/i);
      assert.doesNotMatch(output.lines[0], /no workspace folder is open/i);
    });
  }

  test('a multi-root window publishes one explicitly rooted server per attached folder', () => {
    const output = new FakeOutput();

    const definitions = buildMcpServerDefinitions(
      [
        { uri: vscode.Uri.file('/workspaces/first') },
        { uri: vscode.Uri.file('/workspaces/second') }
      ],
      vscode.Uri.file('/extensions/bookmarks-plus'),
      '1.3.0',
      output
    );

    assert.strictEqual(definitions.length, 2);
    assert.deepStrictEqual(definitions.map(definition => definition.args[1]), [
      vscode.Uri.file('/workspaces/first').fsPath,
      vscode.Uri.file('/workspaces/second').fsPath
    ]);
    assert.deepStrictEqual(definitions.map(definition => definition.label), [
      'Bookmarks Plus (first)', 'Bookmarks Plus (second)'
    ]);
  });

  test('duplicate display names use canonical root URI labels independent of folder order', () => {
    const roots = [
      { name: 'Shared', uri: vscode.Uri.parse('file:///alpha/shared') },
      { name: 'Shared', uri: vscode.Uri.parse('file:///beta/shared') }
    ];
    const build = (values: typeof roots) => buildMcpServerDefinitions(values,
      vscode.Uri.file('/extension'), '1.3.0', new FakeOutput());
    const labels = ['Bookmarks Plus (Shared — file:///alpha/shared)', 'Bookmarks Plus (Shared — file:///beta/shared)'];
    assert.deepStrictEqual(build(roots).map(value => value.label), labels);
    assert.deepStrictEqual(build([...roots].reverse()).map(value => value.label), [...labels].reverse());
  });

  test('enumerates a token-free definition and resolves fresh isolated bridge credentials', async () => {
    const fixture = createLiveProviderFixture();
    const enumerated = (await fixture.provider.provideMcpServerDefinitions(
      NO_CANCELLATION
    ))![0];
    enumerated.cwd = vscode.Uri.file('/workspaces');
    const originalArgs = [...enumerated.args];
    const originalEnv = { ...enumerated.env };
    const resolve = fixture.provider.resolveMcpServerDefinition!;

    const first = await resolve(enumerated, NO_CANCELLATION);
    const second = await resolve(enumerated, NO_CANCELLATION);

    assert.deepStrictEqual(enumerated.env, {
      ELECTRON_RUN_AS_NODE: '1',
      BOOKMARKS_PLUS_LIVE_MODE: '1',
      BOOKMARKS_PLUS_ROOT_URI: 'file:///workspaces/project'
    });
    assert.deepStrictEqual(enumerated.args, originalArgs);
    assert.notStrictEqual(first, enumerated);
    assert.notStrictEqual(second, enumerated);
    assert.notStrictEqual(first, second);
    assert.ok(first instanceof vscode.McpStdioServerDefinition);
    assert.ok(second instanceof vscode.McpStdioServerDefinition);
    assert.strictEqual(first?.label, enumerated.label);
    assert.strictEqual(first?.command, enumerated.command);
    assert.strictEqual(first?.version, enumerated.version);
    assert.strictEqual(first?.cwd, enumerated.cwd);
    assert.notStrictEqual(first?.args, enumerated.args);
    assert.notStrictEqual(second?.args, first?.args);
    assert.notStrictEqual(first?.env, enumerated.env);
    assert.notStrictEqual(second?.env, first?.env);
    assert.deepStrictEqual(first?.env, {
      ...originalEnv,
      BOOKMARKS_PLUS_BRIDGE_ENDPOINT: 'bridge-endpoint',
      BOOKMARKS_PLUS_BRIDGE_PROTOCOL: '1',
      BOOKMARKS_PLUS_BRIDGE_GENERATION: 'bridge-generation',
      BOOKMARKS_PLUS_BRIDGE_TOKEN: 'token-1'
    });
    assert.strictEqual(second?.env.BOOKMARKS_PLUS_BRIDGE_TOKEN, 'token-2');
    assert.deepStrictEqual(fixture.issueRequests, [
      { rootUri: 'file:///workspaces/project', scopes: ['workspace', 'global'] },
      { rootUri: 'file:///workspaces/project', scopes: ['workspace', 'global'] }
    ]);
    second!.args.push('--mutated');
    second!.env.MUTATED = 'yes';
    assert.deepStrictEqual(first?.args, originalArgs);
    assert.strictEqual((first!.env as Record<string, string | number | null>).MUTATED, undefined);
  });

  test('does not issue a grant when the enumerated root is no longer attached', async () => {
    const fixture = createLiveProviderFixture();
    const enumerated = (await fixture.provider.provideMcpServerDefinitions(
      NO_CANCELLATION
    ))![0];
    fixture.roots = [];

    const resolved = await fixture.provider.resolveMcpServerDefinition!(
      enumerated,
      NO_CANCELLATION
    );

    assert.strictEqual(resolved, undefined);
    assert.deepStrictEqual(fixture.grants, []);
  });

  test('fails closed when bridge readiness or grant issuance fails', async () => {
    const fixture = createLiveProviderFixture();
    const enumerated = (await fixture.provider.provideMcpServerDefinitions(
      NO_CANCELLATION
    ))![0];
    fixture.ready = false;
    assert.strictEqual(
      await fixture.provider.resolveMcpServerDefinition!(enumerated, NO_CANCELLATION),
      undefined
    );
    assert.deepStrictEqual(fixture.grants, []);

    fixture.ready = true;
    fixture.throwOnIssue = true;
    assert.strictEqual(
      await fixture.provider.resolveMcpServerDefinition!(enumerated, NO_CANCELLATION),
      undefined
    );
    assert.deepStrictEqual(fixture.grants, []);
  });

  test('revokes an issued grant when cancellation becomes observable before return', async () => {
    const fixture = createLiveProviderFixture();
    const cancellation = new vscode.CancellationTokenSource();
    const enumerated = (await fixture.provider.provideMcpServerDefinitions(
      NO_CANCELLATION
    ))![0];
    fixture.onIssueGrant = () => cancellation.cancel();

    const resolved = await fixture.provider.resolveMcpServerDefinition!(enumerated, cancellation.token);

    assert.strictEqual(resolved, undefined);
    assert.strictEqual(fixture.revokeCount, 1);
    cancellation.dispose();
  });

  test('does not revoke a successfully returned unused grant', async () => {
    const fixture = createLiveProviderFixture();
    const enumerated = (await fixture.provider.provideMcpServerDefinitions(
      NO_CANCELLATION
    ))![0];
    const resolved = await fixture.provider.resolveMcpServerDefinition!(
      enumerated,
      NO_CANCELLATION
    );

    assert.ok(resolved);
    assert.strictEqual(fixture.revokeCount, 0);
  });

  test('revokes exactly once when copying a definition fails after grant issuance', async () => {
    const fixture = createLiveProviderFixture();
    const enumerated = (await fixture.provider.provideMcpServerDefinitions(NO_CANCELLATION))![0];
    Object.defineProperty(enumerated, 'args', { get() { throw new Error('cannot read args'); } });
    assert.strictEqual(await fixture.provider.resolveMcpServerDefinition!(enumerated, NO_CANCELLATION), undefined);
    assert.strictEqual(fixture.grants.length, 1);
    assert.strictEqual(fixture.revokeCount, 1);
  });

  test('registration publishes definitions, refreshes on workspace changes, and owns its resources', async () => {
    const subscriptions: vscode.Disposable[] = [];
    const output = new FakeOutput();
    let folders: readonly { uri: vscode.Uri }[] | undefined = [
      { uri: vscode.Uri.file('/workspaces/project') }
    ];
    let registeredId: string | undefined;
    let registeredProvider: vscode.McpServerDefinitionProvider | undefined;
    let workspaceListener: (() => void) | undefined;
    let providerDisposeCount = 0;
    let listenerDisposeCount = 0;

    const registered = registerBookmarksMcpProvider(subscriptions, {
      isBridgeReady: () => false,
      issueGrant: () => { throw new Error('bridge-unavailable'); },
      getAttachedRoots: () => folders,
      extensionUri: vscode.Uri.file('/extensions/bookmarks-plus'),
      extensionVersion: '1.3.0',
      output,
      registerProvider: (id: string, provider: vscode.McpServerDefinitionProvider) => {
        registeredId = id;
        registeredProvider = provider;
        return new vscode.Disposable(() => providerDisposeCount++);
      },
      onDidChangePartitions: (listener: () => void) => {
        workspaceListener = listener;
        return new vscode.Disposable(() => listenerDisposeCount++);
      }
    });

    assert.strictEqual(registeredId, 'bookmarks-plus.mcp');
    assert.ok(registeredProvider);
    assert.strictEqual(registered, registeredProvider);
    const initialDefinitions = await registeredProvider.provideMcpServerDefinitions(
      {} as vscode.CancellationToken
    );
    assert.strictEqual(initialDefinitions?.length, 1);

    let changeCount = 0;
    registeredProvider.onDidChangeMcpServerDefinitions?.(() => changeCount++);
    folders = undefined;
    assert.ok(workspaceListener);
    workspaceListener();
    assert.strictEqual(changeCount, 1);

    const changedDefinitions = await registeredProvider.provideMcpServerDefinitions(
      {} as vscode.CancellationToken
    );
    assert.deepStrictEqual(changedDefinitions, []);
    assert.match(output.lines[0], /no attached workspace roots are available/i);

    folders = [
      { uri: vscode.Uri.file('/workspaces/first') },
      { uri: vscode.Uri.file('/workspaces/second') }
    ];
    workspaceListener();
    assert.strictEqual(changeCount, 2);
    const multiRootDefinitions = await registeredProvider.provideMcpServerDefinitions(
      {} as vscode.CancellationToken
    );
    assert.strictEqual(multiRootDefinitions?.length, 2);

    folders = [{ uri: vscode.Uri.file('/workspaces/reopened') }];
    workspaceListener();
    assert.strictEqual(changeCount, 3);
    const reopenedDefinitions = await registeredProvider.provideMcpServerDefinitions(
      {} as vscode.CancellationToken
    );
    assert.strictEqual(reopenedDefinitions?.length, 1);
    assert.strictEqual(
      (reopenedDefinitions?.[0] as vscode.McpStdioServerDefinition).args[1],
      vscode.Uri.file('/workspaces/reopened').fsPath
    );

    subscriptions.forEach((subscription) => subscription.dispose());
    workspaceListener();
    assert.strictEqual(changeCount, 3);
    assert.strictEqual(providerDisposeCount, 1);
    assert.strictEqual(listenerDisposeCount, 1);
  });

  test('a registration failure is reported without aborting activation and cleans up partial resources', () => {
    const subscriptions: vscode.Disposable[] = [];
    const output = new FakeOutput();
    let providerDisposeCount = 0;

    let registered: vscode.McpServerDefinitionProvider | undefined;
    assert.doesNotThrow(() => {
      registered = registerBookmarksMcpProvider(subscriptions, {
        isBridgeReady: () => false,
        issueGrant: () => { throw new Error('bridge-unavailable'); },
        getAttachedRoots: () => [{ uri: vscode.Uri.file('/workspaces/project') }],
        extensionUri: vscode.Uri.file('/extensions/bookmarks-plus'),
        extensionVersion: '1.3.0',
        output,
        registerProvider: () => new vscode.Disposable(() => providerDisposeCount++),
        onDidChangePartitions: () => {
          throw new Error('simulated workspace-listener failure');
        }
      });
    });

    assert.strictEqual(registered, undefined);
    assert.strictEqual(providerDisposeCount, 1);
    assert.deepStrictEqual(subscriptions, []);
    assert.strictEqual(output.lines.length, 1);
    assert.match(output.lines[0], /native MCP provider registration failed/i);
    assert.match(output.lines[0], /simulated workspace-listener failure/i);
  });

  test('extension activation registers the provider with its packaged URI and version', async () => {
    const extensionUri = vscode.Uri.file('/extensions/activation-copy');
    const workspaceUri = vscode.Uri.file('/workspaces/activation-project');
    const context = {
      ...createFakeExtensionContext(),
      extensionUri,
      extension: { packageJSON: { version: '9.8.7' } }
    };
    let registeredId: string | undefined;
    let registeredProvider: vscode.McpServerDefinitionProvider | undefined;
    const previousPackagedTest = process.env.BOOKMARKS_PACKAGED_MCP_TEST;
    process.env.BOOKMARKS_PACKAGED_MCP_TEST = '1';

    try {
      await activate(context as unknown as vscode.ExtensionContext, {
        registerCommands: () => undefined,
        isWorkspaceTrusted: () => true,
        startLiveBridge: async () => { throw new Error('no listener required for enumeration'); },
        getWorkspaceFolders: () => [{ uri: workspaceUri, name: 'activation-project', index: 0 }],
        registerProvider: (id: string, provider: vscode.McpServerDefinitionProvider) => {
          registeredId = id;
          registeredProvider = provider;
          return new vscode.Disposable(() => undefined);
        },
        onDidChangeWorkspaceFolders: () => new vscode.Disposable(() => undefined)
      });

      assert.strictEqual(registeredId, 'bookmarks-plus.mcp');
      assert.ok(registeredProvider);
      const definitions = await registeredProvider.provideMcpServerDefinitions(
        {} as vscode.CancellationToken
      );
      assert.strictEqual(definitions?.length, 1);
      assert.deepStrictEqual((definitions?.[0] as vscode.McpStdioServerDefinition).args, [
        vscode.Uri.joinPath(extensionUri, 'dist', 'bookmarks-plus-mcp.mjs').fsPath,
        workspaceUri.fsPath
      ]);
      assert.strictEqual(
        (definitions?.[0] as vscode.McpStdioServerDefinition).version,
        '9.8.7'
      );
      const observedDefinitions = await vscode.commands.executeCommand<
        vscode.McpStdioServerDefinition[]
      >('bookmarks.test.getMcpServerDefinitions');
      assert.deepStrictEqual(observedDefinitions, definitions);
    } finally {
      await deactivate();
      context.subscriptions.forEach((subscription) => subscription.dispose());
      if (previousPackagedTest === undefined) {
        delete process.env.BOOKMARKS_PACKAGED_MCP_TEST;
      } else {
        process.env.BOOKMARKS_PACKAGED_MCP_TEST = previousPackagedTest;
      }
    }
  });
});
