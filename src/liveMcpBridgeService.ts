import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CollectionNotFoundError,
  DuplicateBookmarkError,
  GlobalStoreUnavailableError,
  type AddItemInput,
  type BookmarkStore,
  type OutputSink
} from './bookmarkStore';
import { PartitionBoundaryError, WorkspaceDataUnavailableError, type WorkspaceBookmarkStore } from './workspaceBookmarkStore';
import type { WorkspaceOwnerRef } from './workspacePartitionTypes';
import { CURRENT_SCHEMA_VERSION, type BookmarkCollection, type BookmarkData, type BookmarkItem, type BookmarkScope } from './types';
import { canonicalizeRootUri } from './rootUri';
import {
  BridgeHello, BridgeStartupCode, BridgeRequest, BridgeResponse, BridgeProtocolError, NdjsonFrameDecoder,
  decodeClientBridgeMessage, encodeBridgeMessage, MAX_LIVE_BRIDGE_FRAME_BYTES
} from './liveMcpBridgeProtocol';

export interface IssuedLiveBridgeGrant {
  readonly endpoint: string;
  readonly protocolVersion: 1;
  readonly generation: string;
  readonly token: string;
  revoke(): void;
}

export interface LiveMcpBridgeServiceOptions {
  readonly workspaceStore: WorkspaceBookmarkStore;
  readonly globalStore: BookmarkStore;
  readonly editorSessionId: string;
  readonly extensionId: string;
  readonly output: OutputSink;
  readonly getAttachedRoot: (canonicalRootUri: string) =>
    | { rootUri: string; canonicalRootUri: string; owner: WorkspaceOwnerRef }
    | undefined;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly createId?: () => string;
  readonly tempDirectory?: string;
}

interface PendingBridgeGrant {
  readonly tokenDigest: string;
  readonly generation: string;
  readonly workspaceFolderUri: string;
  readonly owner: WorkspaceOwnerRef;
  readonly scopes: readonly BookmarkScope[];
  readonly expiresAt: number;
}

interface ActiveBridgeSession extends PendingBridgeGrant {
  readonly sessionId: string;
}

interface RetiredBridgeGrant {
  readonly code: 'bootstrap-expired' | 'bootstrap-consumed';
  readonly expiresAt: number;
}

/** Owns the per-activation IPC endpoint and single-use bootstrap authorization. */
export class LiveMcpBridgeService {
  private readonly pendingGrants = new Map<string, PendingBridgeGrant>();
  private readonly retiredGrants = new Map<string, RetiredBridgeGrant>();
  private readonly sockets = new Set<net.Socket>();
  private readonly sessions = new Map<net.Socket, ActiveBridgeSession>();
  private readonly requestTails = new Map<net.Socket, Promise<void>>();
  private readonly server: net.Server;
  private readonly generation: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopping = false;
  private directoryIdentity: Stats | undefined;

  /** Initializes in-memory state; start opens the endpoint before exposing the instance. */
  private constructor(
    private readonly options: LiveMcpBridgeServiceOptions,
    private readonly endpoint: string,
    private readonly directory?: string
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.generation = this.createId();
    this.server = net.createServer(socket => this.accept(socket));
    this.server.on('error', () => options.output.appendLine('Live MCP bridge: listener error.'));
  }

  /** Binds one deterministic private endpoint with a fresh activation generation. */
  static async start(options: LiveMcpBridgeServiceOptions): Promise<LiveMcpBridgeService> {
    const hash = createHash('sha256').update(options.editorSessionId).update('\0').update(options.extensionId).digest('hex');
    const parent = process.platform === 'win32' ? undefined : await fs.realpath(options.tempDirectory ?? os.tmpdir());
    const directory = parent ? path.join(parent, `bookmarks-plus-${hash.slice(0, 24)}`) : undefined;
    const endpoint = directory ? path.join(directory, 'bridge.sock') : `\\\\.\\pipe\\bookmarks-plus-${hash}`;
    const service = new LiveMcpBridgeService(options, endpoint, directory);
    if (directory) { await service.prepareDirectory(parent!); }
    try {
      await new Promise<void>((resolve, reject) => {
        service.server.once('error', reject);
        service.server.listen({ path: endpoint, readableAll: false, writableAll: false }, () => {
          service.server.removeListener('error', reject);
          resolve();
        });
      });
      if (directory) { await fs.chmod(endpoint, 0o600); }
      service.cleanupTimer = setInterval(() => service.cleanupExpired(), 1_000);
      service.cleanupTimer.unref();
      return service;
    } catch (error) {
      // A failed bind owns no socket path: never unlink a competing listener here.
      if (service.server.listening) { await service.stop(); }
      else { await service.removeEmptyDirectory(); }
      throw error;
    }
  }

