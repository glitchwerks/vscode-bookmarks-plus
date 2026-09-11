import * as assert from 'assert';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BookmarkStore } from '../../bookmarkStore';
import { WorkspaceBookmarkStore } from '../../workspaceBookmarkStore';
import { LiveMcpBridgeService, IssuedLiveBridgeGrant, LiveMcpBridgeServiceOptions } from '../../liveMcpBridgeService';
import { BookmarkData, BookmarkScope } from '../../types';
import { BridgeReady, BridgeResponse, MAX_LIVE_BRIDGE_FRAME_BYTES } from '../../liveMcpBridgeProtocol';
import { FakeMemento, FakeOutput } from './fixtures';

const ROOT = 'file:///workspace/a';

/** Reads one correlated response, rejecting a silent disconnect rather than timing out. */
function request(socket: net.Socket, sessionId: string, method = 'list',
  params: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Promise<BridgeResponse> {
  const envelope = { kind: 'request', id: randomUUID(), sessionId, workspaceFolderUri: ROOT, method, params, ...overrides };
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timer); socket.off('data', onData); socket.off('close', onClose);
    };
    const onClose = () => { cleanup(); reject(new Error('Bridge closed without a request response')); };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as BridgeResponse;
        buffer = buffer.slice(newline + 1);
        if (message.id === envelope.id) { cleanup(); resolve(message); return; }
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Missing bridge response')); }, 2_000);
    socket.on('data', onData); socket.once('close', onClose);
    socket.write(JSON.stringify(envelope) + '\n');
  });
}

/** Sends a real IPC hello and reads its first complete response. */
async function hello(grant: IssuedLiveBridgeGrant, overrides: Record<string, unknown> = {}) {
  const socket = net.createConnection(grant.endpoint);
  const response = new Promise<Partial<Omit<BridgeReady, 'kind'>> & { kind?: string; error?: BridgeResponse['error'] }>((resolve, reject) => {
    let buffer = '';
    socket.on('error', reject);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) {
        socket.off('data', onData);
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
      }
    };
    socket.on('data', onData);
    socket.on('end', () => reject(new Error('Bridge ended before responding')));
  });
  socket.on('connect', () => socket.write(JSON.stringify({
    kind: 'hello', version: 1, generation: grant.generation, token: grant.token, ...overrides
  }) + '\n'));
  try { return { socket, message: await response }; }
  catch (error) { socket.destroy(); throw error; }
}

