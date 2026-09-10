import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from '../src/backend.js';
import {
  LIVE_BRIDGE_HANDSHAKE_TIMEOUT_MS, LiveBookmarkBackend, LiveBridgeStartupError,
  LiveMcpBridgeClient, type LiveBridgeConfig,
} from '../src/liveBridgeClient.js';

const ready = {
  kind: 'ready', version: 1, sessionId: 'session', workspaceFolderUri: 'file:///workspace',
  grantedScopes: ['workspace', 'global'],
};

/** Creates an actual IPC peer with test-owned lifetime and decoded client messages. */
async function peer(t: TestContext, receive: (message: Record<string, unknown>, socket: net.Socket) => void) {
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\bookmarks-client-test-${randomUUID()}`
    : path.join(os.tmpdir(), `bc-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString();
      while (buffered.includes('\n')) {
        const end = buffered.indexOf('\n');
        const message = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
        buffered = buffered.slice(end + 1);
        receive(message, socket);
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) { socket.destroy(); }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(endpoint);
  await once(server, 'listening');
  const config: LiveBridgeConfig = {
    endpoint, protocolVersion: 1, generation: 'activation', token: 'bootstrap',
    workspaceFolderUri: 'file:///workspace',
  };
  return config;
}

/** Sends hand-authored wire fixtures independently of the production encoder. */
function send(socket: net.Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

test('connect sends the configured hello before any request and pins subsequent requests', async (t) => {
  const messages: Record<string, unknown>[] = [];
  const config = await peer(t, (message, socket) => {
    messages.push(message);
    if (message.kind === 'hello') { send(socket, ready); }
    else { send(socket, { kind: 'response', id: message.id, result: { ok: true } }); }
  });
  const client = await LiveMcpBridgeClient.connect(config);
  t.after(() => client.close());
  assert.deepEqual(await client.request('list', {}), { ok: true });
  assert.deepEqual(messages, [
    { kind: 'hello', version: 1, generation: 'activation', token: 'bootstrap' },
    { kind: 'request', id: '1', sessionId: 'session', workspaceFolderUri: 'file:///workspace', method: 'list', params: {} },
  ]);
});

for (const [name, invalid] of Object.entries({
  version: { ...ready, version: 2 },
  root: { ...ready, workspaceFolderUri: 'file:///other' },
  missingScope: { ...ready, grantedScopes: ['workspace'] },
  duplicateScope: { ...ready, grantedScopes: ['workspace', 'global', 'global'] },
  unknownScope: { ...ready, grantedScopes: ['workspace', 'admin'] },
  emptySession: { ...ready, sessionId: '' },
  unexpectedGeneration: { ...ready, generation: 'other' },
  unsolicitedResponse: { kind: 'response', id: '1', result: {} },
})) {
  test(`connect rejects invalid ready: ${name}`, async (t) => {
    let closed!: Promise<unknown>;
    const config = await peer(t, (_, socket) => {
      closed = new Promise((resolve) => socket.once('close', resolve));
      send(socket, invalid);
    });
    await assert.rejects(LiveMcpBridgeClient.connect(config), {
      name: 'LiveBridgeStartupError', code: 'bridge-unavailable',
    });
    await closed;
  });
}

test('connect accepts the exact scopes in either order', async (t) => {
  const config = await peer(t, (_, socket) => send(socket, { ...ready, grantedScopes: ['global', 'workspace'] }));
  const client = await LiveMcpBridgeClient.connect(config);
  await client.close();
});

for (const code of ['bootstrap-expired', 'bootstrap-consumed', 'producer-restarted',
  'workspace-folder-unavailable', 'scope-unavailable', 'bridge-unavailable']) {
  test(`connect preserves producer startup classification ${code}`, async (t) => {
    const config = await peer(t, (_, socket) => send(socket, {
      kind: 'response', id: '', error: { code, message: 'Safe startup failure.' },
    }));
    await assert.rejects(LiveMcpBridgeClient.connect(config), (error: unknown) =>
      error instanceof LiveBridgeStartupError && error.code === code);
  });
}

test('concurrent requests correlate out-of-order responses with monotonic string IDs', async (t) => {
  const ids: string[] = [];
  const config = await peer(t, (message, socket) => {
    if (message.kind === 'hello') { send(socket, ready); return; }
    ids.push(message.id as string);
    if (ids.length === 3) {
      for (const id of ['3', '1', '2']) { send(socket, { kind: 'response', id, result: id }); }
    }
    if (ids.length === 4) { send(socket, { kind: 'response', id: '4', result: 'fourth' }); }
  });
  const client = await LiveMcpBridgeClient.connect(config);
  t.after(() => client.close());
  assert.deepEqual(await Promise.all([
    client.request('list', {}), client.request('add', {}), client.request('list', {}),
  ]), ['1', '2', '3']);
  assert.equal(await client.request('list', {}), 'fourth');
  assert.deepEqual(ids, ['1', '2', '3', '4']);
});

for (const terminal of ['end', 'reset', 'duplicate', 'unknown-id', 'malformed', 'ready-again', 'startup-error']) {
  test(`${terminal} rejects every pending request and permanently closes the client`, async (t) => {
    let first = true;
    const config = await peer(t, (message, socket) => {
      if (message.kind === 'hello') { send(socket, ready); return; }
      if (first) { first = false; return; }
      if (terminal === 'end') { socket.end(); }
      else if (terminal === 'reset') { socket.destroy(); }
      else if (terminal === 'malformed') { socket.write('{bad}\n'); }
      else if (terminal === 'ready-again') { send(socket, ready); }
      else if (terminal === 'startup-error') {
        send(socket, { kind: 'response', id: '1', error: { code: 'producer-restarted', message: 'Restarted.' } });
      } else if (terminal === 'unknown-id') { send(socket, { kind: 'response', id: '9', result: {} }); }
      else {
        socket.write('{"kind":"response","id":"1","result":"first"}\n' +
          '{"kind":"response","id":"1","result":"duplicate"}\n');
      }
    });
    const client = await LiveMcpBridgeClient.connect(config);
    const outcomes = await Promise.allSettled([client.request('list', {}), client.request('list', {})]);
    assert.equal(outcomes[0].status, terminal === 'duplicate' ? 'fulfilled' : 'rejected');
    assert.equal(outcomes[1].status, 'rejected');
    for (const result of outcomes) {
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof BackendError);
        assert.equal(result.reason.code, 'invalid-session');
      }
    }
    await assert.rejects(client.request('list', {}), { code: 'invalid-session' });
    await client.close();
    await client.close();
  });
}

