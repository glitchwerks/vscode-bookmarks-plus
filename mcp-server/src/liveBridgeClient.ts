import net from 'node:net';
import { z } from 'zod';
import {
  BackendError, type AddBookmarkInput, type AddBookmarkResult, type BookmarkBackend,
  type LiveListResult,
} from './backend.js';
import {
  decodeServerBridgeMessage, encodeBridgeMessage, NdjsonFrameDecoder,
  type BridgeOperationCode, type BridgeReady, type BridgeStartupCode,
} from './liveBridgeProtocol.js';

export interface LiveBridgeConfig {
  endpoint: string;
  protocolVersion: 1;
  generation: string;
  token: string;
  workspaceFolderUri: string;
}

export const LIVE_BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000;

const STARTUP_CODES = new Set<string>([
  'bootstrap-expired', 'bootstrap-consumed', 'producer-restarted',
  'workspace-folder-unavailable', 'scope-unavailable', 'bridge-unavailable',
]);
const STARTUP_ONLY_CODES = new Set<string>([
  'bootstrap-expired', 'bootstrap-consumed', 'producer-restarted', 'bridge-unavailable',
]);

/** A classified startup failure consumed by the MCP initialization gate. */
export class LiveBridgeStartupError extends Error {
  constructor(readonly code: BridgeStartupCode, message: string) {
    super(message);
    this.name = 'LiveBridgeStartupError';
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: BackendError) => void;
}

/** Owns one authenticated IPC session; terminal failures never reconnect it. */
export class LiveMcpBridgeClient {
  private state: 'connecting' | 'ready' | 'closed' = 'connecting';
  private socket?: net.Socket;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private readonly decoder = new NdjsonFrameDecoder();
  private session?: BridgeReady;
  private nextId = 1n;
  private readonly pending = new Map<string, PendingRequest>();
  private resolveStartup?: (client: LiveMcpBridgeClient) => void;
  private rejectStartup?: (error: LiveBridgeStartupError) => void;
  private socketClosed: Promise<void> = Promise.resolve();

  private constructor(readonly workspaceFolderUri: string) {}

  /** Authenticates within one absolute deadline covering connection and all handshake traffic. */
  static connect(
    config: LiveBridgeConfig,
    options: { handshakeTimeoutMs?: number } = {},
  ): Promise<LiveMcpBridgeClient> {
    const client = new LiveMcpBridgeClient(config.workspaceFolderUri);
    return new Promise((resolve, reject) => {
      client.resolveStartup = resolve;
      client.rejectStartup = reject;
      client.start({ ...config }, options.handshakeTimeoutMs ?? LIVE_BRIDGE_HANDSHAKE_TIMEOUT_MS);
    });
  }

