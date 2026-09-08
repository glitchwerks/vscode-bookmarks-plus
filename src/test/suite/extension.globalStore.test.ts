import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../extension';
import { ScopedStores } from '../../commands';
import { WorkspaceBookmarkStore } from '../../workspaceBookmarkStore';
import { WorkspaceMirrorCoordinator } from '../../workspaceMirrorCoordinator';
import { BookmarksTreeDataProvider } from '../../bookmarksTreeDataProvider';
import { WORKSPACE_PARTITION_STORAGE_KEY } from '../../workspacePartitionTypes';
import { createFakeExtensionContext, FakeMemento, FakePartitionMirrorResources, FakeOutput } from './fixtures';

/** Real stores/coordinator; only VS Code registrations and filesystem ports are replaced. */
function activationFixture(names = ['a', 'b'], malformed = false) {
  const context = createFakeExtensionContext();
  if (malformed) context.workspaceState = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: { private: 'secret' } });
  let folders = names.map((name, index) => ({ name, index, uri: vscode.Uri.parse('file:///' + name) }));
  const output = Object.assign(new FakeOutput(), { dispose() {}, show() {} });
  const resources = new Map<string, FakePartitionMirrorResources>();
  let changed: (() => void | Promise<void>) | undefined;
  let stores: ScopedStores<WorkspaceBookmarkStore> | undefined;
  let provider: BookmarksTreeDataProvider | undefined;
  let coordinator: WorkspaceMirrorCoordinator | undefined;
  let mcp: vscode.McpServerDefinitionProvider | undefined;
  const deps = {
    getWorkspaceFolders: () => folders,
    registerProvider: (_id: string, value: vscode.McpServerDefinitionProvider) => { mcp = value; return new vscode.Disposable(() => {}); },
    onDidChangeWorkspaceFolders: (listener: () => void | Promise<void>) => { changed = listener; return new vscode.Disposable(() => { changed = undefined; }); },
    createOutputChannel: () => output,
    createMirrorResources: (root: vscode.Uri) => {
      const value = new FakePartitionMirrorResources(); resources.set(root.toString(), value); return value;
    },
    registerCommands: (_context: vscode.ExtensionContext, value: ScopedStores<WorkspaceBookmarkStore>, tree: BookmarksTreeDataProvider, mirrors: WorkspaceMirrorCoordinator) => {
      stores = value; provider = tree; coordinator = mirrors;
    }
  };
  return {
    context, output, resources, deps,
    get stores() { assert.ok(stores); return stores; },
    get provider() { assert.ok(provider); return provider; },
    get coordinator() { assert.ok(coordinator); return coordinator; },
    get mcp() { assert.ok(mcp); return mcp; },
    async start() { await activate(context as unknown as vscode.ExtensionContext, deps as unknown as Parameters<typeof activate>[1]); },
    async change(names: string[]) {
      folders = names.map((name, index) => ({ name, index, uri: vscode.Uri.parse('file:///' + name) }));
      assert.ok(changed); await changed();
    },
    async stop() { await deactivate(); context.subscriptions.forEach(value => value.dispose()); }
  };
}

