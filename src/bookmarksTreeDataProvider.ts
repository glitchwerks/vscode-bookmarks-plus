import * as path from 'path';
import * as vscode from 'vscode';
import { BookmarkContentReader, BookmarkStore } from './bookmarkStore';
import { FsGitCache } from './fsGitCache';
import { RecentItem } from './recentItems';
import { BookmarkCollection, BookmarkData, BookmarkItem, BookmarkScope } from './types';
import { getWorkspaceRelativePath, isInsideWorkspace } from './workspaceFolders';
import { WorkspaceBookmarkStore, WorkspaceStoreView } from './workspaceBookmarkStore';
import { ownerKey, WorkspaceOwnerRef } from './workspacePartitionTypes';

export type GroupMode = 'default' | 'byRepo';
type OwnerEnvelope = { scope: BookmarkScope; owner?: WorkspaceOwnerRef };

/** A tree node always retains its workspace owner once it enters the partitioned path. */
export type BookmarkNode =
  | { kind: 'workspaceRoot'; partitionId: string; label: string; scope: BookmarkScope; collection: BookmarkCollection }
  | { kind: 'unassignedRoot'; scope: BookmarkScope; collection: BookmarkCollection }
  | { kind: 'detachedRoot'; scope: BookmarkScope; collection: BookmarkCollection }
  | { kind: 'detachedPartition'; partitionId: string; label: string; scope: BookmarkScope; collection: BookmarkCollection }
  | { kind: 'workspaceDiagnostic'; message: string; scope: BookmarkScope; collection: BookmarkCollection }
  | { kind: 'globalRoot' }
  | ({ kind: 'collection'; collection: BookmarkCollection; repoLabel?: string; repoKey?: string } & OwnerEnvelope)
  | ({ kind: 'item'; item: BookmarkItem } & OwnerEnvelope)
  | { kind: 'repoGroup'; label: string; repoKey: string; scope?: BookmarkScope; owner?: WorkspaceOwnerRef }
  | { kind: 'suggestedRoot' }
  | { kind: 'suggestion'; recentItem: RecentItem }
  | { kind: 'recentRoot' }
  | { kind: 'recentItem'; uri: string };

export interface SuggestionsSource { getRecentItems: () => RecentItem[]; maxItems: number; }
export interface RecentlyViewedSource { getUris: () => string[]; }

const SHOW_FULL_PATH_STATE_KEY = 'bookmarksPlus.showFullPath';
export const DND_MIME_TYPE = 'application/vnd.code.tree.bookmarksview';
export const UNKNOWN_REPO_LABEL = 'Unknown';
const UNKNOWN_REPO_KEY = '\u0000unknown-repo\u0000';
const LEGACY_OWNER: WorkspaceOwnerRef = { kind: 'partition', partitionId: 'legacy-workspace' };

interface DragEnvelope { readonly scope: BookmarkScope; readonly owner?: WorkspaceOwnerRef; readonly ids: string[]; }
type GlobalBookmarkStore = BookmarkContentReader & Pick<BookmarkStore, 'moveItem'>;

function repoIdentity(repoName: string | undefined): { key: string; label: string } {
  return repoName === undefined ? { key: UNKNOWN_REPO_KEY, label: UNKNOWN_REPO_LABEL } : { key: `repo:${repoName}`, label: repoName };
}
function sameOwner(left: WorkspaceOwnerRef | undefined, right: WorkspaceOwnerRef | undefined): boolean {
  return left !== undefined && right !== undefined && ownerKey(left) === ownerKey(right);
}
function hasContent(data: BookmarkData): boolean { return data.items.length > 0 || data.collections.length > 0; }
function ownerForPartition(partitionId: string): WorkspaceOwnerRef { return { kind: 'partition', partitionId }; }