  /** Issues an immutable 60-second root grant and returns its raw token exactly once. */
  issueGrant(rootUri: string, scopes: readonly BookmarkScope[]): IssuedLiveBridgeGrant {
    if (this.stopping) { throw new Error('bridge-unavailable'); }
    this.cleanupExpired();
    let canonicalRoot: string;
    try { canonicalRoot = canonicalizeRootUri(vscode.Uri.parse(rootUri, true)); }
    catch { throw new Error('workspace-folder-unavailable'); }
    const root = this.resolveRoot(canonicalRoot);
    if (!root || root.canonicalRootUri !== canonicalRoot || root.owner.kind !== 'partition') {
      throw new Error('workspace-folder-unavailable');
    }
    if (!validScopes(scopes)) { throw new Error('scope-unavailable'); }
    const bytes = (this.options.randomBytes ?? randomBytes)(32);
    if (bytes.length !== 32) { throw new Error('bridge-unavailable'); }
    const token = bytes.toString('base64url');
    const tokenDigest = digestToken(token);
    if (this.pendingGrants.has(tokenDigest) || this.retiredGrants.has(tokenDigest)) {
      throw new Error('bridge-unavailable');
    }
    this.pendingGrants.set(tokenDigest, Object.freeze({
      tokenDigest, generation: this.generation, workspaceFolderUri: canonicalRoot,
      owner: Object.freeze({ ...root.owner }), scopes: Object.freeze([...scopes]), expiresAt: this.now() + 60_000
    }));
    return Object.freeze({ endpoint: this.endpoint, protocolVersion: 1, generation: this.generation,
      token, revoke: this.makeRevoker(tokenDigest) });
  }

  /** Invalidates grants and sessions whose exact selected attachment is no longer available. */
  refreshAvailableRoots(): void {
    if (this.stopping) { return; }
    this.cleanupExpired();
    for (const [digest, grant] of this.pendingGrants) {
      if (!this.isAttached(grant)) { this.pendingGrants.delete(digest); }
    }
    for (const [socket, session] of this.sessions) {
      if (!this.isAttached(session)) { socket.destroy(); }
    }
  }

  /** Fences issuance, clears all authorization state, and closes every owned IPC resource. */
  stop(): Promise<void> {
    if (this.stopPromise) { return this.stopPromise; }
    this.stopping = true;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.pendingGrants.clear();
    this.retiredGrants.clear();
    const tails = [...this.requestTails.values()];
    this.stopPromise = new Promise<void>(resolve => {
      if (this.server.listening) { this.server.close(() => resolve()); }
      else { resolve(); }
      for (const socket of this.sockets) { socket.destroy(); }
      this.sessions.clear();
    }).then(() => Promise.all(tails)).then(() => this.removeEmptyDirectory());
    return this.stopPromise;
  }

  /** Keeps the revocation closure in a lexical scope that never contained the raw token. */
  private makeRevoker(digest: string): () => void {
    return () => { this.pendingGrants.delete(digest); };
  }