test('an operation error rejects only its correlated call and keeps the session usable', async (t) => {
  const config = await peer(t, (message, socket) => {
    if (message.kind === 'hello') { send(socket, ready); }
    else if (message.id === '1') {
      send(socket, { kind: 'response', id: '1', error: { code: 'duplicate-bookmark', message: 'Already added.' } });
    } else { send(socket, { kind: 'response', id: message.id, result: 'ok' }); }
  });
  const client = await LiveMcpBridgeClient.connect(config);
  t.after(() => client.close());
  await assert.rejects(client.request('add', {}), { name: 'BackendError', code: 'duplicate-bookmark' });
  assert.equal(await client.request('list', {}), 'ok');
});

test('close destroys the socket and rejects all outstanding and future requests', async (t) => {
  let closed!: Promise<unknown>;
  const config = await peer(t, (message, socket) => {
    if (message.kind === 'hello') { closed = new Promise((resolve) => socket.once('close', resolve)); send(socket, ready); }
  });
  const client = await LiveMcpBridgeClient.connect(config);
  const pending = Promise.allSettled([client.request('list', {}), client.request('add', {})]);
  await client.close();
  assert.deepEqual((await pending).map((result) => result.status), ['rejected', 'rejected']);
  await assert.rejects(client.request('list', {}), { code: 'invalid-session' });
  await client.close();
  await closed;
});

for (const behavior of ['silent', 'partial', 'late-ready', 'early-close']) {
  test(`absolute handshake deadline terminates ${behavior} and ignores later readiness`, async (t) => {
    let closed!: Promise<unknown>;
    let accepted: net.Socket | undefined;
    let attempts = 0;
    const config = await peer(t, (_, socket) => {
      accepted = socket;
      closed = new Promise((resolve) => socket.once('close', resolve));
      if (behavior === 'partial') {
        const bytes = JSON.stringify(ready);
        let index = 0;
        const timer = setInterval(() => { socket.write(bytes[index++] ?? ' '); }, 2);
        socket.once('close', () => clearInterval(timer));
      }
      if (behavior === 'late-ready') {
        const timer = setTimeout(() => { attempts++; send(socket, ready); }, 40);
        t.after(() => clearTimeout(timer));
      }
      if (behavior === 'early-close') { socket.end(); }
    });
    const start = performance.now();
    await assert.rejects(LiveMcpBridgeClient.connect(config, { handshakeTimeoutMs: 30 }), {
      name: 'LiveBridgeStartupError', code: 'bridge-unavailable',
    });
    assert.ok(performance.now() - start < 500, 'partial data must never extend the deadline');
    await closed;
    assert.equal(accepted?.destroyed, true);
    if (behavior === 'late-ready') { await delay(60); assert.equal(attempts, 1); }
  });
}

test('connection failure is a startup error and the production deadline remains ten seconds', async (t) => {
  assert.equal(LIVE_BRIDGE_HANDSHAKE_TIMEOUT_MS, 10_000);
  const config = await peer(t, () => undefined);
  await assert.rejects(LiveMcpBridgeClient.connect({ ...config, endpoint: `${config.endpoint}-missing` }), {
    name: 'LiveBridgeStartupError', code: 'bridge-unavailable',
  });
});

