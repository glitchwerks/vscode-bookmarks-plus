import * as assert from 'assert';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as vscode from 'vscode';
import { LiveMcpBridgeService, LiveMcpBridgeServiceOptions } from '../../liveMcpBridgeService';
import { BookmarkData } from '../../types';
import { activate, deactivate } from '../../extension';
import { createRemoveHandler, ScopedStores } from '../../commands';
import { RecoveryConflictError, WorkspaceBookmarkStore } from '../../workspaceBookmarkStore';
import { WorkspaceMirrorCoordinator } from '../../workspaceMirrorCoordinator';
import { BookmarksTreeDataProvider } from '../../bookmarksTreeDataProvider';
import { WORKSPACE_PARTITION_STORAGE_KEY, WorkspacePartitionSnapshot } from '../../workspacePartitionTypes';
import { createFakeExtensionContext, FakeMemento, FakeMirror, FakePartitionMirrorResources, FakeOutput } from './fixtures';

/** Real stores/coordinator; only VS Code registrations and filesystem ports are replaced. */
function activationFixture(names = ['a', 'b'], malformed = false) {
  const context = createFakeExtensionContext();
  if (malformed) context.workspaceState = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: { private: 'secret' } });
  let folders = names.map((name, index) => ({ name, index, uri: vscode.Uri.parse('file:///' + name) }));
  const output = Object.assign(new FakeOutput(), { dispose() {}, show() {} });
  const resources = new Map<string, FakePartitionMirrorResources>();
  const files = new Map<string, FakeMirror>();
  let changed: (() => void | Promise<void>) | undefined;
  let stores: ScopedStores<WorkspaceBookmarkStore> | undefined;
  let provider: BookmarksTreeDataProvider | undefined;
  let coordinator: WorkspaceMirrorCoordinator | undefined;
  let mcp: vscode.McpServerDefinitionProvider | undefined;
  let bridge: LiveMcpBridgeService | undefined;
  const lifecycle: string[] = [];
  const deps = {
    isWorkspaceTrusted: () => true,
    startLiveBridge: async (options: LiveMcpBridgeServiceOptions) => {
      assert.ok(options.workspaceStore instanceof WorkspaceBookmarkStore);
      assert.deepStrictEqual(options.globalStore.getAll().items, []);
      lifecycle.push('bridge');
      bridge = await LiveMcpBridgeService.start({ ...options, editorSessionId: randomUUID(), extensionId: 'activation-test' });
      return bridge;
    },
    getWorkspaceFolders: () => folders,
    registerProvider: (_id: string, value: vscode.McpServerDefinitionProvider) => { lifecycle.push('provider'); mcp = value; return new vscode.Disposable(() => {}); },
    onDidChangeWorkspaceFolders: (listener: () => void | Promise<void>) => { changed = listener; return new vscode.Disposable(() => { changed = undefined; }); },
    createOutputChannel: () => output,
    createMirrorResources: (root: vscode.Uri) => {
      const port = files.get(root.toString()) ?? new FakeMirror();
      files.set(root.toString(), port);
      const value = new FakePartitionMirrorResources(port); resources.set(root.toString(), value); return value;
    },
    registerCommands: (_context: vscode.ExtensionContext, value: ScopedStores<WorkspaceBookmarkStore>, tree: BookmarksTreeDataProvider, mirrors: WorkspaceMirrorCoordinator) => {
      stores = value; provider = tree; coordinator = mirrors;
    }
  };
  return {
    context, output, resources, deps, lifecycle,
    get bridge() { assert.ok(bridge, 'activation must start the live bridge'); return bridge; },
    get registeredMcp() { return mcp; },
    get stores() { assert.ok(stores); return stores; },
    get provider() { assert.ok(provider); return provider; },
    get coordinator() { assert.ok(coordinator); return coordinator; },
    get mcp() { assert.ok(mcp); return mcp; },
    async start() { await activate(context as unknown as vscode.ExtensionContext, deps as unknown as Parameters<typeof activate>[1]); },
    async change(names: string[]) {
      folders = names.map((name, index) => ({ name, index, uri: vscode.Uri.parse('file:///' + name) }));
      await changed?.();
    },
    async stop() { await deactivate(); await bridge?.stop(); context.subscriptions.forEach(value => value.dispose()); }
  };
}

/** Holds external I/O at a known boundary without relying on debounce timing. */
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await blocked; } };
}

