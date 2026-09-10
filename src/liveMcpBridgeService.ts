import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BookmarkStore, OutputSink } from './bookmarkStore';
import type { WorkspaceBookmarkStore } from './workspaceBookmarkStore';
import type { WorkspaceOwnerRef } from './workspacePartitionTypes';
import type { BookmarkScope } from './types';
import { canonicalizeRootUri } from './rootUri';
import {
  BridgeHello, BridgeStartupCode, NdjsonFrameDecoder,
  decodeClientBridgeMessage, encodeBridgeMessage
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
    this.stopPromise = new Promise<void>(resolve => {
      if (this.server.listening) { this.server.close(() => resolve()); }
      else { resolve(); }
      for (const socket of this.sockets) { socket.destroy(); }
      this.sessions.clear();
    }).then(() => this.removeEmptyDirectory());
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
    let terminal = false;
    socket.on('close', () => { this.sockets.delete(socket); this.sessions.delete(socket); });
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      if (terminal) { return; }
      try {
        for (const frame of decoder.push(chunk)) {
          const message = decodeClientBridgeMessage(JSON.parse(frame));
          if (message.kind !== 'hello' || this.sessions.has(socket)) {
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
