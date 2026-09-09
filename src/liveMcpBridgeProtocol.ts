import { StringDecoder } from 'node:string_decoder';
import type { BookmarkScope } from './types';

export const LIVE_BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_LIVE_BRIDGE_FRAME_BYTES = 16 * 1024 * 1024;

export type BridgeStartupCode =
  | 'bootstrap-expired'
  | 'bootstrap-consumed'
  | 'producer-restarted'
  | 'workspace-folder-unavailable'
  | 'scope-unavailable'
  | 'bridge-unavailable';

export type BridgeOperationCode =
  | 'invalid-request'
  | 'invalid-session'
  | 'scope-unavailable'
  | 'workspace-folder-unavailable'
  | 'collection-not-found'
  | 'duplicate-bookmark'
  | 'bookmark-outside-root'
  | 'payload-too-large'
  | 'store-unavailable'
  | 'internal-error';

export interface BridgeHello {
  kind: 'hello';
  version: 1;
  generation: string;
  token: string;
}

export interface BridgeReady {
  kind: 'ready';
  version: 1;
  sessionId: string;
  workspaceFolderUri: string;
  grantedScopes: BookmarkScope[];
}

export interface BridgeRequest {
  kind: 'request';
  id: string;
  sessionId: string;
  workspaceFolderUri: string;
  method: 'list' | 'add';
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  kind: 'response';
  id: string;
  result?: unknown;
  error?: { code: BridgeStartupCode | BridgeOperationCode; message: string };
}

/** Error raised when a bridge frame or envelope violates the wire contract. */
export class BridgeProtocolError extends Error {
  constructor(public readonly code: BridgeOperationCode, message: string) {
    super(message);
    this.name = 'BridgeProtocolError';
  }
}

/** Decodes UTF-8 newline-delimited JSON frames without parsing their JSON bodies. */
export class NdjsonFrameDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private bufferedText = '';
  private bufferedByteLength = 0;
  private bufferedEndsWithCarriageReturn = false;

  /** Adds a socket chunk and returns each complete LF or CRLF-delimited frame. */
  push(chunk: Buffer): string[] {
    this.guardFrameSize(chunk);
    this.bufferedText += this.decoder.write(chunk);
    return this.takeCompleteFrames();
  }

  /** Completes the stream, rejecting an unterminated final frame. */
  finish(): void {
    this.bufferedText += this.decoder.end();
    this.ensureFrameSize(this.bufferedByteLength);
    if (this.bufferedText.length !== 0) {
      throw new BridgeProtocolError('invalid-request', 'Bridge stream ended with an incomplete frame.');
    }
  }

  /** Counts each raw in-progress frame before StringDecoder materializes split UTF-8 characters. */
  private guardFrameSize(chunk: Buffer): void {
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }
      const frameEndsWithCarriageReturn =
        (index > segmentStart && chunk[index - 1] === 0x0d) ||
        (index === segmentStart && this.bufferedEndsWithCarriageReturn);
      const carriageReturnBytes = frameEndsWithCarriageReturn ? 1 : 0;
      this.ensureFrameSize(this.bufferedByteLength + index - segmentStart - carriageReturnBytes);
      this.bufferedByteLength = 0;
      this.bufferedEndsWithCarriageReturn = false;
      segmentStart = index + 1;
    }
    this.bufferedByteLength += chunk.length - segmentStart;
    this.bufferedEndsWithCarriageReturn = chunk.length > segmentStart && chunk[chunk.length - 1] === 0x0d;
    this.ensureFrameSize(this.bufferedByteLength - (this.bufferedEndsWithCarriageReturn ? 1 : 0));
  }

  /** Rejects a frame before retaining more than the published byte limit. */
  private ensureFrameSize(size: number): void {
    if (size > MAX_LIVE_BRIDGE_FRAME_BYTES) {
      throw new BridgeProtocolError('payload-too-large', 'Bridge frame exceeds the 16 MiB limit.');
    }
  }

  /** Removes and normalizes all complete frames from the accumulated decoded text. */
  private takeCompleteFrames(): string[] {
    const frames: string[] = [];
    let newlineIndex = this.bufferedText.indexOf('\n');
    while (newlineIndex >= 0) {
      let frame = this.bufferedText.slice(0, newlineIndex);
      if (frame.endsWith('\r')) {
        frame = frame.slice(0, -1);
      }
      frames.push(frame);
      this.bufferedText = this.bufferedText.slice(newlineIndex + 1);
      newlineIndex = this.bufferedText.indexOf('\n');
    }
    return frames;
  }
}

/** Serializes one bridge message as a newline-delimited JSON frame. */
export function encodeBridgeMessage(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

/** Validates and narrows a parsed client-to-extension bridge message. */
export function decodeClientBridgeMessage(value: unknown): BridgeHello | BridgeRequest {
  if (!isRecord(value)) {
    throw invalidMessage();
  }
  if (value.kind === 'hello' && isBridgeHello(value)) {
    return value;
  }
  if (value.kind === 'request' && isBridgeRequest(value)) {
    return value;
  }
  throw invalidMessage();
}

/** Returns whether a value is a non-array object used by the JSON envelopes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates the hello envelope against its closed bridge-v1 shape. */
function isBridgeHello(value: Record<string, unknown>): value is Record<string, unknown> & BridgeHello {
  return (
    hasOnlyKeys(value, ['kind', 'version', 'generation', 'token']) &&
    value.version === LIVE_BRIDGE_PROTOCOL_VERSION &&
    typeof value.generation === 'string' &&
    typeof value.token === 'string'
  );
}

/** Validates the request envelope while intentionally leaving params method-specific. */
function isBridgeRequest(value: Record<string, unknown>): value is Record<string, unknown> & BridgeRequest {
  return (
    hasOnlyKeys(value, ['kind', 'id', 'sessionId', 'workspaceFolderUri', 'method', 'params']) &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.workspaceFolderUri === 'string' &&
    (value.method === 'list' || value.method === 'add') &&
    isRecord(value.params)
  );
}

/** Checks that an envelope has no omitted required fields or undeclared extras. */
function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

/** Constructs the stable error used for malformed client messages. */
function invalidMessage(): BridgeProtocolError {
  return new BridgeProtocolError('invalid-request', 'Invalid bridge request.');
}