  /** Tracks even unauthenticated sockets so shutdown cannot wait on an idle connection. */
  private accept(socket: net.Socket): void {
    if (this.stopping) { socket.destroy(); return; }
    this.sockets.add(socket);
    const decoder = new NdjsonFrameDecoder();
    const requestIds = new Set<string>();
    let terminal = false;
    socket.on('close', () => { this.sockets.delete(socket); this.sessions.delete(socket); });
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      if (terminal || this.stopping) { return; }
      try {
        for (const frame of decoder.push(chunk)) {
          const message = decodeClientBridgeMessage(JSON.parse(frame));
          const session = this.sessions.get(socket);
          if (message.kind === 'request' && session) {
            // UTF-8 replacement can expand a decoded ID beyond the raw inbound frame budget.
            if (encodeSizeError(message.id) === undefined) {
              terminal = true;
              socket.destroy();
              return;
            }
            const duplicate = requestIds.has(message.id) || message.id.trim().length === 0;
            requestIds.add(message.id);
            this.admitRequest(socket, session, message, duplicate);
            continue;
          }
          if (message.kind !== 'hello' || session) {
            terminal = true;
            socket.destroy();
            return;
          }
          const result = this.consumeHello(message);
          if (typeof result === 'string') {
            terminal = true;
            socket.end(encodeBridgeMessage({ kind: 'response', id: '', error: { code: result, message: result } }));
            return;
          }
          this.sessions.set(socket, result);
          socket.write(encodeBridgeMessage({ kind: 'ready', version: 1, sessionId: result.sessionId,
            workspaceFolderUri: result.workspaceFolderUri, grantedScopes: result.scopes }));
        }
      } catch {
        terminal = true;
        socket.destroy();
      }
    });
  }

  /** Serializes each socket while retaining admitted work after disconnect for shutdown draining. */
  private admitRequest(socket: net.Socket, session: ActiveBridgeSession, request: BridgeRequest, duplicate: boolean): void {
    const previous = this.requestTails.get(socket) ?? Promise.resolve();
    const tail = previous.then(async () => {
      const response: BridgeResponse = { kind: 'response', id: request.id };
      try {
        if (duplicate) { throw new BridgeProtocolError('invalid-request', 'Invalid request identifier.'); }
        response.result = await this.dispatch(session, request);
      } catch (error) {
        const code = error instanceof BridgeProtocolError ? error.code
          : error instanceof DuplicateBookmarkError ? 'duplicate-bookmark'
          : error instanceof CollectionNotFoundError ? 'collection-not-found'
          : error instanceof PartitionBoundaryError ? 'bookmark-outside-root'
          : error instanceof WorkspaceDataUnavailableError
            || error instanceof GlobalStoreUnavailableError ? 'store-unavailable'
          : 'internal-error';
        response.error = { code, message: code };
        if (code === 'internal-error') {
          this.options.output.appendLine(`Live MCP bridge: internal-error; session=${session.sessionId}; partition=${session.owner.kind === 'partition' ? session.owner.partitionId : 'unassigned'}.`);
        }
      }
      if (!socket.destroyed && socket.writable) {
        let frame: string | undefined = encodeBridgeMessage(response);
        if (Buffer.byteLength(frame, 'utf8') - 1 > MAX_LIVE_BRIDGE_FRAME_BYTES) {
          frame = encodeSizeError(request.id);
        }
        if (frame === undefined) { socket.destroy(); return; }
        socket.write(frame);
      }
    }).catch(() => {
      // Encoding, writing, or even the diagnostic sink may fail. Settle this tail so
      // already admitted operations still execute and shutdown can drain their commits.
      socket.destroy();
    });
    this.requestTails.set(socket, tail);
    void tail.then(() => {
      if (this.requestTails.get(socket) === tail) { this.requestTails.delete(socket); }
    });
  }

  /** Validates session authority and operation inputs before reading or mutating any store. */
  private async dispatch(session: ActiveBridgeSession, request: BridgeRequest): Promise<unknown> {
    if (request.sessionId !== session.sessionId || request.workspaceFolderUri !== session.workspaceFolderUri) {
      throw new BridgeProtocolError('invalid-session', 'Request does not match its session.');
    }
    const input = request.method === 'add' ? validateAddParams(request.params) : undefined;
    if (request.method === 'list' && Object.keys(request.params).length !== 0) {
      throw new BridgeProtocolError('invalid-request', 'List does not accept parameters.');
    }
    const scope = input?.scope ?? (session.scopes.length === 1 ? session.scopes[0] : 'workspace');
    if (input && !session.scopes.includes(scope)) {
      throw new BridgeProtocolError('scope-unavailable', 'Scope was not granted.');
    }
    if (!this.isAttached(session)) {
      throw new BridgeProtocolError('workspace-folder-unavailable', 'Selected workspace folder is unavailable.');
    }
    if (!input) {
      const collections: (BookmarkCollection & { scope: BookmarkScope })[] = [];
      const items: (BookmarkItem & { scope: BookmarkScope })[] = [];
      for (const granted of ['workspace', 'global'] as const) {
        if (!session.scopes.includes(granted)) { continue; }
        const data = this.readScope(session, granted);
        collections.push(...data.collections.map(collection => ({ ...collection, scope: granted })));
        items.push(...data.items.map(item => ({ ...item, scope: granted })));
      }
      return { version: CURRENT_SCHEMA_VERSION, workspaceFolderUri: session.workspaceFolderUri,
        grantedScopes: [...session.scopes], collections, items };
    }
    const data = this.readScope(session, scope);
    const collection = input.collectionId !== undefined
      ? data.collections.find(value => value.id === input.collectionId)
      : input.collectionName !== undefined ? data.collections.find(value => value.name === input.collectionName) : undefined;
    if (!collection && (input.collectionId !== undefined || input.collectionName !== undefined)) {
      throw new BridgeProtocolError('collection-not-found', 'Collection is unavailable in the selected scope.');
    }
    const add: AddItemInput = { type: input.type, uri: input.uri, collectionId: collection?.id ?? null,
      description: input.description };
    const item = scope === 'workspace' ? await this.options.workspaceStore.addItem(session.owner, add)
      : await this.options.globalStore.addItem(add);
    return { id: item.id, scope, collection: collection ? { ...collection, scope } : null };
  }

  /** Reads only committed content from the selected store; missing owners fail closed. */
  private readScope(session: ActiveBridgeSession, scope: BookmarkScope): BookmarkData {
    const data = scope === 'workspace' ? this.options.workspaceStore.getOwnerData(session.owner) : this.options.globalStore.getAll();
    if (!data) { throw new BridgeProtocolError('store-unavailable', 'Bookmark store is unavailable.'); }
    return data;
  }

  /** Consumes before any asynchronous work or callback can authenticate the same digest twice. */
  private consumeHello(hello: BridgeHello): ActiveBridgeSession | BridgeStartupCode {
    const digest = digestToken(hello.token);
    const grant = this.pendingGrants.get(digest);
    this.pendingGrants.delete(digest);
    this.cleanupExpired();
    if (grant) {
      this.retire(digest, grant.expiresAt <= this.now() ? 'bootstrap-expired' : 'bootstrap-consumed');
    }
    if (this.stopping) { return 'bridge-unavailable'; }
    if (hello.generation !== this.generation || (grant && grant.generation !== this.generation)) {
      return 'producer-restarted';
    }
    if (!grant) { return this.retiredGrants.get(digest)?.code ?? 'bridge-unavailable'; }
    if (grant.expiresAt <= this.now()) { return 'bootstrap-expired'; }
    if (!this.isAttached(grant)) { return 'workspace-folder-unavailable'; }
    if (!validScopes(grant.scopes)) { return 'scope-unavailable'; }
    return Object.freeze({ ...grant, sessionId: this.createId() });
  }

  /** Compares both root identity and partition ownership against the current attachment. */
  private isAttached(grant: PendingBridgeGrant): boolean {
    const root = this.resolveRoot(grant.workspaceFolderUri);
    return !!root && root.canonicalRootUri === grant.workspaceFolderUri
      && root.owner.kind === 'partition' && grant.owner.kind === 'partition'
      && root.owner.partitionId === grant.owner.partitionId;
  }

  /** Rejects inconsistent root metadata before trusting an attachment's partition identity. */
  private resolveRoot(canonicalRoot: string): ReturnType<LiveMcpBridgeServiceOptions['getAttachedRoot']> {
    const root = this.options.getAttachedRoot(canonicalRoot);
    if (!root || root.canonicalRootUri !== canonicalRoot) { return undefined; }
    try {
      return canonicalizeRootUri(vscode.Uri.parse(root.rootUri, true)) === canonicalRoot ? root : undefined;
    } catch { return undefined; }
  }

  /** Removes expired entries and remembers recent expiration without retaining token material. */
  private cleanupExpired(): void {
    const now = this.now();
    for (const [digest, entry] of this.retiredGrants) {
      if (entry.expiresAt <= now) { this.retiredGrants.delete(digest); }
    }
    for (const [digest, grant] of this.pendingGrants) {
      if (grant.expiresAt <= now) {
        this.pendingGrants.delete(digest);
        this.retire(digest, 'bootstrap-expired');
      }
    }
  }

  /** Records one terminal token status for at most five minutes and 4,096 digests. */
  private retire(digest: string, code: RetiredBridgeGrant['code']): void {
    this.retiredGrants.set(digest, { code, expiresAt: this.now() + 300_000 });
    while (this.retiredGrants.size > 4_096) {
      this.retiredGrants.delete(this.retiredGrants.keys().next().value!);
    }
  }

  /** Validates the exact private directory before considering any stale endpoint removal. */
  private async prepareDirectory(parent: string): Promise<void> {
    const directory = this.directory!;
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== 'EEXIST') { throw error; } }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()
      || await fs.realpath(directory) !== directory || path.dirname(directory) !== parent) {
      throw new Error('Unsafe bridge directory.');
    }
    await fs.chmod(directory, 0o700);
    this.directoryIdentity = stat;
    let socketStat: Stats;
    try { socketStat = await fs.lstat(this.endpoint); }
    catch (error) { if (errorCode(error) === 'ENOENT') { return; } throw error; }
    if (!socketStat.isSocket() || socketStat.uid !== process.getuid!()) { throw new Error('Unsafe bridge endpoint.'); }
    await assertStaleSocket(this.endpoint);
    const currentDirectory = await fs.lstat(directory);
    const currentSocket = await fs.lstat(this.endpoint);
    if (!sameFile(stat, currentDirectory) || !sameFile(socketStat, currentSocket)
      || await fs.realpath(directory) !== directory) { throw new Error('Bridge endpoint changed during startup.'); }
    await fs.unlink(this.endpoint);
  }

  /** Removes only the unchanged, empty owned directory; unrelated files are never recursively deleted. */
  private async removeEmptyDirectory(): Promise<void> {
    if (!this.directory || !this.directoryIdentity) { return; }
    try {
      const stat = await fs.lstat(this.directory);
      if (!stat.isSymbolicLink() && sameFile(stat, this.directoryIdentity)
        && await fs.realpath(this.directory) === this.directory) { await fs.rmdir(this.directory); }
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) { throw error; }
    }
  }
}