suite('LiveMcpBridgeService authentication', () => {
  let service: LiveMcpBridgeService;
  let workspaceStore: WorkspaceBookmarkStore;
  let globalStore: BookmarkStore;
  let options: LiveMcpBridgeServiceOptions;
  let currentRoot: ReturnType<LiveMcpBridgeServiceOptions['getAttachedRoot']>;
  let now: number;
  let tempDirectory: string;
  let globalState: FakeMemento;
  let workspaceState: FakeMemento;
  const clients: net.Socket[] = [];

  setup(async () => {
    now = 1_000;
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-'));
    workspaceState = new FakeMemento();
    workspaceStore = await WorkspaceBookmarkStore.create({
      state: workspaceState, output: new FakeOutput(),
      roots: [{ id: 'a', label: 'A', uri: vscode.Uri.parse(ROOT) }]
    });
    globalState = new FakeMemento();
    globalStore = new BookmarkStore(globalState);
    currentRoot = { rootUri: ROOT, canonicalRootUri: ROOT,
      owner: { kind: 'partition', partitionId: workspaceStore.getView().attached[0].partitionId } };
    let randomSequence = 0;
    options = {
      workspaceStore, globalStore, output: new FakeOutput(), editorSessionId: randomUUID(),
      extensionId: 'test.bookmarks-plus', tempDirectory, now: () => now,
      randomBytes: (size: number) => { const bytes = Buffer.alloc(size, 7); bytes.writeUInt32BE(++randomSequence); return bytes; },
      getAttachedRoot: (root: string) => root === ROOT ? currentRoot : undefined
    };
    service = await LiveMcpBridgeService.start(options);
  });

  teardown(async () => {
    for (const socket of clients.splice(0)) { socket.destroy(); }
    await service?.stop();
    workspaceStore.dispose();
    globalStore.dispose();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  /** Authenticates and registers each real socket for teardown. */
  async function authenticate(grant: IssuedLiveBridgeGrant, overrides?: Record<string, unknown>) {
    const result = await hello(grant, overrides);
    clients.push(result.socket);
    return result;
  }

  /** Opens an authenticated client over the production listener. */
  async function client(scopes: BookmarkScope[] = ['workspace', 'global']) {
    const { socket, message } = await authenticate(service.issueGrant(ROOT, scopes));
    assert.ok(message.sessionId);
    return { socket, sessionId: message.sessionId };
  }

  test('lists workspace before global, preserving store order and decorating only granted records', async () => {
    const owner = currentRoot!.owner;
    await workspaceStore.addCollection(owner, 'Workspace first');
    await workspaceStore.addCollection(owner, 'Workspace second');
    await globalStore.addCollection('Global first');
    await workspaceStore.addItem(owner, { type: 'file', uri: ROOT + '/first' });
    await workspaceStore.addItem(owner, { type: 'file', uri: ROOT + '/second' });
    await globalStore.addItem({ type: 'file', uri: 'file:///outside/global' });
    for (const scopes of [['global', 'workspace'], ['workspace'], ['global']] as BookmarkScope[][]) {
      const { socket, sessionId } = await client(scopes);
      const response = await request(socket, sessionId);
      assert.strictEqual(response.error, undefined);
      const result = response.result as BookmarkData & { grantedScopes: BookmarkScope[]; workspaceFolderUri: string };
      assert.strictEqual(result.version, 2);
      assert.strictEqual(result.workspaceFolderUri, ROOT);
      assert.deepStrictEqual(result.grantedScopes, scopes);
      const expectedScopes = scopes.length === 2 ? ['workspace', 'workspace', 'global']
        : scopes[0] === 'workspace' ? ['workspace', 'workspace'] : ['global'];
      assert.deepStrictEqual(result.collections.map(value => (value as unknown as { scope: string }).scope), expectedScopes);
      assert.deepStrictEqual(result.items.map(value => (value as unknown as { scope: string }).scope), expectedScopes);
      assert.deepStrictEqual(result.items.map(value => value.uri), scopes.length === 2
        ? [ROOT + '/first', ROOT + '/second', 'file:///outside/global']
        : scopes[0] === 'workspace' ? [ROOT + '/first', ROOT + '/second'] : ['file:///outside/global']);
      assert.ok(!('workspacePath' in result)); assert.ok(!('mirrorPath' in result));
    }
  });

  test('defaults omitted scope to workspace for both grants and to the sole granted scope', async () => {
    for (const [index, scopes] of ([['workspace', 'global'], ['workspace'], ['global']] as BookmarkScope[][]).entries()) {
      const { socket, sessionId } = await client(scopes);
      const response = await request(socket, sessionId, 'add', { uri: ROOT + '/' + index, type: 'file', description: '  note  ' });
      const result = response.result as { id: string; scope: string; collection: null };
      assert.strictEqual(response.error, undefined);
      assert.strictEqual(result.scope, scopes.length === 1 ? scopes[0] : 'workspace');
      assert.strictEqual(result.collection, null);
      assert.ok(!('mirrorPath' in result));
      const data = result.scope === 'workspace' ? workspaceStore.getOwnerData(currentRoot!.owner)! : globalStore.getAll();
      assert.strictEqual(data.items.find(item => item.id === result.id)?.description, 'note');
    }
  });

  test('resolves colliding collection IDs and names only in the selected scope', async () => {
    const collection = await workspaceStore.addCollection(currentRoot!.owner, 'Workspace collection');
    await globalState.update('bookmarks.data', { version: 2, collections: [{ ...collection, name: 'Global collection' }], items: [] });
    globalStore.dispose(); globalStore = new BookmarkStore(globalState);
    await service.stop(); service = await LiveMcpBridgeService.start({ ...options, globalStore });
    const { socket, sessionId } = await client();
    for (const scope of ['workspace', 'global']) {
      const response = await request(socket, sessionId, 'add', { scope, uri: ROOT + '/item', type: 'file', collectionId: collection.id });
      assert.deepStrictEqual(response.result, {
        id: (response.result as { id: string }).id, scope,
        collection: { ...collection, name: scope === 'workspace' ? 'Workspace collection' : 'Global collection', scope }
      });
    }
    assert.strictEqual((await request(socket, sessionId, 'add', {
      scope: 'workspace', uri: ROOT + '/other', type: 'file', collectionName: 'Global collection'
    })).error?.code, 'collection-not-found');
    const named = await request(socket, sessionId, 'add', {
      scope: 'global', uri: ROOT + '/named', type: 'folder', collectionName: 'Global collection'
    });
    assert.strictEqual((named.result as { collection: { id: string } }).collection.id, collection.id);
  });

  test('maps a collection deleted after resolution to collection-not-found without a dangling Global item', async () => {
    const collection = await globalStore.addCollection('Removed');
    const { socket, sessionId } = await client(['global']);
    const update = globalState.update.bind(globalState);
    let signalDeleteStarted!: () => void;
    let releaseDelete!: () => void;
    let signalCollectionRead!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { signalDeleteStarted = resolve; });
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const collectionRead = new Promise<void>((resolve) => { signalCollectionRead = resolve; });
    globalState.update = async (key, value) => {
      signalDeleteStarted();
      await deleteGate;
      await update(key, value);
    };
    const read = globalStore.getAll.bind(globalStore);
    globalStore.getAll = () => {
      const value = read();
      signalCollectionRead();
      return value;
    };

    const deletion = globalStore.deleteCollection(collection.id);
    await deleteStarted;
    const response = request(socket, sessionId, 'add', {
      scope: 'global', uri: 'file:///dangling', type: 'file', collectionId: collection.id
    });
    await collectionRead;
    releaseDelete();
    await deletion;

    assert.strictEqual((await response).error?.code, 'collection-not-found');
    assert.deepStrictEqual(globalStore.getAll().items, []);
  });

  test('maps a Workspace collection deleted after resolution to collection-not-found', async () => {
    const owner = currentRoot!.owner;
    const collection = await workspaceStore.addCollection(owner, 'Removed');
    const { socket, sessionId } = await client(['workspace']);
    const update = workspaceState.update.bind(workspaceState);
    let signalDeleteStarted!: () => void;
    let releaseDelete!: () => void;
    let signalCollectionRead!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { signalDeleteStarted = resolve; });
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const collectionRead = new Promise<void>((resolve) => { signalCollectionRead = resolve; });
    workspaceState.update = async (key, value) => {
      signalDeleteStarted();
      await deleteGate;
      await update(key, value);
    };
    const read = workspaceStore.getOwnerData.bind(workspaceStore);
    workspaceStore.getOwnerData = (selectedOwner) => {
      const value = read(selectedOwner);
      signalCollectionRead();
      return value;
    };
    const deletion = workspaceStore.deleteCollection(owner, collection.id);
    await deleteStarted;
    const response = request(socket, sessionId, 'add', {
      scope: 'workspace', uri: `${ROOT}/dangling`, type: 'file', collectionId: collection.id
    });
    await collectionRead;
    releaseDelete();
    await deletion;

    assert.strictEqual((await response).error?.code, 'collection-not-found');
    assert.deepStrictEqual(workspaceStore.getOwnerData(owner)!.items, []);
  });

  test('rejects unavailable scopes and unknown collections without mutations', async () => {
    const { socket, sessionId } = await client(['global']);
    for (const [params, code] of [
      [{ scope: 'workspace' }, 'scope-unavailable'],
      [{ collectionId: 'missing' }, 'collection-not-found'],
      [{ collectionName: 'missing' }, 'collection-not-found']
    ] as const) {
      assert.strictEqual((await request(socket, sessionId, 'add', { uri: ROOT + '/file', type: 'file', ...params })).error?.code, code);
    }
    assert.deepStrictEqual(globalStore.getAll().items, []);
    assert.deepStrictEqual(workspaceStore.getOwnerData(currentRoot!.owner)!.items, []);
  });

  test('enforces the deepest workspace root while global URIs remain unrestricted', async () => {
    await workspaceStore.reconcileRoots([
      { id: 'a', label: 'A', uri: vscode.Uri.parse(ROOT) },
      { id: 'nested', label: 'Nested', uri: vscode.Uri.parse(ROOT + '/nested') }
    ]);
    const { socket, sessionId } = await client();
    for (const uri of ['file:///outside/file', ROOT + '/nested/file']) {
      assert.strictEqual((await request(socket, sessionId, 'add', { scope: 'workspace', uri, type: 'file' })).error?.code, 'bookmark-outside-root');
      assert.strictEqual((await request(socket, sessionId, 'add', { scope: 'global', uri, type: 'file' })).error, undefined);
    }
    assert.strictEqual(workspaceStore.getOwnerData(currentRoot!.owner)!.items.length, 0);
    assert.strictEqual(globalStore.getAll().items.length, 2);
  });

  test('validates request identity and params before store access and preserves the session after errors', async () => {
    const { socket, sessionId } = await client();
    const read = globalStore.getAll.bind(globalStore);
    let reads = 0;
    globalStore.getAll = () => { reads++; return read(); };
    for (const [overrides, params, code] of [
      [{ sessionId: 'other' }, {}, 'invalid-session'],
      [{ workspaceFolderUri: 'file:///other' }, {}, 'invalid-session'],
      [{ id: '' }, {}, 'invalid-request'],
      [{}, { scope: 'global' }, 'invalid-request']
    ] as const) {
      assert.strictEqual((await request(socket, sessionId, 'list', params, overrides)).error?.code, code);
    }
    for (const params of [
      {}, { uri: '', type: 'file' }, { uri: 'relative', type: 'file' }, { uri: ROOT, type: 'bad' },
      { uri: ROOT, type: 'file', scope: 'bad' }, { uri: ROOT, type: 'file', description: 3 },
      { uri: ROOT, type: 'file', collectionId: null }, { uri: ROOT, type: 'file', extra: true }
    ]) {
      assert.strictEqual((await request(socket, sessionId, 'add', params)).error?.code, 'invalid-request');
    }
    assert.strictEqual(reads, 0);
    assert.strictEqual((await request(socket, sessionId)).error, undefined);
  });

  test('rejects reused IDs without executing a second mutation', async () => {
    const { socket, sessionId } = await client(['global']);
    const params = { uri: ROOT + '/one', type: 'file' };
    assert.strictEqual((await request(socket, sessionId, 'add', params, { id: 'same' })).error, undefined);
    assert.strictEqual((await request(socket, sessionId, 'add', { ...params, uri: ROOT + '/two' }, { id: 'same' })).error?.code, 'invalid-request');
    assert.strictEqual(globalStore.getAll().items.length, 1);
  });

  test('maps duplicate, missing store, and unexpected persistence errors to stable safe codes', async () => {
    const { socket, sessionId } = await client();
    const params = { uri: ROOT + '/private', type: 'file', description: 'private note', scope: 'global' };
    await request(socket, sessionId, 'add', params);
    assert.strictEqual((await request(socket, sessionId, 'add', params)).error?.code, 'duplicate-bookmark');
    globalState.failUpdateForKey = 'bookmarks.data';
    const failed = await request(socket, sessionId, 'add', { ...params, uri: ROOT + '/another-private' });
    assert.strictEqual(failed.error?.code, 'internal-error');
    assert.ok(!JSON.stringify(failed).includes('private'));
    workspaceStore.getOwnerData = () => undefined;
    assert.strictEqual((await request(socket, sessionId)).error?.code, 'store-unavailable');
    assert.strictEqual((await request(socket, sessionId, 'add', { uri: ROOT + '/file', type: 'file' })).error?.code, 'store-unavailable');
  });

  test('revalidates selected root availability before each store operation', async () => {
    const { socket, sessionId } = await client();
    currentRoot = undefined;
    assert.strictEqual((await request(socket, sessionId)).error?.code, 'workspace-folder-unavailable');
    assert.deepStrictEqual(globalStore.getAll().items, []);
  });

  test('serializes a session read behind its earlier uncommitted add', async () => {
    const { socket, sessionId } = await client(['global']);
    const update = globalState.update.bind(globalState);
    let release!: () => void;
    let started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalState.update = async (key, value) => { started(); await gate; await update(key, value); };
    const add = request(socket, sessionId, 'add', { uri: ROOT + '/queued', type: 'file' });
    const list = request(socket, sessionId);
    let readFinished = false;
    void list.then(() => { readFinished = true; }, () => {});
    try {
      await Promise.race([admitted, add.then(() => {})]);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.strictEqual(readFinished, false);
      assert.strictEqual(globalStore.getAll().items.length, 0);
    } finally { release(); }
    assert.strictEqual((await add).error, undefined);
    assert.strictEqual(((await list).result as BookmarkData).items.length, 1);
  });

  test('concurrent sessions retain both global commits through the shared store queue', async () => {
    const first = await client(['global']); const second = await client(['global']);
    const results = await Promise.all([first, second].map(({ socket, sessionId }, index) =>
      request(socket, sessionId, 'add', { uri: ROOT + '/concurrent-' + index, type: 'file' })));
    assert.ok(results.every(result => !result.error));
    assert.deepStrictEqual(globalStore.getAll().items.map(item => item.uri).sort(), [ROOT + '/concurrent-0', ROOT + '/concurrent-1']);
  });

  test('stop is idempotent and awaits admitted request tails even after the socket closes', async () => {
    const { socket, sessionId } = await client(['global']);
    const update = globalState.update.bind(globalState);
    let release!: () => void; let started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalState.update = async (key, value) => { started(); await gate; await update(key, value); };
    const add = request(socket, sessionId, 'add', { uri: ROOT + '/drain', type: 'file' });
    void add.catch(() => {});
    try {
      await Promise.race([admitted, add.then(() => {})]);
      socket.destroy(); await new Promise(resolve => setTimeout(resolve, 20));
      const stopping = service.stop();
      assert.strictEqual(service.stop(), stopping);
      let stopped = false; void stopping.then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.strictEqual(stopped, false);
      release(); await stopping;
      assert.strictEqual(globalStore.getAll().items.length, 1);
    } finally { release(); }
  });

  test('returns payload-too-large when committed list data exceeds the frame limit', async () => {
    await globalStore.addItem({ uri: ROOT + '/large', type: 'file', description: 'x'.repeat(MAX_LIVE_BRIDGE_FRAME_BYTES) });
    const { socket, sessionId } = await client(['global']);
    const response = await request(socket, sessionId);
    assert.strictEqual(response.error?.code, 'payload-too-large');
    assert.strictEqual(response.result, undefined);
    assert.strictEqual((await request(socket, sessionId, 'add', { uri: ROOT + '/small', type: 'file' })).error, undefined);
  });

  for (const fault of ['encoding', 'writing', 'diagnostics'] as const) {
    test(`contains response ${fault} failures while draining admitted work without unhandled rejections`, async () => {
      const bridge = await LiveMcpBridgeService.start({ ...options, editorSessionId: randomUUID() });
      const { socket, message } = await authenticate(bridge.issueGrant(ROOT, ['global']));
      const serverSocket = [...(bridge as unknown as { sockets: Set<net.Socket> }).sockets][0];
      const originalRead = globalStore.getAll.bind(globalStore);
      const originalWrite = serverSocket.write;
      const originalLog = options.output.appendLine;
      const update = globalState.update.bind(globalState);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let signalFault!: () => void;
      const faultReached = new Promise<void>(resolve => { signalFault = resolve; });
      const unhandled: unknown[] = [];
      const recordRejection = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', recordRejection);
      const fail = () => { signalFault(); throw new Error('injected response fault'); };
      if (fault === 'encoding') {
        const collection = { id: 'poison', name: 'Encoding fault', order: 0, toJSON: fail };
        globalStore.getAll = () => ({ ...originalRead(), collections: [collection] });
      } else if (fault === 'writing') {
        serverSocket.write = fail;
      } else {
        let firstRead = true;
        globalStore.getAll = () => {
          if (firstRead) { firstRead = false; throw new Error('injected store fault'); }
          return originalRead();
        };
        options.output.appendLine = fail;
      }
      globalState.update = async (key, value) => { await gate; await update(key, value); };
      try {
        // One chunk admits both frames before either queued callback can run.
        const envelope = { kind: 'request', sessionId: message.sessionId, workspaceFolderUri: ROOT };
        socket.write([
          JSON.stringify({ ...envelope, id: 'first', method: 'list', params: {} }),
          JSON.stringify({ ...envelope, id: 'second', method: 'add', params: { type: 'file', uri: ROOT + '/after-fault' } })
        ].join('\n') + '\n');
        await faultReached;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.ok(socket.destroyed, 'response failure must close its connection before stop is called');
        const stopping = bridge.stop();
        assert.strictEqual(bridge.stop(), stopping);
        let settled = false;
        // Install both handlers immediately so a rejected stop is observed, not unhandled by the test.
        const outcome = stopping.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.strictEqual(settled, false, 'stop must await the second admitted persistence');
        release();
        assert.strictEqual(await outcome, undefined, 'stop must complete successfully');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(originalRead().items.map(item => item.uri), [ROOT + '/after-fault']);
        assert.deepStrictEqual(unhandled, []);
        await bridge.stop();
      } finally {
        release();
        serverSocket.write = originalWrite;
        options.output.appendLine = originalLog;
        globalStore.getAll = originalRead;
        globalState.update = update;
        socket.destroy();
        await bridge.stop().catch(() => {});
        await new Promise(resolve => setImmediate(resolve));
        process.off('unhandledRejection', recordRejection);
      }
    });
  }

  test('rejects expanded encoded request IDs before admission without emitting an oversized fallback', async () => {
    const originalRead = globalStore.getAll.bind(globalStore);
    let reads = 0;
    globalStore.getAll = () => { reads++; return originalRead(); };
    const overhead = Buffer.byteLength('{"kind":"response","id":"","error":{"code":"payload-too-large","message":"payload-too-large"}}');
    // Cover the reported six-to-eighteen MiB expansion and the exact one-byte-over boundary.
    for (const decodedBytes of [18 * 1024 * 1024, MAX_LIVE_BRIDGE_FRAME_BYTES - overhead + 1]) {
      const { socket, sessionId } = await client(['global']);
      const observed = new Promise<'closed' | 'response'>(resolve => {
        socket.once('close', () => resolve('closed'));
        socket.once('data', () => resolve('response'));
      });
      const raw = Buffer.concat([
        Buffer.from('{"kind":"request","id":"'), Buffer.alloc(Math.floor(decodedBytes / 3), 0x80),
        Buffer.from('a'.repeat(decodedBytes % 3)),
        Buffer.from(`","sessionId":${JSON.stringify(sessionId)},"workspaceFolderUri":${JSON.stringify(ROOT)},"method":"list","params":{}}\n`)
      ]);
      assert.ok(raw.length < MAX_LIVE_BRIDGE_FRAME_BYTES);
      socket.write(raw);
      assert.strictEqual(await observed, 'closed');
      assert.strictEqual(reads, 0, 'an ID which cannot fit a correlated response must never reach stores');
    }
  });

  test('accepts an expanded request ID whose correlated fallback is exactly the frame limit', async () => {
    const { socket, sessionId } = await client(['global']);
    const overhead = Buffer.byteLength('{"kind":"response","id":"","error":{"code":"payload-too-large","message":"payload-too-large"}}');
    const idBytes = MAX_LIVE_BRIDGE_FRAME_BYTES - overhead;
    const invalidBytes = Math.floor(idBytes / 3);
    const suffix = 'a'.repeat(idBytes % 3);
    let bytes = 0;
    const chunks: Buffer[] = [];
    const received = new Promise<BridgeResponse>((resolve, reject) => {
      socket.once('close', () => reject(new Error('Exact-limit response was disconnected')));
      socket.on('data', chunk => {
        bytes += chunk.length; chunks.push(chunk);
        if (chunk[chunk.length - 1] === 0x0a) { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      });
    });
    socket.write(Buffer.concat([
      Buffer.from('{"kind":"request","id":"'), Buffer.alloc(invalidBytes, 0x80), Buffer.from(suffix),
      Buffer.from(`","sessionId":${JSON.stringify(sessionId)},"workspaceFolderUri":${JSON.stringify(ROOT)},"method":"list","params":{}}\n`)
    ]));
    const response = await received;
    assert.strictEqual(response.error?.code, 'payload-too-large');
    assert.strictEqual(bytes - 1, MAX_LIVE_BRIDGE_FRAME_BYTES);
    assert.strictEqual(response.id.length, invalidBytes + suffix.length);
    assert.ok(response.id.startsWith('\uFFFD'));
    assert.strictEqual(response.result, undefined);
  });

  test('malformed envelopes close only their connection before touching stores', async () => {
    const survivor = await client(['global']);
    const read = globalStore.getAll.bind(globalStore);
    let reads = 0;
    globalStore.getAll = () => { reads++; return read(); };
    for (const overrides of [{ method: 'delete' }, { params: null }, { params: [] }, { extra: true }, { id: 3 }]) {
      const { socket, sessionId } = await client(['global']);
      const closed = once(socket, 'close');
      socket.write(JSON.stringify({ kind: 'request', id: 'bad', sessionId, workspaceFolderUri: ROOT,
        method: 'list', params: {}, ...overrides }) + '\n');
      await closed;
    }
    assert.strictEqual(reads, 0);
    assert.strictEqual((await request(survivor.socket, survivor.sessionId)).error, undefined);
  });

  test('oversized unterminated frames close only their connection', async () => {
    const survivor = await client(['global']);
    const { socket } = await client(['global']);
    const closed = once(socket, 'close');
    socket.write('x'.repeat(MAX_LIVE_BRIDGE_FRAME_BYTES + 1));
    await closed;
    assert.strictEqual((await request(survivor.socket, survivor.sessionId)).error, undefined);
  });

  test('maps disposed store mutations to store-unavailable', async () => {
    const { socket, sessionId } = await client();
    globalStore.dispose(); workspaceStore.dispose();
    for (const scope of ['workspace', 'global']) {
      assert.strictEqual((await request(socket, sessionId, 'add', { scope, uri: ROOT + '/file', type: 'file' })).error?.code, 'store-unavailable');
    }
  });

  test('does not classify an unrelated persistence error by its disposal message', async () => {
    const { socket, sessionId } = await client(['global']);
    globalState.update = async () => { throw new Error('Global bookmark store is disposed.'); };
    const response = await request(socket, sessionId, 'add', { scope: 'global', uri: ROOT + '/file', type: 'file' });
    assert.deepStrictEqual(response.error, { code: 'internal-error', message: 'internal-error' });
  });

  test('root reordering and addition preserve sessions past grant expiry; removal revokes only the selected root', async () => {
    const rootB = 'file:///workspace/b';
    const roots = [
      { id: 'a', label: 'A', uri: vscode.Uri.parse(ROOT) },
      { id: 'b', label: 'B', uri: vscode.Uri.parse(rootB) }
    ];
    await workspaceStore.reconcileRoots(roots);
    const attached = new Map([ROOT, rootB].map(uri => {
      const partition = workspaceStore.getView().attached.find(value => value.canonicalRootUri === uri)!;
      return [uri, { rootUri: uri, canonicalRootUri: uri, owner: { kind: 'partition' as const, partitionId: partition.partitionId } }];
    }));
    await service.stop();
    service = await LiveMcpBridgeService.start({ ...options, getAttachedRoot: uri => attached.get(uri) });
    const activeA = await client();
    const activeB = await authenticate(service.issueGrant(rootB, ['global']));
    now += 600_000;
    await workspaceStore.reconcileRoots([...roots].reverse().concat({ id: 'c', label: 'C', uri: vscode.Uri.parse('file:///workspace/c') }));
    service.refreshAvailableRoots();
    assert.strictEqual((await request(activeA.socket, activeA.sessionId)).error, undefined);
    assert.strictEqual((await request(activeB.socket, activeB.message.sessionId!, 'list', {}, { workspaceFolderUri: rootB })).error, undefined);
    const pendingA = service.issueGrant(ROOT, ['workspace']);
    const pendingB = service.issueGrant(rootB, ['global']);
    const closedA = once(activeA.socket, 'close');
    attached.delete(ROOT);
    service.refreshAvailableRoots(); await closedA;
    assert.notStrictEqual((await authenticate(pendingA)).message.kind, 'ready');
    assert.strictEqual((await authenticate(pendingB)).message.kind, 'ready');
    assert.strictEqual((await request(activeB.socket, activeB.message.sessionId!, 'list', {}, { workspaceFolderUri: rootB })).error, undefined);
  });

  test('uses a deterministic endpoint and a fresh generation after restart', async () => {
    const first = service.issueGrant(ROOT, ['workspace']);
    if (process.platform === 'win32') {
      assert.match(first.endpoint, /^\\\\\.\\pipe\\bookmarks-plus-[a-f0-9]{64}$/);
    } else {
      assert.strictEqual(path.dirname(path.dirname(first.endpoint)), await fs.realpath(tempDirectory));
      assert.strictEqual(path.basename(first.endpoint), 'bridge.sock');
    }
    await service.stop();
    service = await LiveMcpBridgeService.start(options);
    const next = service.issueGrant(ROOT, ['workspace']);
    assert.strictEqual(next.endpoint, first.endpoint);
    assert.notStrictEqual(next.generation, first.generation);
    assert.strictEqual((await authenticate(first)).message.error?.code, 'producer-restarted');
  });

  test('retains only a SHA-256 digest and snapshots immutable grant scopes', async () => {
    const scopes: BookmarkScope[] = ['workspace', 'global'];
    const grant = service.issueGrant(ROOT, scopes);
    assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(Buffer.from(grant.token, 'base64url').length, 32);
    const digest = createHash('sha256').update(grant.token).digest('hex');
    // Deliberately narrow test-only inspection: raw token retention is a security regression.
    const pending = (service as unknown as { pendingGrants: Map<string, {
      tokenDigest: string; scopes: readonly BookmarkScope[];
    }> }).pendingGrants;
    assert.strictEqual(pending.get(digest)?.tokenDigest, digest);
    assert.ok(!JSON.stringify([...pending]).includes(grant.token));
    assert.ok(Object.isFrozen(pending.get(digest)?.scopes));
    scopes.splice(0, scopes.length, 'global');
    const { message } = await authenticate(grant);
    assert.strictEqual(message.kind, 'ready');
    assert.strictEqual(message.version, 1);
    assert.strictEqual(message.workspaceFolderUri, ROOT);
    assert.deepStrictEqual(message.grantedScopes, ['workspace', 'global']);
    assert.ok(message.sessionId);
    assert.strictEqual(pending.size, 0);
  });

  test('allows exactly one simultaneous hello for a token', async () => {
    const grant = service.issueGrant(ROOT, ['global']);
    const results = await Promise.all([authenticate(grant), authenticate(grant)]);
    assert.strictEqual(results.filter(result => result.message.kind === 'ready').length, 1);
    assert.strictEqual(results.find(result => result.message.error)?.message.error?.code, 'bootstrap-consumed');
  });

  test('consumes a token even when the generation is incorrect', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    assert.strictEqual((await authenticate(grant, { generation: 'old' })).message.error?.code, 'producer-restarted');
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'bootstrap-consumed');
  });

  test('rejects unknown tokens without revealing grant information', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    assert.strictEqual((await authenticate(grant, { token: 'unknown' })).message.error?.code, 'bridge-unavailable');
  });

  test('expires an unused grant at exactly 60 seconds', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    now += 60_000;
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'bootstrap-expired');
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'bootstrap-expired');
  });

  test('allows a grant just before expiry and leaves the session alive afterward', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    now += 59_999;
    const { socket, message } = await authenticate(grant);
    assert.strictEqual(message.kind, 'ready');
    now += 600_000;
    service.refreshAvailableRoots();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!socket.destroyed);
  });

  test('explicit revocation is idempotent and prevents authentication', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    grant.revoke(); grant.revoke();
    assert.notStrictEqual((await authenticate(grant)).message.kind, 'ready');
  });

  test('rejects unavailable roots and unsupported, empty or duplicate scopes at issuance', () => {
    assert.throws(() => service.issueGrant('file:///workspace/b', ['workspace']), /workspace-folder-unavailable/);
    for (const scopes of [[], ['invalid'], ['workspace', 'workspace']]) {
      assert.throws(() => service.issueGrant(ROOT, scopes as BookmarkScope[]), /scope-unavailable/);
    }
  });

  test('rejects a grant whose selected root disappeared before hello', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    currentRoot = undefined;
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'workspace-folder-unavailable');
  });

  test('rejects attachment replacement even when its root URI is unchanged', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    currentRoot = { ...currentRoot!, owner: { kind: 'partition', partitionId: 'replacement' } };
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'workspace-folder-unavailable');
  });

  test('rejects a resolver returning a different canonical root', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    currentRoot = { ...currentRoot!, canonicalRootUri: 'file:///workspace/b' };
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'workspace-folder-unavailable');
  });

  test('rejects a resolver whose root URI contradicts its canonical identity', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    currentRoot = { ...currentRoot!, rootUri: 'file:///workspace/b' };
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'workspace-folder-unavailable');
  });

  test('refresh invalidates the selected root and closes its active socket', async () => {
    const pending = service.issueGrant(ROOT, ['workspace']);
    const { socket } = await authenticate(service.issueGrant(ROOT, ['workspace']));
    const closed = once(socket, 'close');
    currentRoot = undefined;
    service.refreshAvailableRoots();
    await closed;
    assert.notStrictEqual((await authenticate(pending)).message.kind, 'ready');
  });

  test('retirement evicts the oldest digest after 4096 entries', async () => {
    const grants = Array.from({ length: 4097 }, () => service.issueGrant(ROOT, ['workspace']));
    now += 60_000;
    // Any issuance performs request-time cleanup, including abandoned launches.
    service.issueGrant(ROOT, ['workspace']);
    assert.strictEqual((await authenticate(grants[0])).message.error?.code, 'bridge-unavailable');
    assert.strictEqual((await authenticate(grants[1])).message.error?.code, 'bootstrap-expired');
    assert.strictEqual((await authenticate(grants[4096])).message.error?.code, 'bootstrap-expired');
  });

  test('retired digests disappear at five minutes without extending on retry', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    (await authenticate(grant)).socket.destroy();
    now += 299_999;
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'bootstrap-consumed');
    now += 1;
    assert.strictEqual((await authenticate(grant)).message.error?.code, 'bridge-unavailable');
  });

  test('the cleanup timer removes abandoned grants without another request', async function () {
    this.timeout(5_000);
    service.issueGrant(ROOT, ['workspace']);
    const pending = (service as unknown as { pendingGrants: Map<string, unknown> }).pendingGrants;
    now += 60_000;
    const deadline = Date.now() + 3_000;
    while (pending.size && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.strictEqual(pending.size, 0);
  });

  test('stop closes authenticated and unauthenticated sockets and rejects new grants', async () => {
    const grant = service.issueGrant(ROOT, ['workspace']);
    const { socket } = await authenticate(grant);
    const idle = net.createConnection(grant.endpoint);
    clients.push(idle);
    await once(idle, 'connect');
    const closed = Promise.all([once(socket, 'close'), once(idle, 'close')]);
    await service.stop();
    await closed;
    await service.stop();
    assert.throws(() => service.issueGrant(ROOT, ['workspace']), /bridge-unavailable/);
    const pending = (service as unknown as { pendingGrants: Map<string, unknown> }).pendingGrants;
    assert.strictEqual(pending.size, 0);
  });

  if (process.platform !== 'win32') {
    test('Unix directory and socket are owner-only and removed on stop', async () => {
      const endpoint = service.issueGrant(ROOT, ['workspace']).endpoint;
      assert.strictEqual((await fs.stat(path.dirname(endpoint))).mode & 0o777, 0o700);
      assert.strictEqual((await fs.stat(endpoint)).mode & 0o777, 0o600);
      await service.stop();
      await assert.rejects(fs.lstat(path.dirname(endpoint)), { code: 'ENOENT' });
      assert.ok((await fs.stat(tempDirectory)).isDirectory());
    });

    test('Unix rejects a private-directory symlink outside the injected parent', async () => {
      const directory = path.dirname(service.issueGrant(ROOT, ['workspace']).endpoint);
      await service.stop();
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-outside-'));
      try {
        await fs.symlink(outside, directory);
        await assert.rejects(LiveMcpBridgeService.start(options));
        assert.ok((await fs.stat(outside)).isDirectory());
      } finally { await fs.unlink(directory); await fs.rmdir(outside); }
    });

    test('Unix does not delete a non-socket file at the endpoint', async () => {
      const endpoint = service.issueGrant(ROOT, ['workspace']).endpoint;
      await service.stop();
      await fs.mkdir(path.dirname(endpoint), { mode: 0o700 });
      await fs.writeFile(endpoint, 'must survive');
      await assert.rejects(LiveMcpBridgeService.start(options));
      assert.strictEqual(await fs.readFile(endpoint, 'utf8'), 'must survive');
    });

    test('Unix does not unlink a running listener during a second startup', async () => {
      const grant = service.issueGrant(ROOT, ['workspace']);
      await assert.rejects(LiveMcpBridgeService.start(options));
      assert.strictEqual((await authenticate(grant)).message.kind, 'ready');
    });

    test('Unix removes only the stale socket in its validated private directory', async () => {
      const endpoint = service.issueGrant(ROOT, ['workspace']).endpoint;
      await service.stop();
      await fs.mkdir(path.dirname(endpoint), { mode: 0o700 });
      const unrelated = path.join(path.dirname(endpoint), 'keep');
      await fs.writeFile(unrelated, 'keep');
      const child = spawn(process.execPath, ['-e',
        "require('net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))", endpoint],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      await once(child.stdout!, 'data');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      assert.ok((await fs.lstat(endpoint)).isSocket());
      service = await LiveMcpBridgeService.start(options);
      assert.strictEqual((await authenticate(service.issueGrant(ROOT, ['workspace']))).message.kind, 'ready');
      await service.stop();
      assert.strictEqual(await fs.readFile(unrelated, 'utf8'), 'keep');
    });
  }
});
