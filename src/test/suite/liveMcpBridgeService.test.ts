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
import { BookmarkScope } from '../../types';
import { BridgeReady, BridgeResponse } from '../../liveMcpBridgeProtocol';
import { FakeMemento, FakeOutput } from './fixtures';

const ROOT = 'file:///workspace/a';

/** Sends a real IPC hello and reads its first complete response. */
async function hello(grant: IssuedLiveBridgeGrant, overrides: Record<string, unknown> = {}) {
  const socket = net.createConnection(grant.endpoint);
  const response = new Promise<Partial<Omit<BridgeReady, 'kind'>> & { kind?: string; error?: BridgeResponse['error'] }>((resolve, reject) => {
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) { resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); }
    });
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
  const clients: net.Socket[] = [];

  setup(async () => {
    now = 1_000;
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-'));
    workspaceStore = await WorkspaceBookmarkStore.create({
      state: new FakeMemento(), output: new FakeOutput(),
      roots: [{ id: 'a', label: 'A', uri: vscode.Uri.parse(ROOT) }]
    });
    globalStore = new BookmarkStore(new FakeMemento());
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