suite('Extension - partitioned activation (#62)', () => {
  test('activation accepts a Windows drive URI after persistence serialization', async () => {
    const f = activationFixture(['C:/Work/Repo']);
    try {
      await f.start();
      assert.strictEqual(f.stores.workspace.getView().kind, 'ready', f.output.lines.join('\n'));
      assert.strictEqual(f.resources.size, 1);
      assert.strictEqual((await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken))?.length, 1);
    } finally { await f.stop(); }
  });

  test('activation creates and reconciles one mirror per attached root', async () => {
    const f = activationFixture();
    try {
      await f.start();
      assert.deepStrictEqual([...f.resources.keys()].sort(), ['file:///a', 'file:///b']);
      assert.strictEqual(f.resources.get('file:///a')!.port.writeCount, 1);
      assert.strictEqual(f.resources.get('file:///b')!.port.writeCount, 1);
      assert.ok(f.stores.workspace instanceof WorkspaceBookmarkStore);
      assert.deepStrictEqual((await f.provider.getChildren()).map(node => node.kind), ['globalRoot', 'workspaceRoot', 'workspaceRoot']);
    } finally { await f.stop(); }
  });
  test('root removal flushes, disposes, preserves content and refreshes consumers from committed state', async () => {
    const f = activationFixture();
    try {
      await f.start();
      const owner = f.stores.workspace.resolveAttachedOwner(vscode.Uri.parse('file:///b/file'))!;
      const item = await f.stores.workspace.addItem(owner, { type: 'file', uri: 'file:///b/file' });
      let refreshes = 0, definitionsChanged = 0;
      f.provider.onDidChangeTreeData(() => refreshes++);
      f.mcp.onDidChangeMcpServerDefinitions?.(() => definitionsChanged++);
      await f.change(['a']);
      assert.strictEqual(f.resources.get('file:///b')!.disposed, true);
      assert.strictEqual(JSON.parse(f.resources.get('file:///b')!.port.content!).items[0].id, item.id);
      assert.strictEqual(f.stores.workspace.getView().detached[0].data.items[0].id, item.id);
      assert.ok(refreshes > 0);
      assert.strictEqual(f.context.environmentVariableCollection.calls.at(-1)!.value, vscode.Uri.parse('file:///a').fsPath);
      assert.strictEqual(definitionsChanged, 1);
      const definitions = await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken);
      assert.strictEqual(definitions?.length, 1);
    } finally { await f.stop(); }
  });

  test('malformed workspace keeps Global active and exposes a diagnostic without mirrors or native MCP', async () => {
    const f = activationFixture(['a', 'b'], true);
    try {
      await f.start();
      await f.stores.global.addItem({ type: 'file', uri: 'file:///global' });
      assert.strictEqual(f.stores.global.getAll().items.length, 1);
      assert.deepStrictEqual([...f.resources], []);
      const diagnostic = (await f.provider.getChildren()).find(node => node.kind === 'workspaceDiagnostic')!;
      assert.ok(diagnostic);
      assert.strictEqual((await f.provider.getTreeItem(diagnostic)).command?.command, 'bookmarks.showOutput');
      assert.deepStrictEqual(await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken), []);
      assert.deepStrictEqual(f.context.workspaceState.get(WORKSPACE_PARTITION_STORAGE_KEY), { private: 'secret' });
      assert.ok(f.output.lines.every(line => !line.includes('secret')));
    } finally { await f.stop(); }
  });

  test('canonical collisions expose no attached mirrors or native servers', async () => {
    const f = activationFixture(['a', 'a']);
    try {
      await f.start();
      assert.strictEqual(f.stores.workspace.getView().attached.length, 0);
      assert.strictEqual(f.resources.size, 0);
      assert.deepStrictEqual(await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken), []);
    } finally { await f.stop(); }
  });

  test('Global persists only bookmarks.data and never enrolls in Settings Sync', async () => {
    const f = activationFixture([]);
    let syncCalls = 0;
    f.context.globalState.setKeysForSync = () => { syncCalls++; };
    try {
      await f.start();
      await f.stores.global.addCollection('Global collection');
      await f.stores.global.addItem({ type: 'file', uri: 'file:///outside' });
      assert.deepStrictEqual(f.context.globalState.keys(), ['bookmarks.data']);
      assert.strictEqual(syncCalls, 0);
      assert.strictEqual(f.resources.size, 0);
    } finally { await f.stop(); }
  });

  test('folder changes serialize through a pending removal flush and publish committed topology in order', async () => {
    const f = activationFixture();
    try {
      await f.start();
      const owner = f.stores.workspace.resolveAttachedOwner(vscode.Uri.parse('file:///b/file'))!;
      await f.stores.workspace.addItem(owner, { type: 'file', uri: 'file:///b/file' });
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const port = f.resources.get('file:///b')!.port;
      const write = port.write.bind(port);
      port.write = async content => { entered(); await barrier; await write(content); };
      const seen: number[] = [];
      f.stores.workspace.onDidChangePartitions(event => seen.push(event.currentRoots.length));
      const first = f.change(['a']);
      await started;
      const second = f.change(['a', 'c']);
      assert.deepStrictEqual(seen, []);
      assert.strictEqual(f.resources.has('file:///c'), false);
      release();
      await Promise.all([first, second]);
      assert.deepStrictEqual(seen, [1, 2]);
      assert.deepStrictEqual(f.stores.workspace.getView().attached.map(root => root.rootUri), ['file:///a', 'file:///c']);
      assert.strictEqual(f.context.environmentVariableCollection.calls.at(-1)!.value, 'disabled:multi-root');
    } finally { await f.stop(); }
  });

  test('folder persistence errors are redacted and later folder changes still run', async () => {
    const f = activationFixture();
    try {
      await f.start();
      f.context.workspaceState.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
      await f.change(['a', 'c']);
      assert.deepStrictEqual(f.stores.workspace.getView().attached.map(root => root.rootUri), ['file:///a', 'file:///b']);
      assert.match(f.output.lines.at(-1)!, /folder reconciliation failed/);
      await f.change(['a', 'c']);
      assert.deepStrictEqual(f.stores.workspace.getView().attached.map(root => root.rootUri), ['file:///a', 'file:///c']);
    } finally { await f.stop(); }
  });

  test('deactivation attempts every root flush and disposes resources after failures settle', async () => {
    const f = activationFixture();
    await f.start();
    for (const root of ['a', 'b']) {
      const uri = vscode.Uri.parse('file:///' + root + '/new');
      await f.stores.workspace.addItem(f.stores.workspace.resolveAttachedOwner(uri)!, { type: 'file', uri: uri.toString() });
    }
    let attempts = 0;
    f.resources.get('file:///a')!.port.write = async () => { attempts++; throw new Error('secret bookmark path'); };
    await deactivate();
    assert.strictEqual(attempts, 1);
    assert.strictEqual(JSON.parse(f.resources.get('file:///b')!.port.content!).items.length, 1);
    assert.ok([...f.resources.values()].every(resource => resource.disposed));
    assert.ok(f.output.lines.some(line => line.includes('flush failed')));
    assert.ok(f.output.lines.every(line => !line.includes('secret bookmark path')));
    await assert.rejects(f.stores.workspace.addItem({ kind: 'partition', partitionId: 'any' }, { type: 'file', uri: 'file:///a/newer' }), /disposed/);
    await f.stop();
  });

  test('deactivation waits for a folder transition before flushing all resulting bindings', async () => {
    const f = activationFixture(['a']);
    await f.start();
    const original = f.deps.createMirrorResources;
    let release!: () => void, entered!: () => void;
    const enteredRead = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.deps.createMirrorResources = root => {
      const resource = original(root);
      resource.port.read = async () => { entered(); await barrier; return undefined; };
      return resource;
    };
    // The coordinator captured the original factory; hold the new root through a persisted write.
    const update = f.context.workspaceState.update.bind(f.context.workspaceState);
    f.context.workspaceState.update = async (key, value) => { entered(); await barrier; await update(key, value); };
    const transition = f.change(['a', 'b']);
    await enteredRead;
    let stopped = false;
    const stop = deactivate().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(stopped, false);
    release();
    await Promise.all([transition, stop]);
    assert.ok([...f.resources.values()].every(resource => resource.disposed));
    await f.stop();
  });
});
