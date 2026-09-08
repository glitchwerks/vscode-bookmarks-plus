import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { MirrorPort, hashContent, serializeBookmarkData } from './bookmarkMirror';
import { OutputSink } from './bookmarkStore';
import { WorkspaceBookmarkStore } from './workspaceBookmarkStore';
import { RootCandidate, canonicalizeRootUri } from './rootUri';
import { RootReconcileResult } from './workspacePartitionTypes';
import { BookmarkData, isStrictBookmarkData } from './types';
import { migrateBookmarkData } from './migrations';
import { normalizeBookmarkData } from './normalize';
import { Delayer } from './delayer';

export interface PartitionMirrorResources extends vscode.Disposable {
  readonly port: MirrorPort;
  readonly onDidChange: vscode.Event<void>;
  readonly onDidCreate: vscode.Event<void>;
  readonly onDidDelete: vscode.Event<void>;
}

export interface WorkspaceMirrorCoordinatorOptions {
  readonly store: WorkspaceBookmarkStore;
  readonly output: OutputSink;
  readonly createResources: (root: vscode.Uri) => PartitionMirrorResources;
  readonly writeDelayMs?: number;
}

interface PartitionBinding {
  readonly partitionId: string;
  readonly rootIdentity: string;
  readonly generation: number;
  readonly resources: PartitionMirrorResources;
  readonly subscriptions: vscode.Disposable[];
  readonly delayer: Delayer;
  operationTail: Promise<void>;
  writeTail: Promise<void>;
  scheduledRevision: number;
  scheduledContent?: string;
  removing: boolean;
  disposed: boolean;
}

/** A root acquired newer content between its flush and the serialized detachment check. */
class MirrorRemovalChangedError extends Error {}

type MirrorDiagnostic = 'reconcile' | 'reload' | 'flush' | 'bind' | 'write' | 'read' | 'reject' | 'deleted' | 'remove-flush';

/** Owns independent mirror queues and watcher lifetimes for attached workspace partitions. */
export class WorkspaceMirrorCoordinator implements vscode.Disposable {
  private readonly bindings = new Map<string, PartitionBinding>();
  private readonly subscriptions: vscode.Disposable[];
  private lifecycleTail: Promise<void> = Promise.resolve();
  private nextGeneration = 1;
  private contentRevision = 0;
  private disposed = false;

  constructor(private readonly options: WorkspaceMirrorCoordinatorOptions) {
    this.subscriptions = [
      options.store.onBookmarksChanged(() => {
        this.contentRevision++;
        this.scheduleDirtyPartitions();
      }),
      options.store.onDidChangePartitions(() => {
        void this.reconcileBindings().catch(() => this.log('lifecycle', 'reconcile'));
      })
    ];
  }

  /** Reconciles resources against the committed attachment set. Failures remain root-local. */
  reconcileBindings(): Promise<void> {
    return this.enqueueLifecycle(() => this.reconcileNow());
  }

  /** Drains removed roots before detachment, then binds the newly committed attachment set. */
  handleRootsChanged(roots: readonly RootCandidate[]): Promise<RootReconcileResult> {
    return this.enqueueLifecycle(async () => {
      if (this.disposed) { throw new Error('Workspace mirror coordinator is disposed.'); }
      const retained = new Set(roots.map((root) => canonicalizeRootUri(root.uri)));
      const removing = [...this.bindings.values()].filter((binding) => !retained.has(binding.rootIdentity));
      removing.forEach((binding) => { binding.removing = true; });
      while (!this.disposed) {
        const flushed = new Map<string, { content?: string; failed: boolean }>();
        await Promise.all(removing.map(async (binding) => {
          let failed = false;
          try { await this.flushPartition(binding.partitionId); }
          catch { failed = true; this.log(binding.partitionId, 'remove-flush'); }
          const state = this.options.store.getMirrorState(binding.partitionId);
          flushed.set(binding.partitionId, { content: state && serializeBookmarkData(state.data), failed });
        }));
        try {
          const result = await this.options.store.reconcileRoots(roots, () => {
            if (this.disposed) { throw new Error('Workspace mirror coordinator is disposed.'); }
            // This runs inside the store queue. Later mutations cannot begin until detach commits.
            for (const binding of removing) {
              const state = this.options.store.getMirrorState(binding.partitionId);
              const attempt = flushed.get(binding.partitionId)!;
              if (attempt.content !== (state && serializeBookmarkData(state.data)) || (state?.dirty && !attempt.failed)) {
                throw new MirrorRemovalChangedError();
              }
            }
            this.retireBindings(removing);
          });
          await this.reconcileNow();
          return result;
        } catch (error) {
          if (error instanceof MirrorRemovalChangedError) { continue; }
          removing.forEach((binding) => { binding.removing = false; });
          this.scheduleDirtyPartitions();
          await this.reconcileNow();
          throw error;
        }
      }
      throw new Error('Workspace mirror coordinator is disposed.');
    });
  }

