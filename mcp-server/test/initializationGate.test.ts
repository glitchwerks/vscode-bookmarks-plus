import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface Gate extends Transport {
  open(): void;
  fail(code: 'bridge-unavailable', message: string): Promise<void>;
}

/** Fails explicitly when the implementation has not yet been supplied. */
async function createGate(inner: Transport): Promise<Gate> {
  const modulePath = '../src/initializationGate.js';
  const module = await import(modulePath).catch(() => undefined);
  assert.equal(typeof module?.InitializationGate, 'function', 'initialization gate must exist');
  return new module.InitializationGate(inner) as Gate;
}

const initialize: JSONRPCMessage = { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} };
const discovery: JSONRPCMessage = { jsonrpc: '2.0', id: 8, method: 'tools/list' };

test('rejected transport startup settles failure without initialize and closes once', { timeout: 1000 }, async () => {
  let closes = 0;
  let notifications = 0;
  const inner: Transport = {
    start: async () => { throw new Error('start failed'); },
    send: async () => { assert.fail('a failed transport cannot send'); },
    close: async () => { closes++; },
  };
  const gate = await createGate(inner);
  gate.onclose = () => { notifications++; };
  await assert.rejects(gate.start(), /start failed/);
  await gate.fail('bridge-unavailable', 'Unavailable.');
  await Promise.all([gate.close(), gate.fail('bridge-unavailable', 'Unavailable.')]);
  assert.equal(closes, 1);
  assert.equal(notifications, 1);
});

test('gate holds stdio initialize and discovery and releases unchanged messages in order', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const gate = await createGate(new StdioServerTransport(input, output));
  const received: JSONRPCMessage[] = [];
  gate.onmessage = (message) => received.push(message);
  await Promise.all([gate.start(), gate.start()]);
  input.write(`${JSON.stringify(initialize)}\n${JSON.stringify(discovery)}\n`);
  assert.equal(received.length, 0);
  gate.open();
  gate.open();
  assert.deepEqual(received, [initialize, discovery]);
  input.write(`${JSON.stringify({ ...discovery, id: 9 })}\n`);
  assert.deepEqual(received.map((message) => 'id' in message && message.id), [7, 8, 9]);
  await gate.close();
  input.destroy();
  output.destroy();
});

test('opening preserves queued order under reentrant message delivery and forwards metadata', async () => {
  const inner: Transport = { start: async () => {}, send: async () => {}, close: async () => {} };
  const gate = await createGate(inner);
  await gate.start();
  const extra = { authInfo: { token: 'token', clientId: 'client', scopes: [] } };
  inner.onmessage?.(initialize, extra);
  inner.onmessage?.(discovery);
  const received: JSONRPCMessage[] = [];
  gate.onmessage = (message, metadata) => {
    received.push(message);
    if ('id' in message && message.id === 7) {
      assert.equal(metadata, extra);
      inner.onmessage?.({ ...discovery, id: 9 });
      gate.open();
    }
  };
  gate.open();
  assert.deepEqual(received.map((message) => 'id' in message && message.id), [7, 8, 9]);
  await gate.close();
});

test('failure sends one initialization error and awaits send before concurrent close', async () => {
  let releaseSend!: () => void;
  const pendingSend = new Promise<void>((resolve) => { releaseSend = resolve; });
  const sent: JSONRPCMessage[] = [];
  let closes = 0;
  const inner: Transport = {
    start: async () => {},
    send: async (message) => { sent.push(message); await pendingSend; },
    close: async () => { closes++; inner.onclose?.(); },
  };
  const gate = await createGate(inner);
  let delivered = 0;
  let notifications = 0;
  gate.onmessage = () => { delivered++; };
  gate.onclose = () => { notifications++; };
  await gate.start();
  inner.onmessage?.(initialize);
  inner.onmessage?.(discovery);
  const failing = gate.fail('bridge-unavailable', 'Unavailable.');
  const repeat = gate.fail('bridge-unavailable', 'Other.');
  const closing = gate.close();
  gate.open();
  inner.onmessage?.(initialize);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{
    jsonrpc: '2.0', id: 7,
    error: { code: -32000, message: 'Unavailable.', data: { bookmarksPlusCode: 'bridge-unavailable' } },
  }]);
  assert.equal(closes, 0);
  releaseSend();
  await Promise.all([failing, repeat, closing, gate.close()]);
  await gate.start();
  inner.onmessage?.(discovery);
  assert.equal(delivered, 0);
  assert.equal(closes, 1);
  assert.equal(notifications, 1);
});

test('failure before initialize waits for its id and ignores premature discovery', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let wire = '';
  output.on('data', (chunk: Buffer) => { wire += chunk.toString(); });
  const gate = await createGate(new StdioServerTransport(input, output));
  await gate.start();
  const failed = gate.fail('bridge-unavailable', 'Unavailable.');
  input.write(`${JSON.stringify(discovery)}\n`);
  input.write(`${JSON.stringify({ ...initialize, id: 'late-init' })}\n`);
  await failed;
  assert.deepEqual(JSON.parse(wire), {
    jsonrpc: '2.0', id: 'late-init',
    error: { code: -32000, message: 'Unavailable.', data: { bookmarksPlusCode: 'bridge-unavailable' } },
  });
  input.destroy();
  output.destroy();
});

test('close during pending start waits for start and never reopens the inner transport', async () => {
  let releaseStart!: () => void;
  let starts = 0;
  let closes = 0;
  const pending = new Promise<void>((resolve) => { releaseStart = resolve; });
  const inner: Transport = {
    start: async () => { starts++; await pending; }, send: async () => {},
    close: async () => { closes++; },
  };
  const gate = await createGate(inner);
  const starting = gate.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = gate.close();
  assert.equal(closes, 0);
  releaseStart();
  await Promise.all([starting, closing]);
  await gate.start();
  gate.open();
  await gate.fail('bridge-unavailable', 'Unavailable.');
  assert.equal(starts, 1);
  assert.equal(closes, 1);
});

test('failed error write still closes once and releases a fail waiting for initialize on close', async () => {
  let closes = 0;
  const inner: Transport = {
    start: async () => {}, send: async () => { throw new Error('write failed'); },
    close: async () => { closes++; },
  };
  const gate = await createGate(inner);
  await gate.start();
  inner.onmessage?.(initialize);
  await assert.rejects(gate.fail('bridge-unavailable', 'Unavailable.'), /write failed/);
  assert.equal(closes, 1);
  const other = await createGate(inner);
  await other.start();
  const failing = other.fail('bridge-unavailable', 'Unavailable.');
  await Promise.all([other.close(), failing]);
  assert.equal(closes, 2);
});