  /** Sends one root-pinned call and correlates its independently ordered response. */
  request(method: 'list' | 'add', params: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'ready' || !this.session) {
      return Promise.reject(new BackendError('invalid-session', 'The live bridge session is closed.'));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({
        kind: 'request', id, sessionId: this.session!.sessionId,
        workspaceFolderUri: this.workspaceFolderUri, method, params,
      });
    });
  }

  /** Idempotently shuts down the session and waits until its socket is closed. */
  async close(): Promise<void> {
    this.terminate();
    await this.socketClosed;
  }

  /** Installs the one-shot deadline before initiating connection establishment. */
  private start(config: LiveBridgeConfig, timeoutMs: number): void {
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.terminate(), timeoutMs);
    try {
      const socket = net.createConnection(config.endpoint);
      this.socket = socket;
      this.socketClosed = new Promise((resolve) => {
        socket.once('close', () => {
          this.terminate();
          socket.removeAllListeners();
          resolve();
        });
      });
      socket.once('connect', () => this.write({
        kind: 'hello', version: config.protocolVersion, generation: config.generation, token: config.token,
      }));
      socket.on('data', (chunk: Buffer) => this.receive(chunk));
      socket.on('error', () => this.terminate());
      socket.once('end', () => this.terminate());
    } catch {
      this.terminate();
    }
  }

  /** Encodes through the shared protocol and funnels synchronous/asynchronous failures to shutdown. */
  private write(message: object): void {
    if (this.state === 'closed') { return; }
    try {
      this.socket!.write(encodeBridgeMessage(message), (error) => {
        if (error) { this.terminate(); }
      });
    } catch {
      this.terminate();
    }
  }

  /** Processes complete envelopes, stopping immediately when any frame closes the session. */
  private receive(chunk: Buffer): void {
    if (this.state === 'closed') { return; }
    try {
      for (const frame of this.decoder.push(chunk)) {
        // Read through a method so a terminal transition in this loop is observed by TypeScript too.
        if (this.isClosed()) { return; }
        const message = decodeServerBridgeMessage(JSON.parse(frame) as unknown);
        if (this.state === 'connecting') {
          if (performance.now() >= this.deadline) { this.terminate(); return; }
          if (message.kind === 'response' && message.id === '' && message.error &&
              STARTUP_CODES.has(message.error.code)) {
            this.terminate(new LiveBridgeStartupError(message.error.code as BridgeStartupCode, message.error.message));
            return;
          }
          if (message.kind !== 'ready' || message.sessionId.length === 0 ||
              message.workspaceFolderUri !== this.workspaceFolderUri || !hasNativeScopes(message.grantedScopes)) {
            this.terminate();
            return;
          }
          this.session = message;
          this.state = 'ready';
          clearTimeout(this.timer);
          this.timer = undefined;
          this.resolveStartup?.(this);
          this.resolveStartup = undefined;
          this.rejectStartup = undefined;
          continue;
        }
        if (message.kind !== 'response') { this.terminate(); return; }
        const pending = this.pending.get(message.id);
        if (!pending || (message.error && STARTUP_ONLY_CODES.has(message.error.code))) {
          this.terminate();
          return;
        }
        // Retire before settling: a duplicate ID is terminal, never a second settlement.
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new BackendError(message.error.code as BridgeOperationCode, message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } catch {
      this.terminate();
    }
  }

  /** Observes state after a callback may have performed a terminal transition. */
  private isClosed(): boolean {
    return this.state === 'closed';
  }

  /** Performs the only terminal transition, retiring all callbacks and destroying the owned socket. */
  private terminate(startupError = new LiveBridgeStartupError('bridge-unavailable', 'The live bridge is unavailable.')): void {
    if (this.state === 'closed') { return; }
    this.state = 'closed';
    this.session = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.rejectStartup?.(startupError);
    this.resolveStartup = undefined;
    this.rejectStartup = undefined;
    const error = new BackendError('invalid-session', 'The live bridge session is closed.');
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();
    for (const pending of pendingRequests) { pending.reject(error); }
    this.socket?.removeAllListeners('connect');
    this.socket?.removeAllListeners('data');
    this.socket?.removeAllListeners('end');
    // Keep the error handler until close so destruction cannot emit an unhandled socket error.
    this.socket?.destroy();
  }
}

/** Native sessions must grant exactly workspace and global, independent of ordering. */
function hasNativeScopes(scopes: readonly string[]): boolean {
  return scopes.length === 2 && scopes.includes('workspace') && scopes.includes('global');
}

const scopeSchema = z.enum(['workspace', 'global']);
const collectionSchema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), order: z.number(),
  description: z.string().optional(), scope: scopeSchema,
});
const itemSchema = z.strictObject({
  id: z.string().min(1), uri: z.string().min(1), type: z.enum(['file', 'folder']),
  collectionId: z.string().nullable(), order: z.number(), description: z.string().optional(), scope: scopeSchema,
});
const listSchema = z.strictObject({
  version: z.number().int().positive(), workspaceFolderUri: z.string(),
  grantedScopes: z.array(scopeSchema).refine(hasNativeScopes),
  collections: z.array(collectionSchema), items: z.array(itemSchema),
});
const addSchema = z.strictObject({
  id: z.string().min(1), scope: scopeSchema, collection: collectionSchema.nullable(),
}).refine((result) => result.collection === null || result.collection.scope === result.scope);

/** Exposes validated live results through the common bookmark backend boundary. */
export class LiveBookmarkBackend implements BookmarkBackend {
  readonly mode = 'live';

  constructor(private readonly client: LiveMcpBridgeClient) {}

  /** Lists both granted stores and checks the producer's root and complete record shapes. */
  async list(): Promise<LiveListResult> {
    const parsed = listSchema.safeParse(await this.client.request('list', {}));
    if (!parsed.success || parsed.data.workspaceFolderUri !== this.client.workspaceFolderUri) {
      throw new BackendError('internal-error', 'The live bridge returned an invalid bookmark list.');
    }
    return parsed.data;
  }

  /** Forwards all add fields unchanged, accepting only a complete, consistently scoped result. */
  async add(input: AddBookmarkInput): Promise<AddBookmarkResult> {
    const parsed = addSchema.safeParse(await this.client.request('add', { ...input }));
    if (!parsed.success) {
      throw new BackendError('internal-error', 'The live bridge returned an invalid add result.');
    }
    return parsed.data;
  }

  /** Releases the client-owned IPC connection when the MCP backend closes. */
  close(): Promise<void> {
    return this.client.close();
  }
}