/** Presents global bookmarks and each workspace partition without flattening ownership boundaries. */
export class BookmarksTreeDataProvider implements vscode.TreeDataProvider<BookmarkNode>, vscode.TreeDragAndDropController<BookmarkNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BookmarkNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<BookmarkNode | undefined | void> = this._onDidChangeTreeData.event;
  private groupMode: GroupMode = 'default';
  private showFullPath: boolean;

  /** BookmarkStore support is temporary compatibility until activation uses WorkspaceBookmarkStore. */
  constructor(
    private readonly workspaceStore: WorkspaceBookmarkStore | BookmarkStore,
    private readonly cache: FsGitCache,
    private readonly globalStore?: GlobalBookmarkStore,
    private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined = () => vscode.workspace.workspaceFolders,
    private readonly suggestions?: SuggestionsSource,
    private readonly recentlyViewed?: RecentlyViewedSource,
    private readonly viewState?: vscode.Memento
  ) {
    this.showFullPath = this.viewState?.get<boolean>(SHOW_FULL_PATH_STATE_KEY, false) ?? false;
    this.workspaceStore.onBookmarksChanged(() => this.refreshFromStore());
    this.globalStore?.onBookmarksChanged(() => this.refreshFromStore());
  }

  readonly dropMimeTypes = [DND_MIME_TYPE];
  readonly dragMimeTypes = [DND_MIME_TYPE];

  async handleDrag(source: readonly BookmarkNode[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
    if (this.groupMode === 'byRepo') return;
    const items = source.filter((node): node is Extract<BookmarkNode, { kind: 'item' }> => node.kind === 'item');
    if (items.length === 0) return;
    const scope = items[0].scope;
    if (!items.every((item) => item.scope === scope)) return;
    let owner = items[0].owner;
    if (scope === 'workspace') {
      if (this.isPartitionedStore()) {
        if (!owner || !items.every((item) => sameOwner(item.owner, owner))) return;
      } else {
        owner ??= LEGACY_OWNER;
        if (!items.every((item) => !item.owner || sameOwner(item.owner, owner))) return;
      }
    }
    dataTransfer.set(DND_MIME_TYPE, new vscode.DataTransferItem({ scope, owner, ids: items.map((item) => item.item.id) } satisfies DragEnvelope));
  }

  async handleDrop(target: BookmarkNode | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
    if (this.groupMode === 'byRepo') return;
    const transferItem = dataTransfer.get(DND_MIME_TYPE);
    if (!transferItem || !isDragEnvelope(transferItem.value)) return;
    const envelope = transferItem.value;
    const partitionedStore = this.partitionedStore();
    if (envelope.scope === 'workspace' && partitionedStore && !envelope.owner) return;
    const sourceOwner = envelope.scope === 'workspace' ? (envelope.owner ?? LEGACY_OWNER) : undefined;
    const targetInfo = this.dropTarget(target, envelope.scope, sourceOwner);
    if (!targetInfo) return;
    if (envelope.scope === 'global') {
      if (!this.globalStore) return;
      const data = this.globalStore.getAll();
      for (const id of envelope.ids) await this.globalStore.moveItem(id, targetInfo.collectionId, targetInfo.index(data));
      return;
    }
    if (partitionedStore) {
      const data = this.workspaceDataForOwner(sourceOwner!);
      if (!data) return;
      for (const id of envelope.ids) await partitionedStore.moveItem(sourceOwner!, id, targetInfo.collectionId, targetInfo.index(data));
      return;
    }
    const data = this.workspaceStore.getAll();
    for (const id of envelope.ids) await (this.workspaceStore as BookmarkStore).moveItem(id, targetInfo.collectionId, targetInfo.index(data));
  }

  getGroupMode(): GroupMode { return this.groupMode; }
  setGroupMode(mode: GroupMode): void { this.groupMode = mode; this._onDidChangeTreeData.fire(); }
  getShowFullPath(): boolean { return this.showFullPath; }
  setShowFullPath(value: boolean): void { this.showFullPath = value; void this.viewState?.update(SHOW_FULL_PATH_STATE_KEY, value); this._onDidChangeTreeData.fire(); }
  refresh(): void { this.refreshFromStore(); }

  async getTreeItem(node: BookmarkNode): Promise<vscode.TreeItem> {
    switch (node.kind) {
      case 'globalRoot': return rootItem('Global', 'bookmarkGlobalRoot', 'globe');
      case 'workspaceRoot': { const item = rootItem(node.label, 'bookmarkWorkspaceRoot', 'root-folder'); item.id = `workspaceRoot:${node.partitionId}`; return item; }
      case 'unassignedRoot': return rootItem('Unassigned', 'bookmarkUnassignedRoot', 'question');
      case 'detachedRoot': { const item = rootItem('Detached', 'bookmarkDetachedRoot', 'archive'); item.id = 'detachedRoot'; return item; }
      case 'detachedPartition': { const item = rootItem(node.label, 'bookmarkDetachedPartition', 'archive'); item.id = `detachedPartition:${node.partitionId}`; return item; }
      case 'workspaceDiagnostic': { const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None); item.contextValue = 'bookmarkWorkspaceDiagnostic'; item.iconPath = new vscode.ThemeIcon('warning'); return item; }
      case 'repoGroup': { const item = rootItem(node.label, 'bookmarkRepoGroup', 'repo'); item.id = `repo:${this.nodeOwnerPrefix(node)}:${node.repoKey}`; return item; }
      case 'suggestedRoot': return rootItem('Suggested', 'bookmarkSuggestedRoot', 'lightbulb');
      case 'recentRoot': return rootItem('Recent', 'bookmarkRecentRoot', 'history');
      case 'suggestion': return leafForUri(node.recentItem.uri, 'bookmarkSuggestion');
      case 'recentItem': return leafForUri(node.uri, 'bookmarkRecentItem');
      case 'collection': { const item = new vscode.TreeItem(node.collection.name, vscode.TreeItemCollapsibleState.Collapsed); item.contextValue = 'bookmarkCollection'; item.id = `collection:${this.nodeOwnerPrefix(node)}:${node.repoKey ?? 'default'}:${node.collection.id}`; if (node.collection.description) item.tooltip = node.collection.description; return item; }
      case 'item': return this.bookmarkTreeItem(node);
    }
  }

  async getChildren(node?: BookmarkNode): Promise<BookmarkNode[]> {
    if (node?.kind === 'suggestedRoot') return this.getSuggestedLeaves();
    if (node?.kind === 'recentRoot') return this.getRecentLeaves();
    if (node?.kind === 'globalRoot' || ((node?.kind === 'collection' || node?.kind === 'repoGroup') && node.scope === 'global')) return this.getGlobalChildren(node);
    return this.partitionedStore() ? this.getPartitionedChildren(node) : this.getLegacyChildren(node);
  }

  private async getPartitionedChildren(node?: BookmarkNode): Promise<BookmarkNode[]> {
    const view = this.partitionedStore()!.getView();
    if (!node) {
      const content = view.kind === 'unavailable' ? [{ kind: 'workspaceDiagnostic', message: 'Workspace data unavailable', scope: 'workspace', collection: undefined as unknown as BookmarkCollection } as BookmarkNode] : await this.partitionRoots(view);
      return this.withRoots(content);
    }
    if (view.kind === 'unavailable') return [];
    if (node.kind === 'workspaceRoot') return this.getOwnerChildren(ownerForPartition(node.partitionId), undefined, view);
    if (node.kind === 'unassignedRoot') return this.getOwnerChildren({ kind: 'unassigned' }, undefined, view);
    if (node.kind === 'detachedRoot') return view.detached.map((partition): BookmarkNode => ({ kind: 'detachedPartition', partitionId: partition.partitionId, label: partition.lastKnownRootUri, scope: 'workspace', collection: undefined as unknown as BookmarkCollection }));
    if (node.kind === 'detachedPartition') return this.getOwnerChildren(ownerForPartition(node.partitionId), undefined, view);
    if ((node.kind === 'collection' || node.kind === 'repoGroup' || node.kind === 'item') && node.scope === 'workspace' && node.owner) return this.getOwnerChildren(node.owner, node, view);
    return [];
  }

  private async partitionRoots(view: WorkspaceStoreView): Promise<BookmarkNode[]> {
    const attached = view.attached.length === 1 ? await this.getOwnerChildren(ownerForPartition(view.attached[0].partitionId), undefined, view) : view.attached.map((partition): BookmarkNode => ({ kind: 'workspaceRoot', partitionId: partition.partitionId, label: partition.label, scope: 'workspace', collection: undefined as unknown as BookmarkCollection }));
    return [...attached, ...(hasContent(view.unassigned) ? [{ kind: 'unassignedRoot', scope: 'workspace', collection: undefined as unknown as BookmarkCollection } as BookmarkNode] : []), ...(view.detached.length > 0 ? [{ kind: 'detachedRoot', scope: 'workspace', collection: undefined as unknown as BookmarkCollection } as BookmarkNode] : [])];
  }

  private async getOwnerChildren(owner: WorkspaceOwnerRef, node: BookmarkNode | undefined, view: WorkspaceStoreView): Promise<BookmarkNode[]> {
    const data = this.workspaceDataForOwner(owner, view);
    if (!data) return [];
    return this.groupMode === 'byRepo' ? this.getChildrenByRepo(node, data.items, data.collections, 'workspace', owner) : this.getChildrenDefault(node, data.items, data.collections, 'workspace', owner);
  }

  private async getLegacyChildren(node?: BookmarkNode): Promise<BookmarkNode[]> {
    const data = this.workspaceStore.getAll();
    const children = this.groupMode === 'byRepo' ? await this.getChildrenByRepo(node, data.items, data.collections, 'workspace', LEGACY_OWNER) : this.getChildrenDefault(node, data.items, data.collections, 'workspace', LEGACY_OWNER);
    return node ? children : this.withRoots(children);
  }

  private async getGlobalChildren(node?: BookmarkNode): Promise<BookmarkNode[]> {
    if (!this.globalStore) return [];
    const data = this.globalStore.getAll();
    return this.getChildrenDefault(node, data.items, data.collections, 'global');
  }

  private async withRoots(children: BookmarkNode[]): Promise<BookmarkNode[]> {
    const suggested = await this.getSuggestedLeaves(); const recent = this.getRecentLeaves();
    return [...(this.globalStore ? [{ kind: 'globalRoot' } as BookmarkNode] : []), ...children, ...(suggested.length ? [{ kind: 'suggestedRoot' } as BookmarkNode] : []), ...(recent.length ? [{ kind: 'recentRoot' } as BookmarkNode] : [])];
  }

  private async getSuggestedLeaves(): Promise<BookmarkNode[]> {
    if (!this.suggestions || this.suggestions.maxItems <= 0) return [];
    const bookmarked = new Set([...this.workspaceStore.getAll().items.map((item) => item.uri), ...(this.globalStore?.getAll().items.map((item) => item.uri) ?? [])]);
    const candidates = this.suggestions.getRecentItems().filter((item) => item.promoted && !bookmarked.has(item.uri)).sort((left, right) => right.firstSeen - left.firstSeen);
    const existing: RecentItem[] = []; for (const item of candidates) if ((await this.cache.get(item.uri)).exists) existing.push(item);
    return existing.slice(0, this.suggestions.maxItems).map((recentItem): BookmarkNode => ({ kind: 'suggestion', recentItem }));
  }
  private getRecentLeaves(): BookmarkNode[] { return this.recentlyViewed?.getUris().map((uri): BookmarkNode => ({ kind: 'recentItem', uri })) ?? []; }

  private getChildrenDefault(node: BookmarkNode | undefined, items: BookmarkItem[], collections: BookmarkCollection[], scope: BookmarkScope, owner?: WorkspaceOwnerRef): BookmarkNode[] {
    if (!node || node.kind === 'globalRoot') return [...collections.slice().sort(byOrder).map((collection): BookmarkNode => ({ kind: 'collection', collection, scope, ...(scope === 'workspace' ? { owner: owner! } : {}) })), ...items.filter((item) => item.collectionId === null).sort(byOrder).map((item): BookmarkNode => ({ kind: 'item', item, scope, ...(scope === 'workspace' ? { owner: owner! } : {}) }))];
    if (node.kind !== 'collection') return [];
    return items.filter((item) => item.collectionId === node.collection.id).sort(byOrder).map((item): BookmarkNode => ({ kind: 'item', item, scope, ...(scope === 'workspace' ? { owner: owner! } : {}) }));
  }

  private async getChildrenByRepo(node: BookmarkNode | undefined, items: BookmarkItem[], collections: BookmarkCollection[], scope: BookmarkScope, owner?: WorkspaceOwnerRef): Promise<BookmarkNode[]> {
    if (!node || node.kind === 'globalRoot') {
      const repos = new Map<string, string>(); for (const item of items) { const identity = repoIdentity((await this.cache.get(item.uri)).repoName); repos.set(identity.key, identity.label); }
      return [...repos].sort(compareRepos).map(([repoKey, label]): BookmarkNode => ({ kind: 'repoGroup', label, repoKey, scope, ...(scope === 'workspace' ? { owner: owner! } : {}) }));
    }
    if (node.kind === 'repoGroup') {
      const inRepo = await this.itemsInRepo(items, node.repoKey); const collectionIds = new Set(inRepo.map((item) => item.collectionId).filter((id): id is string => id !== null));
      return [...collections.filter((collection) => collectionIds.has(collection.id)).sort(byOrder).map((collection): BookmarkNode => ({ kind: 'collection', collection, repoLabel: node.label, repoKey: node.repoKey, scope, ...(scope === 'workspace' ? { owner: owner! } : {}) })), ...inRepo.filter((item) => item.collectionId === null).sort(byOrder).map((item): BookmarkNode => ({ kind: 'item', item, scope, ...(scope === 'workspace' ? { owner: owner! } : {}) }))];
    }
    if (node.kind !== 'collection') return [];
    return (await this.itemsInRepo(items.filter((item) => item.collectionId === node.collection.id), node.repoKey ?? UNKNOWN_REPO_KEY)).sort(byOrder).map((item): BookmarkNode => ({ kind: 'item', item, scope, ...(scope === 'workspace' ? { owner: owner! } : {}) }));
  }

  private async itemsInRepo(items: BookmarkItem[], repoKey: string): Promise<BookmarkItem[]> { const result: BookmarkItem[] = []; for (const item of items) if (repoIdentity((await this.cache.get(item.uri)).repoName).key === repoKey) result.push(item); return result; }

  private dropTarget(target: BookmarkNode | undefined, scope: BookmarkScope, owner: WorkspaceOwnerRef | undefined): { collectionId: string | null; index: (data: BookmarkData) => number } | undefined {
    if (!target) {
      const partitioned = this.partitionedStore();
      if (!partitioned) return scope === 'workspace' ? rootTarget() : undefined;
      const view = partitioned.getView();
      return scope === 'workspace' && owner?.kind === 'partition' && view.kind === 'ready' && view.attached.length === 1 && sameOwner(owner, ownerForPartition(view.attached[0].partitionId)) ? rootTarget() : undefined;
    }
    if (target.kind === 'globalRoot') return scope === 'global' ? rootTarget() : undefined;
    if (target.kind === 'workspaceRoot') return scope === 'workspace' && sameOwner(owner, ownerForPartition(target.partitionId)) && this.isAttachedOwner(ownerForPartition(target.partitionId)) ? rootTarget() : undefined;
    if (target.kind === 'collection') { if (target.scope !== scope || (scope === 'workspace' && (this.partitionedStore() ? !sameOwner(owner, target.owner) || !this.isAttachedOwner(target.owner) : target.owner !== undefined && !sameOwner(owner, target.owner)))) return undefined; return { collectionId: target.collection.id, index: (data) => data.items.filter((item) => item.collectionId === target.collection.id).length }; }
    if (target.kind === 'item') { if (target.scope !== scope || (scope === 'workspace' && (this.partitionedStore() ? !sameOwner(owner, target.owner) || !this.isAttachedOwner(target.owner) : target.owner !== undefined && !sameOwner(owner, target.owner)))) return undefined; return { collectionId: target.item.collectionId, index: () => target.item.order }; }
    return undefined;
  }

  private async bookmarkTreeItem(node: Extract<BookmarkNode, { kind: 'item' }>): Promise<vscode.TreeItem> {
    const uri = vscode.Uri.parse(node.item.uri); const entry = await this.cache.get(node.item.uri); const relative = this.showFullPath ? getWorkspaceRelativePath(uri, this.getWorkspaceFolders()) : undefined;
    const item = new vscode.TreeItem(relative || path.basename(uri.fsPath) || uri.fsPath, vscode.TreeItemCollapsibleState.None); item.id = `item:${this.nodeOwnerPrefix(node)}:${node.item.id}`;
    item.contextValue = node.scope === 'global' && node.item.type === 'folder' && !isInsideWorkspace(uri, this.getWorkspaceFolders()) ? 'bookmarkItem-addable' : 'bookmarkItem'; item.resourceUri = uri;
    if (node.item.description) item.tooltip = `${uri.fsPath}\n\n${node.item.description}`;
    if (!entry.exists) { item.iconPath = new vscode.ThemeIcon('warning'); item.description = 'missing'; } else { item.iconPath = new vscode.ThemeIcon(node.item.type === 'folder' ? 'folder' : 'file'); if (entry.repoName) item.description = entry.repoName; }
    item.command = node.item.type === 'file' ? { command: 'vscode.open', title: 'Open', arguments: [uri] } : { command: 'bookmarks.reveal', title: 'Reveal in Explorer', arguments: [node] }; return item;
  }

  private workspaceDataForOwner(owner: WorkspaceOwnerRef, view?: WorkspaceStoreView): BookmarkData | undefined {
    const current = view ?? this.partitionedStore()!.getView(); if (current.kind === 'unavailable') return undefined; if (owner.kind === 'unassigned') return current.unassigned;
    return current.attached.find((partition) => partition.partitionId === owner.partitionId)?.data ?? current.detached.find((partition) => partition.partitionId === owner.partitionId)?.data;
  }
  private nodeOwnerPrefix(node: { scope?: BookmarkScope; owner?: WorkspaceOwnerRef }): string { return node.scope === 'global' ? 'global' : node.owner ? ownerKey(node.owner) : 'legacy-workspace'; }
  private isPartitionedStore(): boolean { return this.partitionedStore() !== undefined; }
  private partitionedStore(): WorkspaceBookmarkStore | undefined { return 'getView' in this.workspaceStore ? this.workspaceStore as WorkspaceBookmarkStore : undefined; }
  private isAttachedOwner(owner: WorkspaceOwnerRef | undefined): boolean {
    if (!owner || owner.kind !== 'partition') return false;
    const view = this.partitionedStore()?.getView();
    return view?.kind === 'ready' && view.attached.some((partition) => partition.partitionId === owner.partitionId);
  }
  private refreshFromStore(): void { this.cache.invalidateAll(); this._onDidChangeTreeData.fire(); }
}

