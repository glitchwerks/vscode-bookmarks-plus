import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeServerBridgeMessage,
  encodeBridgeMessage,
  MAX_LIVE_BRIDGE_FRAME_BYTES,
  NdjsonFrameDecoder,
} from '../src/liveBridgeProtocol.js';

interface FixtureCase {
  name: string;
  value: unknown;
}

interface BridgeFixtures {
  validServer: FixtureCase[];
  invalidServer: FixtureCase[];
}

const here = dirname(fileURLToPath(import.meta.url));

function readFixtures(): BridgeFixtures {
  return JSON.parse(
    readFileSync(join(here, 'fixtures', 'live-mcp-bridge-v1.fixtures.json'), 'utf8'),
  ) as BridgeFixtures;
}

function expectPayloadTooLarge(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    const candidate = error as { code?: unknown };
    return candidate.code === 'payload-too-large';
  });
}

test('accepts every valid server fixture', () => {
  for (const fixture of readFixtures().validServer) {
    assert.deepEqual(decodeServerBridgeMessage(fixture.value), fixture.value, fixture.name);
  }
});

test('rejects every invalid server fixture', () => {
  for (const fixture of readFixtures().invalidServer) {
    assert.throws(() => decodeServerBridgeMessage(fixture.value), fixture.name);
  }
});

test('encodes one JSON message followed by a newline', () => {
  assert.equal(encodeBridgeMessage({ kind: 'ready', version: 1 }), '{"kind":"ready","version":1}\n');
});

test('reassembles a UTF-8 character split across chunks', () => {
  const decoder = new NdjsonFrameDecoder();
  const frame = Buffer.from('{"name":"caf\u00e9"}\n');
  const splitAt = frame.indexOf(Buffer.from([0xc3])) + 1;

  assert.deepEqual(decoder.push(frame.subarray(0, splitAt)), []);
  assert.deepEqual(decoder.push(frame.subarray(splitAt)), ['{"name":"caf\u00e9"}']);
});

test('returns two frames received in one chunk', () => {
  const decoder = new NdjsonFrameDecoder();

  assert.deepEqual(decoder.push(Buffer.from('{"one":1}\n{"two":2}\n')), ['{"one":1}', '{"two":2}']);
});

test('accepts LF and CRLF terminated frames', () => {
  const decoder = new NdjsonFrameDecoder();

  assert.deepEqual(decoder.push(Buffer.from('{"lf":true}\n{"crlf":true}\r\n')), ['{"lf":true}', '{"crlf":true}']);
});

test('accepts a 16 MiB payload with an LF delimiter', () => {
  const decoder = new NdjsonFrameDecoder();

  const frames = decoder.push(Buffer.concat([Buffer.alloc(MAX_LIVE_BRIDGE_FRAME_BYTES, 0x61), Buffer.from('\n')]));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, MAX_LIVE_BRIDGE_FRAME_BYTES);
});

test('accepts a 16 MiB payload with a CRLF delimiter', () => {
  const decoder = new NdjsonFrameDecoder();

  const frames = decoder.push(Buffer.concat([Buffer.alloc(MAX_LIVE_BRIDGE_FRAME_BYTES, 0x61), Buffer.from('\r\n')]));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, MAX_LIVE_BRIDGE_FRAME_BYTES);
});

test('accepts a 16 MiB payload when a CRLF delimiter spans chunks', () => {
  const decoder = new NdjsonFrameDecoder();

  assert.deepEqual(decoder.push(Buffer.concat([Buffer.alloc(MAX_LIVE_BRIDGE_FRAME_BYTES, 0x61), Buffer.from('\r')])), []);
  const frames = decoder.push(Buffer.from('\n'));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, MAX_LIVE_BRIDGE_FRAME_BYTES);
});

test('preserves malformed JSON framing for the caller to reject', () => {
  const decoder = new NdjsonFrameDecoder();

  assert.deepEqual(decoder.push(Buffer.from('{"broken"}\n')), ['{"broken"}']);
});

test('rejects an incomplete frame when the stream finishes', () => {
  const decoder = new NdjsonFrameDecoder();
  decoder.push(Buffer.from('{"unfinished":true}'));

  assert.throws(() => decoder.finish(), /incomplete/i);
});

test('rejects an unterminated frame larger than 16 MiB', () => {
  const decoder = new NdjsonFrameDecoder();

  expectPayloadTooLarge(() => decoder.push(Buffer.alloc(MAX_LIVE_BRIDGE_FRAME_BYTES + 1)));
});