const collection = { id: 'c', name: 'Collection', order: 0, description: 'notes', scope: 'global' };
const list = {
  version: 2, workspaceFolderUri: 'file:///workspace', grantedScopes: ['workspace', 'global'],
  collections: [collection],
  items: [{ id: 'b', uri: 'file:///outside/a', type: 'file', collectionId: 'c', order: 1, scope: 'global', description: 'item' }],
};

test('live backend sends empty list params, every add field unchanged, and closes its connection', async (t) => {
  const requests: Record<string, unknown>[] = [];
  let closed!: Promise<unknown>;
  const config = await peer(t, (message, socket) => {
    if (message.kind === 'hello') { closed = new Promise((resolve) => socket.once('close', resolve)); send(socket, ready); }
    else {
      requests.push(message);
      send(socket, { kind: 'response', id: message.id, result: message.method === 'list' ? list : {
        id: 'b', scope: 'global', collection,
      } });
    }
  });
  const backend = new LiveBookmarkBackend(await LiveMcpBridgeClient.connect(config));
  assert.equal(backend.mode, 'live');
  assert.deepEqual(await backend.list(), list);
  const input = {
    uri: 'file:///outside/a', type: 'file' as const, scope: 'global' as const,
    collectionId: 'c', collectionName: 'Collection', description: '  unchanged  ',
  };
  assert.deepEqual(await backend.add(input), { id: 'b', scope: 'global', collection });
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
    { method: 'list', params: {} }, { method: 'add', params: input },
  ]);
  await backend.close();
  await closed;
});

for (const [name, result] of Object.entries({
  nullResult: null, missingArrays: { version: 2 },
  badVersion: { ...list, version: 0 }, fractionalVersion: { ...list, version: 1.5 },
  badRoot: { ...list, workspaceFolderUri: 'file:///other' },
  badGrants: { ...list, grantedScopes: ['workspace'] },
  duplicateGrants: { ...list, grantedScopes: ['workspace', 'workspace', 'global'] },
  missingScope: { ...list, collections: [{ id: 'c', name: 'C', order: 0 }] },
  invalidScope: { ...list, items: [{ ...list.items[0], scope: 'admin' }] },
  emptyId: { ...list, items: [{ ...list.items[0], id: '' }] },
  invalidUri: { ...list, items: [{ ...list.items[0], uri: null }] },
  invalidType: { ...list, items: [{ ...list.items[0], type: 'link' }] },
  invalidOrder: { ...list, items: [{ ...list.items[0], order: '1' }] },
  invalidCollectionId: { ...list, items: [{ ...list.items[0], collectionId: 12 }] },
  invalidDescription: { ...list, items: [{ ...list.items[0], description: false }] },
  invalidCollection: { ...list, collections: [{ ...collection, name: '' }] },
  mirrorLeak: { ...list, mirrorPath: '/mirror' },
})) {
  test(`live backend rejects malformed list result: ${name}`, async (t) => {
    const config = await peer(t, (message, socket) => send(socket, message.kind === 'hello'
      ? ready : { kind: 'response', id: message.id, result }));
    const backend = new LiveBookmarkBackend(await LiveMcpBridgeClient.connect(config));
    t.after(() => backend.close());
    await assert.rejects(backend.list(), { name: 'BackendError', code: 'internal-error' });
  });
}

for (const [name, result] of Object.entries({
  nullResult: null, missingCollection: { id: 'b', scope: 'workspace' },
  emptyId: { id: '', scope: 'workspace', collection: null },
  badScope: { id: 'b', scope: 'admin', collection: null },
  differentScope: { id: 'b', scope: 'workspace', collection },
  missingNestedScope: { id: 'b', scope: 'global', collection: { id: 'c', name: 'C', order: 0 } },
  invalidCollection: { id: 'b', scope: 'global', collection: { ...collection, order: null } },
  mirrorLeak: { id: 'b', scope: 'workspace', collection: null, mirrorPath: '/mirror' },
})) {
  test(`live backend rejects malformed add result: ${name}`, async (t) => {
    const config = await peer(t, (message, socket) => send(socket, message.kind === 'hello'
      ? ready : { kind: 'response', id: message.id, result }));
    const backend = new LiveBookmarkBackend(await LiveMcpBridgeClient.connect(config));
    t.after(() => backend.close());
    await assert.rejects(backend.add({ uri: 'file:///workspace/a', type: 'file' }), {
      name: 'BackendError', code: 'internal-error',
    });
  });
}

test('live backend accepts an uncollected workspace add result', async (t) => {
  const config = await peer(t, (message, socket) => send(socket, message.kind === 'hello'
    ? ready : { kind: 'response', id: message.id, result: { id: 'b', scope: 'workspace', collection: null } }));
  const backend = new LiveBookmarkBackend(await LiveMcpBridgeClient.connect(config));
  t.after(() => backend.close());
  assert.deepEqual(await backend.add({ uri: 'file:///workspace/a', type: 'file' }), {
    id: 'b', scope: 'workspace', collection: null,
  });
});