function isDragEnvelope(value: unknown): value is DragEnvelope {
  if (!value || typeof value !== 'object') return false; const candidate = value as Partial<DragEnvelope>;
  if ((candidate.scope !== 'workspace' && candidate.scope !== 'global') || !Array.isArray(candidate.ids) || !candidate.ids.every((id) => typeof id === 'string')) return false;
  return candidate.owner === undefined || (typeof candidate.owner === 'object' && candidate.owner !== null && (candidate.owner.kind === 'unassigned' || (candidate.owner.kind === 'partition' && typeof candidate.owner.partitionId === 'string')));
}
function rootItem(label: string, contextValue: string, icon: string): vscode.TreeItem { const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed); item.contextValue = contextValue; item.iconPath = new vscode.ThemeIcon(icon); return item; }
function leafForUri(value: string, contextValue: string): vscode.TreeItem { const uri = vscode.Uri.parse(value); const item = new vscode.TreeItem(path.basename(uri.fsPath) || uri.fsPath, vscode.TreeItemCollapsibleState.None); item.contextValue = contextValue; item.resourceUri = uri; item.iconPath = new vscode.ThemeIcon('file'); item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] }; return item; }
function byOrder(left: { order: number }, right: { order: number }): number { return left.order - right.order; }
function compareRepos([keyA, labelA]: [string, string], [keyB, labelB]: [string, string]): number { if (keyA === UNKNOWN_REPO_KEY) return 1; if (keyB === UNKNOWN_REPO_KEY) return -1; return labelA.localeCompare(labelB); }
function rootTarget(): { collectionId: null; index: (data: BookmarkData) => number } { return { collectionId: null, index: (data) => data.items.filter((item) => item.collectionId === null).length }; }
