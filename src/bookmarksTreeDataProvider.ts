import * as vscode from 'vscode';
import * as path from 'path';
import { BookmarkStore } from './bookmarkStore';
import { BookmarkItem, BookmarkCollection, BookmarkScope } from './types';
import { FsGitCache } from './fsGitCache';
import { isInsideWorkspace } from './workspaceFolders';
import { RecentItem } from './recentItems';

export type GroupMode = 'default' | 'byRepo';

export type BookmarkNode =
  | { kind: 'globalRoot' }
  | { kind: 'collection'; collection: BookmarkCollection; repoLabel?: string; repoKey?: string; scope: BookmarkScope }
  | { kind: 'item'; item: BookmarkItem; scope: BookmarkScope }
  | { kind: 'repoGroup'; label: string; repoKey: string }
  | { kind: 'suggestedRoot' }
  | { kind: 'suggestion'; recentItem: RecentItem };

/**
 * Optional 5th constructor argument (#95, T5): synthesizes a "Suggested" root row from recently
 * opened, not-yet-bookmarked items. Omitted entirely by every existing call site, so the Suggested
 * row is additive — it is never synthesized unless a caller opts in.
 */
export interface SuggestionsSource {
  getRecentItems: () => RecentItem[];
  maxItems: number;
}

export const DND_MIME_TYPE = 'application/vnd.code.tree.bookmarksview';
export const UNKNOWN_REPO_LABEL = 'Unknown';

/**
 * The drag transfer payload (spec §6, D5): scope-tagged so handleDrop can tell a
 * workspace-scoped drag apart from a global-scoped one and refuse cross-scope moves.
 */
interface DragEnvelope {
  scope: BookmarkScope;
  ids: string[];
}

const UNKNOWN_REPO_KEY = '\u0000unknown-repo\u0000';

function repoIdentity(repoName: string | undefined): { key: string; label: string } {
  if (repoName === undefined) {
    return { key: UNKNOWN_REPO_KEY, label: UNKNOWN_REPO_LABEL };
  }
  return { key: `repo:${repoName}`, label: repoName };
}