/** Connects through the actual provider grant and reads complete protocol frames. */
async function connectLive(f: ReturnType<typeof activationFixture>, root = 'file:///a') {
  const token = { isCancellationRequested: false } as vscode.CancellationToken;
  const definitions = await f.mcp.provideMcpServerDefinitions(token) as vscode.McpStdioServerDefinition[];
  const definition = definitions.find(value => value.env.BOOKMARKS_PLUS_ROOT_URI === root)!;
  const resolved = await f.mcp.resolveMcpServerDefinition!(definition, token) as vscode.McpStdioServerDefinition;
  assert.ok(resolved, 'activation must supply a usable live grant');
  const socket = net.createConnection(String(resolved.env.BOOKMARKS_PLUS_BRIDGE_ENDPOINT));
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.on('error', () => {});
  const exchange = (message: object): Promise<{ kind: string; sessionId: string }> => new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { socket.off('data', data); socket.off('close', fail); clearTimeout(timer); };
    const fail = () => { cleanup(); reject(new Error('live bridge closed before response')); };
    const data = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) { cleanup(); resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); }
    };
    const timer = setTimeout(fail, 2_000);
    socket.on('data', data); socket.once('close', fail);
    socket.write(JSON.stringify(message) + '\n');
  });
  await once(socket, 'connect');
  const ready = await exchange({ kind: 'hello', version: 1,
    generation: resolved.env.BOOKMARKS_PLUS_BRIDGE_GENERATION, token: resolved.env.BOOKMARKS_PLUS_BRIDGE_TOKEN });
  assert.strictEqual(ready.kind, 'ready');
  return { socket, closed, exchange, sessionId: ready.sessionId };
}