  /** Reads one mirror after its queued local writes; other partitions never enter this queue. */
  reloadPartition(partitionId: string): Promise<void> {
    const binding = this.bindings.get(partitionId);
    return binding && !binding.removing ? this.enqueue(binding, () => this.reloadNow(binding, false)) : Promise.resolve();
  }

  /** Writes the latest dirty snapshot after all earlier work for this partition. */
  flushPartition(partitionId: string): Promise<void> {
    const binding = this.bindings.get(partitionId);
    if (!binding) { return Promise.resolve(); }
    binding.delayer.dispose();
    return this.enqueue(binding, async () => {
      do { await this.writeCurrent(binding); }
      while (this.isCurrent(binding) && this.options.store.getMirrorState(partitionId)?.dirty);
    });
  }

  /** Attempts every current binding and rejects only after all attempts have settled. */
  async flushAll(): Promise<void> {
    const bindings = [...this.bindings.values()];
    const results = await Promise.allSettled(bindings.map((binding) => this.flushPartition(binding.partitionId)));
    const errors: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.log(bindings[index].partitionId, 'flush');
        errors.push(result.reason);
      }
    });
    if (errors.length > 0) { throw new AggregateError(errors, 'Workspace mirror flush failed.'); }
  }

  /** Drains accepted store, lifecycle, and binding work before completing the shutdown flush. */
  async drainAndFlush(): Promise<void> {
    const errors: unknown[] = [];
    for (;;) {
      await this.options.store.whenIdle();
      const lifecycle = this.lifecycleTail;
      await lifecycle;
      await this.options.store.whenIdle();
      // Recovery and mirror adoption can publish more lifecycle work while a binding settles.
      if (lifecycle !== this.lifecycleTail) { continue; }
      const contentRevision = this.contentRevision;
      try { await this.flushAll(); }
      catch (error) { errors.push(error); }
      // A watcher can enqueue a read after its root flushed while another root is still writing.
      // Reads have no store/content event until I/O finishes, so their tails must also settle.
      const operations = [...this.bindings.values()].map(binding => ({ binding, tail: binding.operationTail }));
      await Promise.all(operations.map(operation => operation.tail));
      await this.options.store.whenIdle();
      const bindingsIdle = operations.length === this.bindings.size && operations.every(({ binding, tail }) =>
        this.bindings.get(binding.partitionId) === binding && binding.operationTail === tail);
      // An edit can arrive after its root flushed while another root still has pending I/O.
      if (bindingsIdle && lifecycle === this.lifecycleTail && contentRevision === this.contentRevision) { break; }
    }
    if (errors.length > 0) { throw new AggregateError(errors, 'Workspace mirror shutdown flush failed.'); }
  }

  /** Cancels pending work and prevents in-flight reads and writes from publishing metadata. */
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    runCleanup([
      ...this.subscriptions.map((subscription) => () => subscription.dispose()),
      () => this.retireBindings([...this.bindings.values()])
    ]);
  }

  private async reconcileNow(): Promise<void> {
    if (this.disposed) { return; }
    const view = this.options.store.getView();
    const attached = view.attached.filter(partition => !view.unavailableRoots.includes(partition.canonicalRootUri));
    const removalResults = await Promise.allSettled([...this.bindings.values()].filter((binding) => !attached.some((partition) =>
      partition.partitionId === binding.partitionId && partition.canonicalRootUri === binding.rootIdentity
    )).map((binding) => this.removeBinding(binding)));
    const bindingResults = await Promise.allSettled((this.disposed ? [] : attached).map(async (partition) => {
      if (this.bindings.has(partition.partitionId)) { return; }
      let resources: PartitionMirrorResources | undefined;
      let binding: PartitionBinding | undefined;
      try {
        resources = this.options.createResources(vscode.Uri.parse(partition.rootUri));
        binding = {
          partitionId: partition.partitionId, rootIdentity: partition.canonicalRootUri,
          generation: this.nextGeneration++, resources, subscriptions: [],
          delayer: new Delayer(this.options.writeDelayMs ?? 250),
          operationTail: Promise.resolve(), writeTail: Promise.resolve(), scheduledRevision: 0, removing: false, disposed: false
        };
        this.bindings.set(binding.partitionId, binding);
        const current = binding;
        for (const event of [resources.onDidChange, resources.onDidCreate, resources.onDidDelete]) {
          binding.subscriptions.push(event(() => {
            void this.reloadPartition(current.partitionId).catch(() => this.log(current.partitionId, 'reload'));
          }));
        }
      } catch {
        try {
          if (binding) { this.retireBinding(binding); }
          else { resources?.dispose(); }
        } finally { this.log(partition.partitionId, 'bind'); }
        return;
      }
      try { await this.enqueue(binding, () => this.reloadNow(binding!, true)); }
      catch { this.log(partition.partitionId, 'reconcile'); }
    }));
    const failures = [...removalResults, ...bindingResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) { throw new AggregateError(failures, 'Workspace mirror cleanup failed.'); }
  }

  private scheduleDirtyPartitions(): void {
    for (const binding of this.bindings.values()) {
      const state = this.options.store.getMirrorState(binding.partitionId);
      if (!this.isCurrent(binding) || binding.removing || !state?.dirty) { continue; }
      const content = serializeBookmarkData(state.data);
      if (content === binding.scheduledContent) { continue; }
      binding.scheduledContent = content;
      binding.scheduledRevision++;
      binding.delayer.trigger(() => this.enqueue(binding, () => this.writeCurrent(binding))
        .catch(() => this.log(binding.partitionId, 'write')));
    }
  }

  private async reloadNow(binding: PartitionBinding, seedMissing: boolean): Promise<void> {
    if (!this.isCurrent(binding)) { return; }
    const initial = this.options.store.getMirrorState(binding.partitionId);
    if (!initial) { return; }
    if (initial.dirty) { await this.writeCurrent(binding); return; }
    const revision = binding.scheduledRevision;
    let content: string | undefined;
    try { content = await binding.resources.port.read(); }
    catch { this.log(binding.partitionId, 'read'); return; }
    const current = this.options.store.getMirrorState(binding.partitionId);
    if (!this.isCurrent(binding) || !current || current.dirty || revision !== binding.scheduledRevision
      || serializeBookmarkData(current.data) !== serializeBookmarkData(initial.data)) { return; }
    if (content === undefined) {
      if (seedMissing) { await this.writeCurrent(binding, true); }
      else { this.log(binding.partitionId, 'deleted'); }
      return;
    }
    const hash = hashContent(content);
    if (hash === current.hash) { return; }
    let prepared: { data: BookmarkData; rewrite: boolean };
    try { prepared = this.prepareExternal(binding.partitionId, content, current.data); }
    catch { this.log(binding.partitionId, 'reject'); return; }
    if (!this.isCurrent(binding)) { return; }
    await this.options.store.adoptMirrorData(binding.partitionId, prepared.data, hash, prepared.rewrite, () => this.isCurrent(binding));
    if (this.options.store.getMirrorState(binding.partitionId)?.dirty) {
      binding.delayer.dispose();
      await this.writeCurrent(binding);
    }
  }

  private async writeCurrent(binding: PartitionBinding, force = false): Promise<void> {
    if (!this.isCurrent(binding)) { return; }
    const operation = binding.writeTail.then(async () => {
      if (!this.isCurrent(binding)) { return; }
      const state = this.options.store.getMirrorState(binding.partitionId);
      if (!state || (!state.dirty && !force)) { return; }
      const content = serializeBookmarkData(state.data);
      try {
        await binding.resources.port.write(content);
        if (this.isCurrent(binding)) {
          await this.options.store.recordMirrorWrite(binding.partitionId, hashContent(content), () => this.isCurrent(binding));
        }
      } catch (error) {
        if (this.isCurrent(binding)) { await this.options.store.recordMirrorDirty(binding.partitionId, () => this.isCurrent(binding)); }
        throw error;
      } finally { binding.scheduledContent = undefined; }
    });
    binding.writeTail = operation.catch(() => undefined);
    await operation;
  }

  private prepareExternal(partitionId: string, content: string, current: BookmarkData): { data: BookmarkData; rewrite: boolean } {
    const parsed: unknown = JSON.parse(content);
    if (!isStrictBookmarkData(parsed)) { throw new Error('Malformed mirror payload.'); }
    const migrated = migrateBookmarkData(parsed);
    for (const item of migrated.items) {
      if (current.items.some((existing) => existing.id === item.id && existing.uri === item.uri)) { continue; }
      const owner = this.options.store.resolveAttachedOwner(vscode.Uri.parse(item.uri));
      if (owner?.kind !== 'partition' || owner.partitionId !== partitionId) { throw new Error('External URI crosses its partition boundary.'); }
    }
    const view = this.options.store.getView();
    const partitions = [...view.attached, ...view.detached];
    const otherData = [...partitions.filter((p) => p.partitionId !== partitionId).map((p) => p.data), view.unassigned];
    const used = new Set([...partitions.map((p) => p.partitionId),
      ...otherData.flatMap((data) => [...data.items, ...data.collections].map((entry) => entry.id))]);
    // Reserve all imported identifiers before allocating, including identifiers encountered later.
    const reserved = new Set([...used, ...migrated.items.map((item) => item.id), ...migrated.collections.map((c) => c.id)]);
    let repaired = parsed.version !== migrated.version;
    const allocate = (id: string): string => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && !used.has(id)) {
        used.add(id); return id;
      }
      let replacement: string;
      do { replacement = randomUUID(); } while (reserved.has(replacement));
      used.add(replacement); reserved.add(replacement); repaired = true;
      return replacement;
    };
    const collectionIds = new Map<string, string>();
    const collections = migrated.collections.map((collection) => {
      const id = allocate(collection.id);
      if (!collectionIds.has(collection.id)) { collectionIds.set(collection.id, id); }
      return { ...collection, id };
    });
    const items = migrated.items.map((item) => ({ ...item, id: allocate(item.id),
      collectionId: item.collectionId === null ? null : collectionIds.get(item.collectionId) ?? item.collectionId }));
    const normalized = normalizeBookmarkData({ version: migrated.version, items, collections });
    return { data: normalized.data, rewrite: repaired || normalized.changed || !isDeepStrictEqual(migrated, normalized.data) };
  }

  private async removeBinding(binding: PartitionBinding): Promise<void> {
    try { await this.flushPartition(binding.partitionId); }
    catch { this.log(binding.partitionId, 'remove-flush'); }
    this.retireBinding(binding);
  }

  private retireBinding(binding: PartitionBinding): void {
    try { this.disposeBinding(binding); }
    finally {
      if (this.bindings.get(binding.partitionId) === binding) { this.bindings.delete(binding.partitionId); }
    }
  }

  private retireBindings(bindings: readonly PartitionBinding[]): void {
    runCleanup(bindings.map((binding) => () => this.retireBinding(binding)));
  }

  private disposeBinding(binding: PartitionBinding): void {
    if (binding.disposed) { return; }
    binding.disposed = true;
    runCleanup([binding.delayer, ...binding.subscriptions, binding.resources]
      .map((disposable) => () => disposable.dispose()));
  }

  private isCurrent(binding: PartitionBinding): boolean {
    return !this.disposed && !binding.disposed && this.bindings.get(binding.partitionId)?.generation === binding.generation
      && !this.options.store.getView().unavailableRoots.includes(binding.rootIdentity);
  }

  private enqueue(binding: PartitionBinding, operation: () => Promise<void>): Promise<void> {
    const result = binding.operationTail.then(() => this.isCurrent(binding) ? operation() : undefined);
    binding.operationTail = result.catch(() => undefined);
    return result;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private log(partitionId: string, category: MirrorDiagnostic): void {
    this.options.output.appendLine(`WorkspaceMirrorCoordinator: ${partitionId} ${category}`);
  }
}

/** Attempts every cleanup exactly once and surfaces failures only after the entire batch. */
function runCleanup(actions: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const action of actions) {
    try { action(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length > 0) { throw new AggregateError(errors, 'Workspace mirror cleanup failed.'); }
}