export class BookmarksTreeDataProvider implements vscode.TreeDataProvider<BookmarkNode>, vscode.TreeDragAndDropController<BookmarkNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BookmarkNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<BookmarkNode | undefined | void> = this._onDidChangeTreeData.event;

  private groupMode: GroupMode = 'default';

  constructor(
    private readonly store: BookmarkStore,
    private readonly cache: FsGitCache,
    private readonly globalStore?: BookmarkStore,
    private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined = () =>
      vscode.workspace.workspaceFolders,
    private readonly suggestions?: SuggestionsSource
  ) {
    this.store.onBookmarksChanged(() => {
      this.cache.invalidateAll();
      this._onDidChangeTreeData.fire();
    });
    this.globalStore?.onBookmarksChanged(() => {
      this.cache.invalidateAll();
      this._onDidChangeTreeData.fire();
    });
  }

  readonly dropMimeTypes = [DND_MIME_TYPE];
  readonly dragMimeTypes = [DND_MIME_TYPE];

  async handleDrag(
    source: readonly BookmarkNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    if (this.groupMode === 'byRepo') {
      return; // DnD disabled in group-by-repo mode (spec §4).
    }
    const items = source.filter(
      (n): n is Extract<BookmarkNode, { kind: 'item' }> => n.kind === 'item'
    );
    if (items.length === 0) {
      return;
    }
    const scope = items[0].scope;
    if (!items.every((n) => n.scope === scope)) {
      return; // A mixed-scope selection is refused rather than silently split (spec §6, D5).
    }
    const envelope: DragEnvelope = { scope, ids: items.map((n) => n.item.id) };
    dataTransfer.set(DND_MIME_TYPE, new vscode.DataTransferItem(envelope));
  }

  async handleDrop(
    target: BookmarkNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    if (this.groupMode === 'byRepo') {
      return; // DnD disabled in group-by-repo mode (spec §4).
    }
    const transferItem = dataTransfer.get(DND_MIME_TYPE);
    if (!transferItem) {
      return;
    }
    const envelope: DragEnvelope = transferItem.value;

    // Resolve the acting store from the envelope's scope, not the target's — this is what lets
    // handleDrop refuse a cross-scope move instead of silently writing to the wrong store (D5).
    const activeStore = envelope.scope === 'global' ? this.globalStore : this.store;
    if (!activeStore) {
      return; // Defensive: a global envelope with no globalStore configured is a no-op.
    }
    const data = activeStore.getAll();

    let newCollectionId: string | null;
    let newIndex: number;

    if (!target) {
      // An untargeted drop always means "append to this scope's root" — but per D5 that is only
      // ever valid for the workspace scope; a global-scope envelope with no target is refused.
      if (envelope.scope !== 'workspace') {
        return;
      }
      newCollectionId = null;
      newIndex = data.items.filter((i) => i.collectionId === null).length;
    } else if (target.kind === 'globalRoot') {
      // The Global row is only a valid ungroup target for a global-scope envelope.
      if (envelope.scope !== 'global') {
        return;
      }
      newCollectionId = null;
      newIndex = data.items.filter((i) => i.collectionId === null).length;
    } else if (target.kind === 'collection') {
      // The target collection must belong to the same scope as the dragged envelope.
      if (target.scope !== envelope.scope) {
        return;
      }
      newCollectionId = target.collection.id;
      newIndex = data.items.filter((i) => i.collectionId === target.collection.id).length;
    } else if (target.kind === 'item') {
      // The target item must belong to the same scope as the dragged envelope.
      if (target.scope !== envelope.scope) {
        return;
      }
      newCollectionId = target.item.collectionId;
      newIndex = target.item.order;
    } else {
      return; // repoGroup nodes are not valid drop targets.
    }

    for (const id of envelope.ids) {
      // Calls the exact same BookmarkStore.moveItem() path every command handler uses (spec §2) —
      // there is no special-case write path for drag-and-drop.
      await activeStore.moveItem(id, newCollectionId, newIndex);
    }
  }

  getGroupMode(): GroupMode {
    return this.groupMode;
  }

  setGroupMode(mode: GroupMode): void {
    this.groupMode = mode;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this.cache.invalidateAll();
    this._onDidChangeTreeData.fire();
  }

  async getTreeItem(node: BookmarkNode): Promise<vscode.TreeItem> {
    if (node.kind === 'globalRoot') {
      const treeItem = new vscode.TreeItem('Global', vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.contextValue = 'bookmarkGlobalRoot';
      treeItem.iconPath = new vscode.ThemeIcon('globe');
      return treeItem;
    }

    if (node.kind === 'repoGroup') {
      const treeItem = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.contextValue = 'bookmarkRepoGroup';
      treeItem.iconPath = new vscode.ThemeIcon('repo');
      return treeItem;
    }

    if (node.kind === 'suggestedRoot') {
      // Collapsed by default, present in both group modes, positioned last (D8).
      const treeItem = new vscode.TreeItem('Suggested', vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.contextValue = 'bookmarkSuggestedRoot';
      treeItem.iconPath = new vscode.ThemeIcon('lightbulb');
      return treeItem;
    }

    if (node.kind === 'suggestion') {
      const uri = vscode.Uri.parse(node.recentItem.uri);
      const label = path.basename(uri.fsPath) || uri.fsPath;
      const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      treeItem.contextValue = 'bookmarkSuggestion';
      treeItem.resourceUri = uri;
      treeItem.iconPath = new vscode.ThemeIcon('file');
      // Independently clickable to open in an editor tab while it stays in the recent list —
      // promoting into a real bookmark is a separate action (bookmarks.promoteSuggestion, T6).
      treeItem.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
      return treeItem;
    }

    if (node.kind === 'collection') {
      const treeItem = new vscode.TreeItem(node.collection.name, vscode.TreeItemCollapsibleState.Collapsed);
      treeItem.contextValue = 'bookmarkCollection';
      treeItem.id = node.repoLabel ? `collection:${node.repoLabel}:${node.collection.id}` : `collection:${node.collection.id}`;
      if (node.collection.description) {
        treeItem.tooltip = node.collection.description;
      }
      return treeItem;
    }

    const bookmark = node.item;
    const uri = vscode.Uri.parse(bookmark.uri);
    const entry = await this.cache.get(bookmark.uri);
    const label = path.basename(uri.fsPath) || uri.fsPath;

    const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    treeItem.id = `item:${bookmark.id}`;
    // A global-scoped folder bookmark not already inside a current workspace folder gets a
    // distinct contextValue so a future "Add to Workspace" command (T10) can target it via a
    // `view/item/context` when clause (#56, T9).
    const isAddableGlobalFolder =
      node.scope === 'global' && bookmark.type === 'folder' && !isInsideWorkspace(uri, this.getWorkspaceFolders());
    treeItem.contextValue = isAddableGlobalFolder ? 'bookmarkItem-addable' : 'bookmarkItem';
    treeItem.resourceUri = uri;
    if (bookmark.description) {
      // TreeItem.description is already taken by the 'missing'/repo-name badge below,
      // so the bookmark's own description goes in the tooltip. Setting a tooltip overrides
      // VS Code's default path hover, so include the path here as well.
      treeItem.tooltip = `${uri.fsPath}\n\n${bookmark.description}`;
    }

    if (!entry.exists) {
      treeItem.iconPath = new vscode.ThemeIcon('warning');
      treeItem.description = 'missing';
    } else {
      treeItem.iconPath = new vscode.ThemeIcon(bookmark.type === 'folder' ? 'folder' : 'file');
      if (entry.repoName) {
        treeItem.description = entry.repoName;
      }
    }

    treeItem.command =
      bookmark.type === 'file'
        ? { command: 'vscode.open', title: 'Open', arguments: [uri] }
        : { command: 'bookmarks.reveal', title: 'Reveal in Explorer', arguments: [node] };

    return treeItem;
  }

  async getChildren(node?: BookmarkNode): Promise<BookmarkNode[]> {
    if (node?.kind === 'suggestedRoot') {
      return this.getSuggestedLeaves();
    }

    if (node?.kind === 'globalRoot' || (node?.kind === 'collection' && node.scope === 'global')) {
      if (!this.globalStore) {
        return [];
      }
      const globalData = this.globalStore.getAll();
      return this.getChildrenDefault(node, globalData.items, globalData.collections, 'global');
    }

    const data = this.store.getAll();

    if (this.groupMode === 'byRepo') {
      const children = await this.getChildrenByRepo(node, data.items, data.collections);
      return !node ? await this.withRoots(children) : children;
    }
    const children = this.getChildrenDefault(node, data.items, data.collections, 'workspace');
    return !node ? await this.withRoots(children) : children;
  }

  /** Prepends the Global row and appends the Suggested row (D8) to a set of root-level children. */
  private async withRoots(children: BookmarkNode[]): Promise<BookmarkNode[]> {
    const suggestedLeaves = await this.getSuggestedLeaves();
    return [
      ...(this.globalStore ? [{ kind: 'globalRoot' } as BookmarkNode] : []),
      ...children,
      ...(suggestedLeaves.length > 0 ? [{ kind: 'suggestedRoot' } as BookmarkNode] : [])
    ];
  }

  /**
   * The Suggested row's children (T5): promoted recent items not already bookmarked in either
   * store (C7/D9), sorted most-recent-first-seen first, filtered for staleness (CodeRabbit: stale
   * persisted suggestion URIs — D4's filter-at-render choice, reusing the same `FsGitCache`
   * existence-check seam `getTreeItem` uses for the "missing" bookmark warning icon), and only
   * then capped at `maxItems` (D3/D6) — staleness filtering must happen before the cap so a stale
   * entry never crowds out a valid one. Returns `[]` — hiding the row entirely (D8) — when no
   * `suggestions` source was supplied, when `maxItems` is 0 (the setting's off-switch, D3), or
   * when every candidate turns out to be stale.
   */
  private async getSuggestedLeaves(): Promise<BookmarkNode[]> {
    if (!this.suggestions || this.suggestions.maxItems <= 0) {
      return [];
    }
    const bookmarkedUris = new Set([
      ...this.store.getAll().items.map((i) => i.uri),
      ...(this.globalStore?.getAll().items.map((i) => i.uri) ?? [])
    ]);
    const candidates = this.suggestions
      .getRecentItems()
      .filter((recentItem) => recentItem.promoted && !bookmarkedUris.has(recentItem.uri))
      .sort((a, b) => b.firstSeen - a.firstSeen);

    const existing: RecentItem[] = [];
    for (const recentItem of candidates) {
      const entry = await this.cache.get(recentItem.uri);
      if (entry.exists) {
        existing.push(recentItem);
      }
    }

    return existing
      .slice(0, this.suggestions.maxItems)
      .map((recentItem): BookmarkNode => ({ kind: 'suggestion', recentItem }));
  }

  private getChildrenDefault(
    node: BookmarkNode | undefined,
    items: BookmarkItem[],
    collections: BookmarkCollection[],
    scope: BookmarkScope
  ): BookmarkNode[] {
    if (!node || node.kind === 'globalRoot') {
      const collectionNodes: BookmarkNode[] = [...collections]
        .sort((a, b) => a.order - b.order)
        .map((collection) => ({ kind: 'collection', collection, scope }));
      const rootItemNodes: BookmarkNode[] = items
        .filter((i) => i.collectionId === null)
        .sort((a, b) => a.order - b.order)
        .map((item) => ({ kind: 'item', item, scope }));
      return [...collectionNodes, ...rootItemNodes];
    }

    if (node.kind === 'collection') {
      return items
        .filter((i) => i.collectionId === node.collection.id)
        .sort((a, b) => a.order - b.order)
        .map((item) => ({ kind: 'item', item, scope }));
    }

    return [];
  }

  // getChildrenByRepo is added in Task 8.
  private async getChildrenByRepo(
    node: BookmarkNode | undefined,
    items: BookmarkItem[],
    collections: BookmarkCollection[]
  ): Promise<BookmarkNode[]> {
    if (!node) {
      const repos = new Map<string, string>();
      for (const item of items) {
        const entry = await this.cache.get(item.uri);
        const identity = repoIdentity(entry.repoName);
        repos.set(identity.key, identity.label);
      }
      return [...repos]
        .sort(([keyA, labelA], [keyB, labelB]) => {
          if (keyA === UNKNOWN_REPO_KEY) return 1;
          if (keyB === UNKNOWN_REPO_KEY) return -1;
          return labelA.localeCompare(labelB);
        })
        .map(([repoKey, label]) => ({ kind: 'repoGroup', label, repoKey }));
    }

    if (node.kind === 'repoGroup') {
      const itemsInRepo: BookmarkItem[] = [];
      for (const item of items) {
        const entry = await this.cache.get(item.uri);
        if (repoIdentity(entry.repoName).key === node.repoKey) {
          itemsInRepo.push(item);
        }
      }
      const collectionIdsInRepo = new Set(
        itemsInRepo.map((i) => i.collectionId).filter((id): id is string => id !== null)
      );
      const collectionNodes: BookmarkNode[] = collections
        .filter((c) => collectionIdsInRepo.has(c.id))
        .sort((a, b) => a.order - b.order)
        .map((collection) => ({
          kind: 'collection',
          collection,
          repoLabel: node.label,
          repoKey: node.repoKey,
          scope: 'workspace'
        }));
      const rootItemNodes: BookmarkNode[] = itemsInRepo
        .filter((i) => i.collectionId === null)
        .sort((a, b) => a.order - b.order)
        .map((item) => ({ kind: 'item', item, scope: 'workspace' }));
      return [...collectionNodes, ...rootItemNodes];
    }

    if (node.kind === 'collection') {
      const repoKey = node.repoKey ?? UNKNOWN_REPO_KEY;
      const candidates = items.filter((i) => i.collectionId === node.collection.id);
      const matched: BookmarkItem[] = [];
      for (const item of candidates) {
        const entry = await this.cache.get(item.uri);
        if (repoIdentity(entry.repoName).key === repoKey) {
          matched.push(item);
        }
      }
      return matched.sort((a, b) => a.order - b.order).map((item) => ({ kind: 'item', item, scope: 'workspace' }));
    }

    return [];
  }
}