suite('Extension - partitioned activation (#62)', () => {
  test('failed activation retires its runtime once and permits a clean activation retry', async () => {
    const f = activationFixture(['a']);
    const retry = activationFixture(['a']);
    const order: string[] = [];
    const capture = f.deps.registerCommands;
    const failure = new Error('registration failed after bridge startup');
    let endpoint = '';
    f.deps.registerCommands = (...args) => {
      capture(...args);
      endpoint = f.bridge.issueGrant('file:///a', ['workspace']).endpoint;
      const bridgeStop = f.bridge.stop.bind(f.bridge);
      f.bridge.stop = () => { order.push('bridge'); return bridgeStop(); };
      const drain = f.coordinator.drainAndFlush.bind(f.coordinator);
      f.coordinator.drainAndFlush = () => { order.push('drain'); return drain(); };
      for (const [name, resource] of [['mirrors', f.coordinator], ['workspace', f.stores.workspace], ['global', f.stores.global]] as const) {
        const dispose = resource.dispose.bind(resource);
        resource.dispose = () => { order.push(name); dispose(); };
      }
      throw failure;
    };
    try {
      await assert.rejects(f.start(), error => error === failure);
      assert.deepStrictEqual(order, ['bridge', 'drain', 'mirrors', 'workspace', 'global']);
      assert.throws(() => f.bridge.issueGrant('file:///a', ['workspace']), /bridge-unavailable/);
      const socket = net.createConnection(endpoint);
      await assert.rejects(once(socket, 'connect'));
      assert.ok(f.resources.get('file:///a')!.disposed);
      assert.strictEqual(f.context.subscriptions.length, 0, 'partial registrations must be retired before retry');
      await retry.start();
      const client = await connectLive(retry);
      client.socket.destroy();
      await deactivate();
      assert.deepStrictEqual(order, ['bridge', 'drain', 'mirrors', 'workspace', 'global']);
      await assert.rejects(f.stores.global.addItem({ type: 'file', uri: 'file:///outside' }), /disposed/);
    } finally { await retry.stop(); await f.stop(); }
  });

  test('shutdown shares completion and still persists and disposes once when bridge cleanup rejects', async () => {
    const f = activationFixture(['a']);
    const gate = barrier();
    let client: Awaited<ReturnType<typeof connectLive>> | undefined;
    let outcomes: Promise<PromiseSettledResult<void>[]> | undefined;
    let originalStop: (() => Promise<void>) | undefined;
    try {
      await f.start(); client = await connectLive(f);
      const order: string[] = [];
      const update = f.context.workspaceState.update.bind(f.context.workspaceState);
      f.context.workspaceState.update = async (key, value) => {
        await gate.wait(); await update(key, value); order.push('commit');
      };
      originalStop = f.bridge.stop.bind(f.bridge);
      f.bridge.stop = async () => {
        order.push('bridge'); await originalStop!(); order.push('bridge-error');
        throw new Error('EPERM: private endpoint path');
      };
      const drain = f.coordinator.drainAndFlush.bind(f.coordinator);
      f.coordinator.drainAndFlush = () => { order.push('drain'); return drain(); };
      for (const [name, resource] of [['mirrors', f.coordinator], ['workspace', f.stores.workspace], ['global', f.stores.global]] as const) {
        const dispose = resource.dispose.bind(resource);
        resource.dispose = () => { order.push(name); dispose(); };
      }
      client.socket.write(JSON.stringify({ kind: 'request', id: 'persist-before-error', sessionId: client.sessionId,
        workspaceFolderUri: 'file:///a', method: 'add', params: { type: 'file', uri: 'file:///a/retained' } }) + '\n');
      await gate.entered;
      const first = deactivate(), concurrent = deactivate();
      outcomes = Promise.allSettled([first, concurrent]);
      assert.strictEqual(first, concurrent, 'concurrent callers must share the shutdown operation');
      let finished = false;
      void concurrent.then(() => { finished = true; });
      await client.closed;
      assert.strictEqual(finished, false, 'shutdown cannot settle before admitted work finishes');
      gate.release();
      assert.deepStrictEqual((await outcomes).map(result => result.status), ['fulfilled', 'fulfilled']);
      assert.ok(order.indexOf('commit') < order.indexOf('bridge-error'));
      assert.deepStrictEqual(order.filter(value => value !== 'commit'), ['bridge', 'bridge-error', 'drain', 'mirrors', 'workspace', 'global']);
      assert.strictEqual(deactivate(), first, 'later callers must observe the completed operation');
      await deactivate();
      assert.strictEqual(order.filter(value => value === 'bridge').length, 1);
      assert.strictEqual(JSON.parse(f.resources.get('file:///a')!.port.content!).items[0].uri, 'file:///a/retained');
      assert.strictEqual(f.output.lines.filter(line => /bridge.*shutdown failed/i.test(line)).length, 1);
      assert.ok(f.output.lines.every(line => !line.includes('private endpoint path')));
    } finally {
      gate.release(); client?.socket.destroy(); await outcomes;
      if (originalStop) f.bridge.stop = originalStop;
      await f.stop();
      f.coordinator.dispose(); f.stores.workspace.dispose(); f.stores.global.dispose();
    }
  });

  test('trusted activation starts the bridge after store initialization and before provider registration', async () => {
    const f = activationFixture(['a']);
    try {
      await f.start();
      assert.deepStrictEqual(f.lifecycle, ['bridge', 'provider']);
      const token = { isCancellationRequested: false } as vscode.CancellationToken;
      const definition = (await f.mcp.provideMcpServerDefinitions(token))![0];
      const resolved = await f.mcp.resolveMcpServerDefinition!(definition, token) as vscode.McpStdioServerDefinition;
      assert.ok(resolved?.env.BOOKMARKS_PLUS_BRIDGE_TOKEN, 'provider resolution must use the activation bridge issuer');
    } finally { await f.stop(); }
  });

  test('untrusted activation opens no listener and registers no native provider', async () => {
    const f = activationFixture(['a']);
    f.deps.isWorkspaceTrusted = () => false;
    try {
      await f.start();
      assert.deepStrictEqual(f.lifecycle, []);
      assert.strictEqual(f.registeredMcp, undefined);
      await f.stores.global.addItem({ type: 'file', uri: 'file:///global' });
    } finally { await f.stop(); }
  });

  test('packaged commands resolve through the provider and return defensive owner-scoped snapshots', async () => {
    const f = activationFixture();
    const previous = process.env.BOOKMARKS_PACKAGED_MCP_TEST;
    process.env.BOOKMARKS_PACKAGED_MCP_TEST = '1';
    try {
      await f.start();
      const definitions = await vscode.commands.executeCommand<vscode.McpStdioServerDefinition[]>('bookmarks.test.getMcpServerDefinitions');
      assert.ok(definitions);
      const resolved = await vscode.commands.executeCommand<vscode.McpStdioServerDefinition>(
        'bookmarks.test.resolveMcpServerDefinition', 'file:///a');
      assert.ok(resolved?.env.BOOKMARKS_PLUS_BRIDGE_TOKEN);
      assert.strictEqual(definitions[0].env.BOOKMARKS_PLUS_BRIDGE_TOKEN, undefined);
      const owner = f.stores.workspace.resolveAttachedOwner(vscode.Uri.parse('file:///a/item'))!;
      await f.stores.workspace.addItem(owner, { type: 'file', uri: 'file:///a/item' });
      await f.stores.global.addItem({ type: 'file', uri: 'file:///global' });
      const read = () => vscode.commands.executeCommand<{ workspace: BookmarkData; global: BookmarkData }>(
        'bookmarks.test.getScopedBookmarkState', 'file:///a');
      const state = (await read())!;
      assert.deepStrictEqual(state.workspace.items.map(item => item.uri), ['file:///a/item']);
      assert.deepStrictEqual(state.global.items.map(item => item.uri), ['file:///global']);
      state.workspace.items[0].uri = 'file:///tampered'; state.global.items.length = 0;
      assert.deepStrictEqual((await read())!.workspace.items.map(item => item.uri), ['file:///a/item']);
      assert.strictEqual((await read())!.global.items.length, 1);
      assert.strictEqual(await vscode.commands.executeCommand('bookmarks.test.getScopedBookmarkState', 'file:///missing'), undefined);
    } finally {
      await f.stop();
      if (previous === undefined) delete process.env.BOOKMARKS_PACKAGED_MCP_TEST;
      else process.env.BOOKMARKS_PACKAGED_MCP_TEST = previous;
    }
  });

  test('listener startup failure leaves UI stores usable and native resolution unavailable', async () => {
    const f = activationFixture(['a']);
    f.deps.startLiveBridge = async () => { throw new Error('private endpoint'); };
    try {
      await f.start();
      const token = {} as vscode.CancellationToken;
      const definition = (await f.mcp.provideMcpServerDefinitions(token))![0];
      assert.strictEqual(await f.mcp.resolveMcpServerDefinition!(definition, token), undefined);
      await f.stores.global.addItem({ type: 'file', uri: 'file:///global' });
      assert.ok(f.output.lines.some(line => /bridge.*failed/i.test(line)));
      assert.ok(f.output.lines.every(line => !line.includes('private endpoint')));
    } finally { await f.stop(); }
  });

  test('committed root changes refresh the bridge, retain unrelated sessions, and close the removed root', async () => {
    const f = activationFixture();
    let a: Awaited<ReturnType<typeof connectLive>> | undefined;
    let b: Awaited<ReturnType<typeof connectLive>> | undefined;
    try {
      await f.start();
      a = await connectLive(f); b = await connectLive(f, 'file:///b');
      const seen: string[][] = [];
      const refresh = f.bridge.refreshAvailableRoots.bind(f.bridge);
      f.bridge.refreshAvailableRoots = () => {
        seen.push(f.stores.workspace.getView().attached.map(root => root.rootUri)); refresh();
      };
      await f.change(['b', 'a', 'c']);
      assert.deepStrictEqual(seen, [['file:///b', 'file:///a', 'file:///c']]);
      assert.strictEqual((await a.exchange({ kind: 'request', id: '1', sessionId: a.sessionId,
        workspaceFolderUri: 'file:///a', method: 'list', params: {} })).kind, 'response');
      await f.change(['a', 'c']);
      assert.deepStrictEqual(seen[1], ['file:///a', 'file:///c']);
      await b.closed;
      assert.strictEqual((await a.exchange({ kind: 'request', id: '2', sessionId: a.sessionId,
        workspaceFolderUri: 'file:///a', method: 'list', params: {} })).kind, 'response');
    } finally { a?.socket.destroy(); b?.socket.destroy(); await f.stop(); }
  });

  test('shutdown fences resolution, closes bridge, drains an admitted mutation, then mirrors and stores', async () => {
    const f = activationFixture(['a']);
    const gate = barrier();
    let client: Awaited<ReturnType<typeof connectLive>> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      await f.start(); client = await connectLive(f);
      const order: string[] = [];
      const update = f.context.workspaceState.update.bind(f.context.workspaceState);
      f.context.workspaceState.update = async (key, value) => {
        await gate.wait(); await update(key, value); order.push('commit');
      };
      const stopBridge = f.bridge.stop.bind(f.bridge);
      f.bridge.stop = () => { order.push('bridge-stop'); return stopBridge(); };
      const drain = f.coordinator.drainAndFlush.bind(f.coordinator);
      f.coordinator.drainAndFlush = () => { order.push('mirrors'); return drain(); };
      for (const [name, store] of [['workspace', f.stores.workspace], ['global', f.stores.global]] as const) {
        const dispose = store.dispose.bind(store);
        store.dispose = () => { order.push(name); dispose(); };
      }
      client.socket.write(JSON.stringify({ kind: 'request', id: 'mutation', sessionId: client.sessionId,
        workspaceFolderUri: 'file:///a', method: 'add', params: { type: 'file', uri: 'file:///a/admitted' } }) + '\n');
      await gate.entered;
      stopping = deactivate();
      const token = {} as vscode.CancellationToken;
      const definition = (await f.mcp.provideMcpServerDefinitions(token))![0];
      assert.strictEqual(await f.mcp.resolveMcpServerDefinition!(definition, token), undefined);
      await client.closed;
      assert.deepStrictEqual(order, ['bridge-stop']);
      assert.throws(() => f.bridge.issueGrant('file:///a', ['workspace']), /bridge-unavailable/);
      gate.release(); await stopping;
      assert.ok(order.indexOf('commit') < order.indexOf('mirrors'));
      assert.deepStrictEqual(order.filter(value => value !== 'commit'), ['bridge-stop', 'mirrors', 'workspace', 'global']);
      assert.strictEqual(JSON.parse(f.resources.get('file:///a')!.port.content!).items[0].uri, 'file:///a/admitted');
    } finally { gate.release(); client?.socket.destroy(); await stopping; await f.stop(); }
  });
  for (const owner of ['attached', 'detached', 'unassigned']) {
    test(`unsupported ${owner} content stays untouched with no workspace mirrors and Global available`, async () => {
      const f = activationFixture(['a']);
      const snapshot: WorkspacePartitionSnapshot = {
        version: 1, partitions: [{ id: '00000000-0000-4000-8000-000000000001',
          attachment: owner === 'detached' ? null : { rootUri: 'file:///a', canonicalRootUri: 'file:///a' },
          lastKnownRootUri: 'file:///a', canonicalLastKnownRootUri: 'file:///a', replacementEligible: true,
          data: { version: owner === 'unassigned' ? 2 : 999, collections: [], items: [] }, mirror: { dirty: false } }],
        unassigned: { version: owner === 'unassigned' ? 999 : 2, collections: [], items: [] }
      };
      f.context.workspaceState = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
      try {
        await f.start();
        assert.strictEqual(f.stores.workspace.getView().kind, 'unavailable');
        assert.strictEqual(f.context.workspaceState.updateCallCount, 0);
        assert.deepStrictEqual(f.context.workspaceState.get(WORKSPACE_PARTITION_STORAGE_KEY), snapshot);
        assert.strictEqual(f.resources.size, 0);
        await f.stores.global.addItem({ type: 'file', uri: 'file:///global' });
        assert.strictEqual(f.stores.global.getAll().items.length, 1);
      } finally { await f.stop(); }
    });
  }

  test('canonical collision suspends existing mirrors and resumes the same partition when unique', async () => {
    const f = activationFixture(['a']);
    try {
      await f.start();
      const store = f.stores.workspace;
      const owner = store.resolveAttachedOwner(vscode.Uri.parse('file:///a/file'))!;
      await store.addItem(owner, { type: 'file', uri: 'file:///a/file' });
      await f.coordinator.flushAll();
      const before = store.getOwnerData(owner);
      const original = f.resources.get('file:///a')!;
      await f.change(['a', 'a/']);
      assert.strictEqual(original.disposed, true);
      assert.strictEqual(store.getView().attached.length, 1);
      assert.deepStrictEqual(store.getOwnerData(owner), before);
      const reads = original.port.readCount, writes = original.port.writeCount;
      original.change.fire(); original.create.fire(); original.delete.fire();
      await f.coordinator.reloadPartition(store.getView().attached[0].partitionId);
      await f.coordinator.flushAll();
      assert.strictEqual(original.port.readCount, reads);
      assert.strictEqual(original.port.writeCount, writes);
      await f.change(['a']);
      assert.notStrictEqual(f.resources.get('file:///a'), original);
      assert.strictEqual(f.resources.get('file:///a')!.disposed, false);
      assert.deepStrictEqual(store.getOwnerData(owner), before);
      await store.addCollection(owner, 'Available again');
    } finally { await f.stop(); }
  });

  test('canonical collision rejects new collections and items without persistence', async () => {
    const f = activationFixture(['a']);
    try {
      await f.start();
      const store = f.stores.workspace;
      const owner = store.resolveAttachedOwner(vscode.Uri.parse('file:///a/file'))!;
      await f.change(['a', 'a/']);
      const writes = f.context.workspaceState.updateCallCount;
      await assert.rejects(store.addCollection(owner, 'Unavailable'));
      await assert.rejects(store.addItem(owner, { type: 'file', uri: 'file:///a/file' }));
      assert.strictEqual(f.context.workspaceState.updateCallCount, writes);
    } finally { await f.stop(); }
  });

  for (const withGlobal of [false, true]) {
    test(`resource removal finds encoded-equivalent workspace bookmarks with Global=${withGlobal}`, async () => {
      const f = activationFixture(['a']);
      try {
        await f.start();
        const uri = vscode.Uri.parse('file:///a/file.ts');
        const owner = f.stores.workspace.resolveAttachedOwner(uri)!;
        await f.stores.workspace.addItem(owner, { type: 'file', uri: 'file:///a/%66ile.ts' });
        if (withGlobal) await f.stores.global.addItem({ type: 'file', uri: uri.toString() });
        await createRemoveHandler(f.stores)(uri);
        assert.deepStrictEqual(f.stores.workspace.getOwnerData(owner)!.items, []);
        assert.strictEqual(f.stores.global.getAll().items.length, withGlobal ? 1 : 0);
      } finally { await f.stop(); }
    });
  }

  test('encoded-equivalent matches across owners prompt once and preserve the unselected and Global copies', async () => {
    const f = activationFixture(['a']);
    try {
      await f.start();
      const store = f.stores.workspace;
      const uri = vscode.Uri.parse('file:///a/child/file.ts');
      const parent = store.resolveAttachedOwner(uri)!;
      await store.addItem(parent, { type: 'file', uri: 'file:///a/child/%66ile.ts' });
      await f.change(['a', 'a/child']);
      const child = store.resolveAttachedOwner(uri)!;
      await store.addItem(child, { type: 'file', uri: 'file:///a/child/f%69le.ts' });
      await f.stores.global.addItem({ type: 'file', uri: uri.toString() });
      let choices = 0;
      await createRemoveHandler(f.stores, { showQuickPick: async items => { choices = items.length; return items[1]; } })(uri);
      assert.strictEqual(choices, 2);
      assert.strictEqual(store.getOwnerData(parent)!.items.length, 1);
      assert.strictEqual(store.getOwnerData(child)!.items.length, 0);
      assert.strictEqual(f.stores.global.getAll().items.length, 1);
    } finally { await f.stop(); }
  });

  test('salvage atomically rejects a resolving rewrite owned by an attached nested destination', async () => {
    const f = activationFixture(['anchor', 'old']);
    try {
      await f.start();
      const store = f.stores.workspace;
      const owner = store.resolveAttachedOwner(vscode.Uri.parse('file:///old/file'))!;
      await store.addItem(owner, { type: 'file', uri: 'file:///old/file' });
      await store.addItem(owner, { type: 'file', uri: 'file:///old/child/file' });
      await f.change(['anchor', 'new', 'new/child']);
      const before = f.context.workspaceState.get(WORKSPACE_PARTITION_STORAGE_KEY);
      const writes = f.context.workspaceState.updateCallCount;
      await assert.rejects(store.previewRecovery(store.getView().detached[0].partitionId,
        { id: 'new', label: 'new', uri: vscode.Uri.parse('file:///new') }, 'salvage',
        { stat: async () => ({ type: vscode.FileType.File, size: 0, ctime: 0, mtime: 0 }) }), RecoveryConflictError);
      await f.coordinator.drainAndFlush();
      assert.deepStrictEqual(f.context.workspaceState.get(WORKSPACE_PARTITION_STORAGE_KEY), before);
      assert.strictEqual(f.context.workspaceState.updateCallCount, writes);
      assert.deepStrictEqual(JSON.parse(f.resources.get('file:///new')!.port.content!).items, []);
      assert.deepStrictEqual(store.getOwnerData(owner)!.items.map(item => item.uri), ['file:///old/file', 'file:///old/child/file']);
    } finally { await f.stop(); }
  });

  for (const mode of ['reattach-only', 'salvage'] as const) {
    test(`${mode} recovery overwrites the persistent empty destination mirror even without URI rewrites`, async () => {
      const f = activationFixture(['anchor', 'old']);
      try {
        await f.start();
        const store = f.stores.workspace;
        const owner = store.resolveAttachedOwner(vscode.Uri.parse('file:///old/file'))!;
        const collection = await store.addCollection(owner, 'Preserved');
        await store.addItem(owner, { type: 'file', uri: 'file:///old/file', collectionId: collection.id });
        await f.coordinator.flushAll();
        const before = store.getOwnerData(owner);
        await f.change(['anchor', 'new']);
        const replacement = f.resources.get('file:///new')!;
        assert.deepStrictEqual(JSON.parse(replacement.port.content!).items, []);
        const preview = await store.previewRecovery(store.getView().detached[0].partitionId,
          { id: 'new', label: 'new', uri: vscode.Uri.parse('file:///new') }, mode,
          { stat: async () => { throw new Error('missing'); } });
        await store.commitRecovery(preview.token);
        await f.coordinator.reconcileBindings();
        assert.strictEqual(replacement.disposed, true);
        assert.strictEqual(f.resources.get('file:///new')!.port, replacement.port, 'filesystem content survives watcher recreation');
        assert.deepStrictEqual(store.getOwnerData(owner), before);
        assert.deepStrictEqual(JSON.parse(replacement.port.content!), before);
      } finally { await f.stop(); }
    });
  }

  test('folder changes during migration are reconciled before activation completes', async () => {
    const f = activationFixture(['a']);
    const gate = barrier();
    const update = f.context.workspaceState.update.bind(f.context.workspaceState);
    let firstWrite = true;
    f.context.workspaceState.update = async (key, value) => {
      if (key === WORKSPACE_PARTITION_STORAGE_KEY && firstWrite) {
        firstWrite = false; await gate.wait();
      }
      await update(key, value);
    };
    const start = f.start();
    try {
      await gate.entered;
      const change = f.change(['a', 'b']);
      gate.release();
      await Promise.all([start, change]);
      assert.deepStrictEqual(f.stores.workspace.getView().attached.map(root => root.rootUri), ['file:///a', 'file:///b']);
      assert.deepStrictEqual([...f.resources.keys()].sort(), ['file:///a', 'file:///b']);
      const definitions = await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken);
      assert.deepStrictEqual(definitions?.map(value => (value as vscode.McpStdioServerDefinition).args[1]),
        [vscode.Uri.parse('file:///a').fsPath, vscode.Uri.parse('file:///b').fsPath]);
      assert.strictEqual(f.context.environmentVariableCollection.calls.at(-1)!.value, 'disabled:multi-root');
    } finally { gate.release(); await start; await f.stop(); }
  });

  test('folder changes during initial mirror reads retire obsolete watchers before activation completes', async () => {
    const f = activationFixture();
    const gate = barrier();
    const create = f.deps.createMirrorResources;
    f.deps.createMirrorResources = root => {
      const resource = create(root);
      if (root.toString() === 'file:///b') {
        resource.port.read = async () => { await gate.wait(); return undefined; };
      }
      return resource;
    };
    const start = f.start();
    try {
      await gate.entered;
      const change = f.change(['a', 'c']);
      gate.release();
      await Promise.all([start, change]);
      assert.deepStrictEqual(f.stores.workspace.getView().attached.map(root => root.rootUri), ['file:///a', 'file:///c']);
      assert.strictEqual(f.resources.get('file:///b')!.disposed, true);
      assert.strictEqual(f.resources.get('file:///c')!.disposed, false);
      const definitions = await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken);
      assert.deepStrictEqual(definitions?.map(value => (value as vscode.McpStdioServerDefinition).args[1]),
        [vscode.Uri.parse('file:///a').fsPath, vscode.Uri.parse('file:///c').fsPath]);
      assert.strictEqual(f.context.environmentVariableCollection.calls.at(-1)!.value, 'disabled:multi-root');
    } finally { gate.release(); await start; await f.stop(); }
  });

  test('native definitions exclude an attached canonical collision and restore it when unique again', async () => {
    const f = activationFixture(['a']);
    try {
      await f.start();
      const partitionId = f.stores.workspace.getView().attached[0].partitionId;
      let events = 0;
      f.mcp.onDidChangeMcpServerDefinitions?.(() => events++);
      assert.strictEqual((await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken))?.length, 1);
      await f.change(['a', 'a']);
      assert.deepStrictEqual(f.stores.workspace.getView().unavailableRoots, ['file:///a']);
      assert.strictEqual(f.stores.workspace.getView().attached[0].partitionId, partitionId);
      assert.deepStrictEqual(await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken), []);
      assert.strictEqual(events, 1);
      await f.change(['a']);
      assert.strictEqual(f.stores.workspace.getView().attached[0].partitionId, partitionId);
      assert.strictEqual((await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken))?.length, 1);
      assert.strictEqual(events, 2);
    } finally { await f.stop(); }
  });

  for (const failure of ['malformed snapshot', 'persistence failure']) {
    test(`terminal environment follows actual folders after ${failure}`, async () => {
      const f = activationFixture(['a'], failure === 'malformed snapshot');
      try {
        await f.start();
        if (failure === 'persistence failure') f.context.workspaceState.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
        await f.change(['a', 'b']);
        assert.strictEqual(f.context.environmentVariableCollection.calls.at(-1)!.value, 'disabled:multi-root');
        assert.strictEqual(f.stores.workspace.getView().attached.length, failure === 'malformed snapshot' ? 0 : 1);
        await f.change(['a']);
        assert.strictEqual(f.context.environmentVariableCollection.calls.at(-1)!.value, vscode.Uri.parse('file:///a').fsPath);
      } finally { await f.stop(); }
    });
  }

  test('older queued root commits cannot overwrite the latest terminal topology', async () => {
    const f = activationFixture();
    const gate = barrier();
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    try {
      await f.start();
      const uri = vscode.Uri.parse('file:///b/file');
      await f.stores.workspace.addItem(f.stores.workspace.resolveAttachedOwner(uri)!, { type: 'file', uri: uri.toString() });
      const port = f.resources.get('file:///b')!.port;
      const write = port.write.bind(port);
      port.write = async content => { await gate.wait(); await write(content); };
      first = f.change(['a']);
      await gate.entered;
      second = f.change(['a', 'c']);
      const seen: string[] = [];
      f.stores.workspace.onDidChangePartitions(() => {
        seen.push(f.context.environmentVariableCollection.calls.at(-1)!.value);
      });
      gate.release();
      await Promise.all([first, second]);
      assert.deepStrictEqual(seen, ['disabled:multi-root', 'disabled:multi-root']);
    } finally { gate.release(); await Promise.all([first, second]); await f.stop(); }
  });

  for (const recoveryState of ['committed', 'pending']) {
    test(`deactivation drains ${recoveryState} recovery and waits for the destination write and bookkeeping`, async () => {
      const f = activationFixture(['anchor', 'old']);
      const gate = barrier();
      const commitGate = barrier();
      let holdRecoveredWrite = false;
      const create = f.deps.createMirrorResources;
      f.deps.createMirrorResources = root => {
        const resource = create(root);
        if (root.toString() === 'file:///new' && holdRecoveredWrite) {
          const write = resource.port.write.bind(resource.port);
          resource.port.write = async content => { await gate.wait(); await write(content); };
        }
        return resource;
      };
      let stop: Promise<void> | undefined;
      let commit: Promise<void> | undefined;
      try {
        await f.start();
        const store = f.stores.workspace;
        const owner = store.resolveAttachedOwner(vscode.Uri.parse('file:///old/file'))!;
        assert.strictEqual(owner.kind, 'partition');
        await store.addItem(owner, { type: 'file', uri: 'file:///old/file' });
        await f.change(['anchor', 'new']);
        const retired = f.resources.get('file:///new')!;
        const preview = await store.previewRecovery(store.getView().detached[0].partitionId,
          { id: 'new', label: 'new', uri: vscode.Uri.parse('file:///new') }, 'salvage',
          { stat: async () => ({ type: vscode.FileType.File, size: 0, ctime: 0, mtime: 0 }) });
        holdRecoveredWrite = true;
        if (recoveryState === 'pending') {
          const update = f.context.workspaceState.update.bind(f.context.workspaceState);
          f.context.workspaceState.update = async (key, value) => { await commitGate.wait(); await update(key, value); };
        }
        commit = store.commitRecovery(preview.token);
        if (recoveryState === 'pending') await commitGate.entered;
        else await commit;
        let stopped = false;
        stop = deactivate().then(() => { stopped = true; });
        if (recoveryState === 'pending') {
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.strictEqual(stopped, false, 'shutdown must wait for the accepted recovery commit');
          commitGate.release();
          await commit;
        }
        await gate.entered;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(stopped, false, 'shutdown must wait for recovered mirror content');
        assert.strictEqual(f.resources.get('file:///new')!.disposed, false);
        gate.release();
        await stop;
        assert.strictEqual(retired.disposed, true);
        assert.strictEqual(f.resources.get('file:///new')!.disposed, true);
        assert.deepStrictEqual(JSON.parse(f.resources.get('file:///new')!.port.content!).items.map((item: { uri: string }) => item.uri), ['file:///new/file']);
        assert.strictEqual(store.getMirrorState(store.getView().attached.find(root => root.rootUri === 'file:///new')!.partitionId)!.dirty, false);
      } finally { commitGate.release(); gate.release(); await commit; await stop; await f.stop(); }
    });
  }

  test('activation accepts a Windows drive URI after persistence serialization', async () => {
    const f = activationFixture(['C:/Work/Repo']);
    try {
      await f.start();
      assert.strictEqual(f.stores.workspace.getView().kind, 'ready', f.output.lines.join('\n'));
      assert.strictEqual(f.resources.size, 1);
      assert.strictEqual((await f.mcp.provideMcpServerDefinitions({} as vscode.CancellationToken))?.length, 1);
    } finally { await f.stop(); }
  });

  test('deactivation flushes edits accepted while another root write is draining', async () => {
    const f = activationFixture();
    const gate = barrier();
    let stop: Promise<void> | undefined;
    try {
      await f.start();
      const store = f.stores.workspace;
      const ownerA = store.resolveAttachedOwner(vscode.Uri.parse('file:///a/first'))!;
      const ownerB = store.resolveAttachedOwner(vscode.Uri.parse('file:///b/first'))!;
      await store.addItem(ownerA, { type: 'file', uri: 'file:///a/first' });
      await store.addItem(ownerB, { type: 'file', uri: 'file:///b/first' });
      const port = f.resources.get('file:///b')!.port;
      const write = port.write.bind(port);
      port.write = async content => { await gate.wait(); await write(content); };
      stop = deactivate();
      await gate.entered;
      await new Promise<void>(resolve => setImmediate(resolve));
      await store.addItem(ownerA, { type: 'file', uri: 'file:///a/later' });
      gate.release();
      await stop;
      assert.deepStrictEqual(JSON.parse(f.resources.get('file:///a')!.port.content!).items.map((item: { uri: string }) => item.uri),
        ['file:///a/first', 'file:///a/later']);
    } finally { gate.release(); await stop; await f.stop(); }
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

  test('deactivation waits for a watcher read accepted after its root flushed and completes its rewrite', async () => {
    const f = activationFixture();
    const writeB = barrier(), readA = barrier(), rewriteA = barrier();
    let stop: Promise<void> | undefined;
    try {
      await f.start();
      const store = f.stores.workspace;
      const ownerB = store.resolveAttachedOwner(vscode.Uri.parse('file:///b/first'))!;
      await store.addItem(ownerB, { type: 'file', uri: 'file:///b/first' });
      const resourceA = f.resources.get('file:///a')!;
      const resourceB = f.resources.get('file:///b')!;
      const originalWriteB = resourceB.port.write.bind(resourceB.port);
      resourceB.port.write = async content => { await writeB.wait(); await originalWriteB(content); };
      let stopped = false;
      stop = deactivate().then(() => { stopped = true; });
      await writeB.entered;
      // A's empty flush has settled; B still holds the shutdown flush open.
      await f.coordinator.flushPartition(store.getView().attached.find(root => root.rootUri === 'file:///a')!.partitionId);
      resourceA.port.read = async () => {
        await readA.wait();
        return JSON.stringify({ version: 2, collections: [], items: [
          { id: 'external-id-needs-repair', type: 'file', uri: 'file:///a/external', collectionId: null, order: 0 }
        ] });
      };
      const originalWriteA = resourceA.port.write.bind(resourceA.port);
      resourceA.port.write = async content => { await rewriteA.wait(); await originalWriteA(content); };
      resourceA.change.fire();
      await readA.entered;
      writeB.release();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.strictEqual(stopped, false, 'accepted watcher reads must settle before shutdown returns');
      assert.strictEqual(resourceA.disposed, false);
      readA.release();
      await rewriteA.entered;
      assert.strictEqual(stopped, false, 'the imported payload rewrite must finish before disposal');
      assert.strictEqual(resourceA.disposed, false);
      rewriteA.release();
      await stop;
      const partition = store.getView().attached.find(root => root.rootUri === 'file:///a')!;
      assert.deepStrictEqual(partition.data.items.map(item => item.uri), ['file:///a/external']);
      assert.notStrictEqual(partition.data.items[0].id, 'external-id-needs-repair');
      assert.deepStrictEqual(JSON.parse(resourceA.port.content!).items, partition.data.items);
      assert.strictEqual(store.getMirrorState(partition.partitionId)!.dirty, false);
      assert.strictEqual(resourceA.disposed, true);
      assert.strictEqual(resourceB.disposed, true);
    } finally { writeB.release(); readA.release(); rewriteA.release(); await stop; await f.stop(); }
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