/** Hashes bootstrap material before it enters persistent service state. */
function digestToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/** Enforces an exact nonempty set of supported scopes without duplicates. */
function validScopes(scopes: readonly BookmarkScope[]): boolean {
  return Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 2
    && new Set(scopes).size === scopes.length && scopes.every(scope => scope === 'workspace' || scope === 'global');
}

/** Validates the closed add contract, leaving collection lookup within the authorized scope. */
function validateAddParams(params: Record<string, unknown>): AddItemInput & { scope?: BookmarkScope; collectionName?: string } {
  const allowed = ['uri', 'type', 'scope', 'collectionId', 'collectionName', 'description'];
  if (Object.keys(params).some(key => !allowed.includes(key))
    || typeof params.uri !== 'string' || params.uri.trim().length === 0
    || (params.type !== 'file' && params.type !== 'folder')
    || (params.scope !== undefined && params.scope !== 'workspace' && params.scope !== 'global')
    || ['collectionId', 'collectionName', 'description'].some(key => params[key] !== undefined && typeof params[key] !== 'string')) {
    throw new BridgeProtocolError('invalid-request', 'Invalid add parameters.');
  }
  try { vscode.Uri.parse(params.uri, true); }
  catch { throw new BridgeProtocolError('invalid-request', 'Invalid bookmark URI.'); }
  return params as unknown as AddItemInput & { scope?: BookmarkScope; collectionName?: string };
}

/** Encodes a correlated fallback only if its complete UTF-8 frame fits the protocol limit. */
function encodeSizeError(id: string): string | undefined {
  const frame = encodeBridgeMessage({ kind: 'response', id,
    error: { code: 'payload-too-large', message: 'payload-too-large' } });
  return Buffer.byteLength(frame, 'utf8') - 1 <= MAX_LIVE_BRIDGE_FRAME_BYTES ? frame : undefined;
}

/** Narrows filesystem and socket errors without exposing their paths in diagnostics. */
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

/** Compares filesystem identities across validation and cleanup. */
function sameFile(first: Stats, second: Stats): boolean { return first.dev === second.dev && first.ino === second.ino; }

/** Only a refused connection proves staleness; a live or unresponsive listener is preserved. */
async function assertStaleSocket(endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Bridge endpoint is busy.')); }, 250);
    socket.once('connect', () => {
      clearTimeout(timer); socket.destroy(); reject(new Error('Bridge endpoint is already active.'));
    });
    socket.once('error', error => {
      clearTimeout(timer); socket.destroy();
      if (errorCode(error) === 'ECONNREFUSED') { resolve(); }
      else { reject(new Error('Bridge endpoint could not be verified as stale.')); }
    });
  });
}
