import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { BridgeStartupCode } from './liveBridgeProtocol.js';

/** Buffers MCP traffic until authentication succeeds, with one terminal failure response. */
export class InitializationGate implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private state: 'holding' | 'opening' | 'open' | 'failing' | 'closed' = 'holding';
  private readonly buffered: { message: JSONRPCMessage; extra?: MessageExtraInfo }[] = [];
  private startup?: Promise<void>;
  private failure?: Promise<void>;
  private closing?: Promise<void>;
  private initializeId?: RequestId;
  private initializeArrived?: () => void;
  private notified = false;

  constructor(private readonly inner: Transport) {}

  /** Installs interception once, including when the SDK connects an already-started gate. */
  start(): Promise<void> {
    if (this.startup) { return this.startup; }
    if (this.state === 'closed' || this.state === 'failing') { return Promise.resolve(); }
    this.inner.onmessage = (message, extra) => {
      if (this.state === 'closed') { return; }
      if ('method' in message && message.method === 'initialize' && 'id' in message &&
          this.initializeId === undefined) {
        this.initializeId = message.id;
        this.initializeArrived?.();
      }
      if (this.state === 'failing') { return; }
      if (this.state === 'open') { this.onmessage?.(message, extra); }
      else { this.buffered.push({ message, extra }); }
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.didClose();
    this.startup = Promise.resolve().then(() => this.inner.start());
    return this.startup;
  }

  /** Drains in arrival order, including messages received reentrantly while draining. */
  open(): void {
    if (this.state !== 'holding') { return; }
    this.state = 'opening';
    while (this.buffered.length && this.state === 'opening') {
      const held = this.buffered.shift()!;
      this.onmessage?.(held.message, held.extra);
    }
    if (this.state === 'opening') { this.state = 'open'; }
  }

  /** Delegates SDK output only while the gate remains usable. */
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.state === 'closed' || this.state === 'failing') { return Promise.resolve(); }
    return this.inner.send(message, options);
  }

  /** Sends exactly one held initialize error; closure always waits for the write. */
  fail(code: BridgeStartupCode, message: string): Promise<void> {
    if (this.failure) { return this.failure; }
    if (this.state === 'closed') { return this.closing ?? Promise.resolve(); }
    this.state = 'failing';
    this.buffered.length = 0;
    this.failure = Promise.resolve().then(async () => {
      try {
        if (this.initializeId === undefined && this.state !== 'closed') {
          await new Promise<void>((resolve) => { this.initializeArrived = resolve; });
        }
        if (this.initializeId !== undefined && this.state !== 'closed') {
          await this.inner.send({
            jsonrpc: '2.0', id: this.initializeId,
            error: { code: -32000, message, data: { bookmarksPlusCode: code } },
          });
        }
      } finally {
        this.initializeArrived = undefined;
        await this.closeInner();
      }
    });
    return this.failure;
  }

  /** Cancels a missing initialize wait, but never interrupts an error already being written. */
  close(): Promise<void> {
    if (this.failure) {
      if (this.initializeId === undefined) { this.didClose(); }
      return this.failure;
    }
    return this.closeInner();
  }

  /** Serializes inner closure after any in-flight start. */
  private closeInner(): Promise<void> {
    if (this.closing) { return this.closing; }
    this.state = 'closed';
    this.buffered.length = 0;
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.startup?.catch(() => {});
        await this.inner.close();
      } finally {
        this.didClose();
      }
    });
    return this.closing;
  }

  /** Handles both owned and remote transport closure with one notification. */
  private didClose(): void {
    this.state = 'closed';
    this.buffered.length = 0;
    this.initializeArrived?.();
    if (!this.notified) {
      this.notified = true;
      this.onclose?.();
    }
  }
}
