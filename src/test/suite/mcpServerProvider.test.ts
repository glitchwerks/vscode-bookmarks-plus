import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  buildMcpServerDefinitions,
  registerBookmarksMcpProvider
} from '../../mcpServerProvider';
import { activate } from '../../extension';
import { createFakeExtensionContext, FakeOutput } from './fixtures';

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
    assert.deepStrictEqual(definition.env, { ELECTRON_RUN_AS_NODE: '1' });
    assert.strictEqual(definition.version, '1.3.0');
  });

  test('a no-folder window publishes no server and explains why', () => {
    const output = new FakeOutput();

    const definitions = buildMcpServerDefinitions(
      undefined,
      vscode.Uri.file('/extensions/bookmarks-plus'),
      '1.3.0',
      output
    );

    assert.deepStrictEqual(definitions, []);
    assert.strictEqual(output.lines.length, 1);
    assert.match(output.lines[0], /native MCP server is unavailable/i);
    assert.match(output.lines[0], /no workspace folder/i);
  });

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
    assert.match(output.lines[0], /no workspace folder/i);

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
      try {
        await activate(context as unknown as vscode.ExtensionContext, {
          getWorkspaceFolders: () => [{ uri: workspaceUri, name: 'activation-project', index: 0 }],
          registerProvider: (id: string, provider: vscode.McpServerDefinitionProvider) => {
            registeredId = id;
            registeredProvider = provider;
            return new vscode.Disposable(() => undefined);
          },
          onDidChangeWorkspaceFolders: () => new vscode.Disposable(() => undefined)
        });
      } catch (error: unknown) {
        assert.match(String(error), /command '.*' already exists/);
      }

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
      context.subscriptions.forEach((subscription) => subscription.dispose());
      if (previousPackagedTest === undefined) {
        delete process.env.BOOKMARKS_PACKAGED_MCP_TEST;
      } else {
        process.env.BOOKMARKS_PACKAGED_MCP_TEST = previousPackagedTest;
      }
    }
  });
});
