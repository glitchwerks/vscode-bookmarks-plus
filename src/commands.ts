import * as vscode from 'vscode';
import { decorationUriKey } from './bookmarkDecorationProvider';
import { BookmarkStore, DuplicateBookmarkError } from './bookmarkStore';
import {
  BookmarkNode,
  BookmarksTreeDataProvider
} from './bookmarksTreeDataProvider';
import { isInsideWorkspace } from './workspaceFolders';
import { RecoveryConflictError, WorkspaceBookmarkStore } from './workspaceBookmarkStore';
import { RecoveryFileSystem, RecoveryMode, WorkspaceOwnerRef, ownerKey } from './workspacePartitionTypes';
import { RootCandidate, canonicalizeRootUri, toRootCandidates } from './rootUri';

export interface Prompter {
  showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: T[],
    options: vscode.QuickPickOptions
  ): Thenable<T | undefined>;
  showWarningConfirm(message: string, confirmLabel: string): Thenable<boolean>;
  showInfo(message: string): Thenable<unknown>;
  showActionPrompt(message: string, actions: string[]): Thenable<string | undefined>;
}

/** User-visible labels for the out-of-workspace global folder reveal prompt (issue #93). */
export const ADD_TO_WORKSPACE_LABEL = 'Add to Workspace';
export const OPEN_IN_NEW_WINDOW_LABEL = 'Open in New Window';
export const REATTACH_ONLY_LABEL = 'Reattach only';
export const REATTACH_AND_SALVAGE_LABEL = 'Reattach and salvage';
export const RECOVER_CONFIRM_LABEL = 'Recover';

export interface RecoveryCommandDeps {
  readonly store: WorkspaceBookmarkStore;
  readonly prompter: Prompter;
  readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  readonly fs: RecoveryFileSystem;
}

/** Preview recovery without writes, and commit only the user's confirmed token. */
export function createRecoverPartitionHandler(deps: RecoveryCommandDeps): (node?: BookmarkNode) => Promise<void> {
  return async node => {
    if (node && node.kind !== 'detachedPartition') return;
    const { store, prompter } = deps;
    try {
      const detached = store.getView().detached;
      const selected = node?.kind === 'detachedPartition'
        ? detached.find(p => p.partitionId === node.partitionId)
        : detached.length === 1 ? detached[0]
          : detached.length === 0 ? undefined : await prompter.showQuickPick(
            detached.map(p => ({ ...p, label: p.lastKnownRootUri, description: `${p.data.items.length} bookmarks` })),
            { placeHolder: 'Select detached workspace partition' });
      if (!selected) {
        if (node || detached.length === 0) await prompter.showInfo('No detached workspace partition is available for recovery.');
        return;
      }
      await prompter.showInfo(`Recover ${selected.lastKnownRootUri}: ${selected.data.items.length} bookmarks.`);
      const folders = deps.getWorkspaceFolders() ?? [];
      if (folders.length === 0) {
        await prompter.showInfo('No current workspace root is available for recovery.');
        return;
      }
      const destination = await prompter.showQuickPick(
        toRootCandidates(folders).map(root => ({ ...root, description: root.uri.toString() })),
        { placeHolder: 'Select recovery destination root' });
      if (!destination) return;
      const mode = await prompter.showQuickPick<vscode.QuickPickItem & { mode: RecoveryMode }>([
        { label: REATTACH_ONLY_LABEL, mode: 'reattach-only' },
        { label: REATTACH_AND_SALVAGE_LABEL, mode: 'salvage' }
      ], { placeHolder: 'Select recovery mode' });
      if (!mode) return;
      const requireCurrentDestination = (): RootCandidate => {
        const identity = canonicalizeRootUri(destination.uri);
        const current = toRootCandidates(deps.getWorkspaceFolders()).filter(root => canonicalizeRootUri(root.uri) === identity);
        if (current.length !== 1) {
          throw new RecoveryConflictError('Recovery destination is not a current workspace root.');
        }
        return current[0];
      };
      const preview = await store.previewRecovery(selected.partitionId, requireCurrentDestination(), mode.mode, deps.fs);
      const summary = preview.mode === 'salvage'
        ? `${preview.resolving} recovered, ${preview.missing} still missing, ${preview.incompatible} incompatible`
        : `${selected.data.items.length} bookmarks unchanged`;
      const confirmed = await prompter.showWarningConfirm(
        `Recover ${selected.lastKnownRootUri} to ${preview.destinationRootUri}? ${summary}.`, RECOVER_CONFIRM_LABEL);
      if (!confirmed) return;
      requireCurrentDestination();
      await store.commitRecovery(preview.token);
    } catch (error: unknown) {
      if (!(error instanceof RecoveryConflictError)) throw error;
      await prompter.showInfo(error.message);
    }
  };
}

/** Registers recovery with dependencies supplied by partitioned activation. */
export function registerRecoveryCommand(context: vscode.ExtensionContext, deps: RecoveryCommandDeps): void {
  context.subscriptions.push(vscode.commands.registerCommand('bookmarks.recoverPartition', createRecoverPartitionHandler(deps)));
}

/** Legacy workspace support lasts only until activation is migrated in Task 9. */
export interface ScopedStores<W extends BookmarkStore | WorkspaceBookmarkStore = BookmarkStore | WorkspaceBookmarkStore> {
  workspace: W;
  global: BookmarkStore;
}

type CommandStore = BookmarkStore | WorkspaceBookmarkStore;
type ContentCommands = Pick<BookmarkStore, 'getAll' | 'removeItem' | 'renameCollection' |
  'setItemDescription' | 'setCollectionDescription' | 'deleteCollection' | 'moveItem'>;

/** Bind every workspace operation to the owner carried by its content node. */
function storeForNode(stores: ScopedStores, node: Extract<BookmarkNode, { kind: 'item' | 'collection' }>): ContentCommands | undefined {
  if (node.scope === 'global') return stores.global;
  const store = stores.workspace;
  if (!(store instanceof WorkspaceBookmarkStore)) return store;
  const owner = node.owner;
  if (!owner || !store.getOwnerData(owner)) return undefined;
  return {
    getAll: () => store.getOwnerData(owner)!,
    removeItem: id => store.removeItem(owner, id),
    renameCollection: (id, name) => store.renameCollection(owner, id, name),
    setItemDescription: (id, description) => store.setItemDescription(owner, id, description),
    setCollectionDescription: (id, description) => store.setCollectionDescription(owner, id, description),
    deleteCollection: id => store.deleteCollection(owner, id),
    moveItem: (id, collectionId, index) => store.moveItem(owner, id, collectionId, index)
  };
}

export function createPrompter(): Prompter {
  return {
    showInputBox: (options) => vscode.window.showInputBox(options),
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
    showWarningConfirm: async (message, confirmLabel) => {
      const result = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel
      );
      return result === confirmLabel;
    },
    showInfo: (message) => vscode.window.showInformationMessage(message),
    showActionPrompt: (message, actions) =>
      vscode.window.showInformationMessage(message, ...actions)
  };
}

async function addBookmark(
  store: CommandStore,
  prompter: Pick<Prompter, 'showInfo'>,
  type: 'file' | 'folder',
  uri: vscode.Uri
): Promise<void> {
  try {
    if (store instanceof WorkspaceBookmarkStore) {
      const owner = store.resolveAttachedOwner(uri);
      if (!owner) {
        await prompter.showInfo('No attached workspace root owns this item.');
        return;
      }
      await store.addItem(owner, { type, uri: uri.toString() });
    } else {
      await store.addItem({ type, uri: uri.toString() });
    }
  } catch (error: unknown) {
    if (!(error instanceof DuplicateBookmarkError)) {
      throw error;
    }
    await prompter.showInfo('This item is already bookmarked.');
  }
}

export function createAddFileHandler(
  store: CommandStore,
  prompter: Pick<Prompter, 'showInfo'>
): (uri: vscode.Uri) => Promise<void> {
  return async (uri: vscode.Uri): Promise<void> => {
    await addBookmark(store, prompter, 'file', uri);
  };
}

export function createAddFolderHandler(
  store: CommandStore,
  prompter: Pick<Prompter, 'showInfo'>
): (uri: vscode.Uri) => Promise<void> {
  return async (uri: vscode.Uri): Promise<void> => {
    await addBookmark(store, prompter, 'folder', uri);
  };
}

/**
 * Promotes a suggested item (issue #95, T6) into a real workspace-scoped file bookmark, routed
 * through the same `addBookmark` helper every other add path uses so `DuplicateBookmarkError`
 * produces the identical "already bookmarked" info toast. A recent item has no scope of its own,
 * so this targets a single (workspace) store, mirroring `createAddFileHandler`'s shape rather than
 * a `ScopedStores` bag.
 */
export function createPromoteSuggestionHandler(
  store: CommandStore,
  prompter: Pick<Prompter, 'showInfo'>
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'suggestion') {
      return;
    }
    await addBookmark(store, prompter, 'file', vscode.Uri.parse(node.recentItem.uri));
  };
}

/**
 * Promotes a recent-item leaf (issue #108) into a real workspace-scoped file bookmark. Mirrors
 * `createPromoteSuggestionHandler` exactly — same `addBookmark` routing, same workspace-only scope
 * (a `recentItem` node has no scope of its own, just like a `suggestion` node) — but keys off
 * `kind === 'recentItem'` rather than `kind === 'suggestion'`, so a suggestion node (or any other
 * node kind) is correctly ignored by this handler.
 */
export function createPromoteRecentItemHandler(
  store: CommandStore,
  prompter: Pick<Prompter, 'showInfo'>
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'recentItem') {
      return;
    }
    await addBookmark(store, prompter, 'file', vscode.Uri.parse(node.uri));
  };
}

/**
 * Removes the bookmark matching `uri` (issue #114: Explorer/editor-title context menu invokes
 * `bookmarks.remove` with the right-clicked resource's `Uri`, which carries no explicit scope).
 * Prompts for an owner when multiple workspace owners match. Global is consulted only when no
 * workspace match exists; canceling an owner selection must never remove the Global copy.
 */
async function removeByResourceUri(stores: ScopedStores, uri: vscode.Uri, prompter: Pick<Prompter, 'showQuickPick'>): Promise<void> {
  if (stores.workspace instanceof WorkspaceBookmarkStore) {
    const matches = stores.workspace.findItemsByUri(uri);
    const owners = [...new Map(matches.map(match => [ownerKey(match.owner), match.owner])).values()];
    if (owners.length > 0) {
      const view = stores.workspace.getView();
      const options = owners.map(owner => {
        const attached = owner.kind === 'partition' ? view.attached.find(p => p.partitionId === owner.partitionId) : undefined;
        const detached = owner.kind === 'partition' ? view.detached.find(p => p.partitionId === owner.partitionId) : undefined;
        return { owner, label: attached?.label ?? detached?.lastKnownRootUri ?? 'Unassigned',
          description: attached?.rootUri ?? (detached ? `Detached: ${detached.lastKnownRootUri}` : 'Unassigned workspace bookmarks') };
      });
      const pick = options.length === 1 ? options[0] : await prompter.showQuickPick(options, { placeHolder: 'Select bookmark owner to remove from' });
      if (!pick) return;
      const match = matches.find(entry => ownerKey(entry.owner) === ownerKey(pick.owner));
      if (match) await stores.workspace.removeItem(match.owner, match.item.id);
      return;
    }
  }
  const targetKey = decorationUriKey(uri);
  const legacyStores = stores.workspace instanceof WorkspaceBookmarkStore
    ? [stores.global] : [stores.workspace, stores.global];
  for (const store of legacyStores) {
    const match = store.getAll().items.find((item) => {
      try {
        return decorationUriKey(vscode.Uri.parse(item.uri, true)) === targetKey;
      } catch {
        return false;
      }
    });
    if (match) {
      await store.removeItem(match.id);
      return;
    }
  }
}

export function createRemoveHandler(
  stores: ScopedStores,
  prompter: Pick<Prompter, 'showQuickPick'> = createPrompter()
): (node: BookmarkNode | vscode.Uri) => Promise<void> {
  return async (node: BookmarkNode | vscode.Uri): Promise<void> => {
    if (node instanceof vscode.Uri) {
      await removeByResourceUri(stores, node, prompter);
      return;
    }
    if (node.kind !== 'item') {
      return;
    }
    const store = storeForNode(stores, node);
    if (!store) return;
    await store.removeItem(node.item.id);
  };
}

export interface RevealDeps {
  reveal: (uri: vscode.Uri) => Thenable<unknown>;
  prompter: Pick<Prompter, 'showActionPrompt'>;
  getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  addToWorkspace: (node: BookmarkNode) => Thenable<unknown>;
  openInNewWindow: (uri: vscode.Uri) => Thenable<unknown>;
}

/**
 * Reveals a bookmarked item in the explorer, except for an "addable" global folder bookmark
 * (global scope, folder type, not already inside the current workspace) — `revealInExplorer` has
 * nothing to reveal for a folder that isn't part of any open workspace folder, so instead this
 * offers a two-action prompt to add it to the workspace or open it in a new window. Issue #93.
 */
export function createRevealHandler(
  deps: RevealDeps
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'item') {
      return;
    }
    const uri = vscode.Uri.parse(node.item.uri);
    const isAddableGlobalFolder =
      node.scope === 'global' &&
      node.item.type === 'folder' &&
      !isInsideWorkspace(uri, deps.getWorkspaceFolders());

    if (!isAddableGlobalFolder) {
      await deps.reveal(uri);
      return;
    }

    const choice = await deps.prompter.showActionPrompt(
      'This folder is not part of the open workspace. Add it to the workspace, or open it in ' +
        'a new window.',
      [ADD_TO_WORKSPACE_LABEL, OPEN_IN_NEW_WINDOW_LABEL]
    );
    if (choice === ADD_TO_WORKSPACE_LABEL) {
      await deps.addToWorkspace(node);
    } else if (choice === OPEN_IN_NEW_WINDOW_LABEL) {
      await deps.openInNewWindow(uri);
    }
  };
}

export function createNewCollectionHandler(
  store: CommandStore,
  prompter: Prompter
): (node?: BookmarkNode) => Promise<void> {
  return async (node?: BookmarkNode): Promise<void> => {
    let owner: WorkspaceOwnerRef | undefined;
    if (store instanceof WorkspaceBookmarkStore) {
      const roots = store.getView().attached;
      const contextOwner = node?.kind === 'workspaceRoot' ? { kind: 'partition' as const, partitionId: node.partitionId }
        : node && 'owner' in node ? node.owner : undefined;
      if (node && (!contextOwner || contextOwner.kind !== 'partition'
        || !roots.some(root => root.partitionId === contextOwner.partitionId))) {
        await prompter.showInfo('New collections require an attached workspace root.');
        return;
      }
      if (roots.length === 0) {
        await prompter.showInfo('New collections require an attached workspace root.');
        return;
      }
      const selected = contextOwner?.kind === 'partition' ? roots.find(root => root.partitionId === contextOwner.partitionId)
        : roots.length === 1 ? roots[0] : await prompter.showQuickPick(
          roots.map(root => ({ label: root.label, description: root.rootUri, partitionId: root.partitionId })),
          { placeHolder: 'Select workspace root for the collection' });
      if (!selected) return;
      owner = { kind: 'partition', partitionId: selected.partitionId };
    }
    const name = await prompter.showInputBox({ prompt: 'New collection name' });
    if (!name) {
      return;
    }
    if (store instanceof WorkspaceBookmarkStore) {
      if (owner?.kind !== 'partition' || !store.getView().attached.some(root => root.partitionId === owner.partitionId)) {
        await prompter.showInfo('New collections require an attached workspace root.');
        return;
      }
      await store.addCollection(owner, name);
    } else await store.addCollection(name);
  };
}

export function createRenameCollectionHandler(
  stores: ScopedStores,
  prompter: Prompter
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'collection') {
      return;
    }
    const store = storeForNode(stores, node);
    if (!store) return;
    const name = await prompter.showInputBox({
      prompt: 'Rename collection',
      value: node.collection.name
    });
    if (!name) {
      return;
    }
    await store.renameCollection(node.collection.id, name);
  };
}

export function createSetDescriptionHandler(
  stores: ScopedStores,
  prompter: Pick<Prompter, 'showInputBox'>
): (node?: BookmarkNode) => Promise<void> {
  return async (node?: BookmarkNode): Promise<void> => {
    if (!node || (node.kind !== 'item' && node.kind !== 'collection')) {
      return;
    }
    const store = storeForNode(stores, node);
    if (!store) return;
    const current = node.kind === 'item'
      ? node.item.description
      : node.collection.description;
    const next = await prompter.showInputBox({
      prompt: 'Description (submit an empty value to clear it)',
      value: current ?? ''
    });
    if (next === undefined) {
      return;
    }
    if (node.kind === 'item') {
      await store.setItemDescription(node.item.id, next);
      return;
    }
    await store.setCollectionDescription(node.collection.id, next);
  };
}

export function createDeleteCollectionHandler(
  stores: ScopedStores,
  prompter: Prompter
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'collection') {
      return;
    }
    const store = storeForNode(stores, node);
    if (!store) return;
    const confirmed = await prompter.showWarningConfirm(
      `Delete collection "${node.collection.name}"? Its bookmarks will be ungrouped, not deleted.`,
      'Delete'
    );
    if (!confirmed) {
      return;
    }
    await store.deleteCollection(node.collection.id);
  };
}

export function createMoveToCollectionHandler(
  stores: ScopedStores,
  prompter: Prompter
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'item') {
      return;
    }
    const store = storeForNode(stores, node);
    if (!store) return;
    const data = store.getAll();
    const options: Array<vscode.QuickPickItem & { id: string | null; owner?: WorkspaceOwnerRef }> = [
      { label: 'Ungrouped', id: null, owner: node.owner },
      ...data.collections.map((collection) => ({
        label: collection.name,
        id: collection.id,
        owner: node.owner
      }))
    ];
    const pick = await prompter.showQuickPick(
      options,
      { placeHolder: 'Move bookmark to collection' }
    );
    if (pick === undefined) {
      return;
    }
    if (node.scope === 'workspace' && stores.workspace instanceof WorkspaceBookmarkStore
      && ((pick.owner && ownerKey(pick.owner) !== ownerKey(node.owner!))
        || (pick.id !== null && !data.collections.some(collection => collection.id === pick.id)))) {
      await prompter.showInfo('Bookmarks cannot be moved between workspace roots.');
      return;
    }
    const siblingCount = data.items.filter(
      (item) => item.collectionId === pick.id
    ).length;
    try {
      await store.moveItem(node.item.id, pick.id, siblingCount);
    } catch (error: unknown) {
      if (!(error instanceof DuplicateBookmarkError)) {
        throw error;
      }
      await prompter.showInfo('This item is already bookmarked.');
    }
  };
}

export interface AddToWorkspaceDeps {
  prompter: Pick<Prompter, 'showWarningConfirm' | 'showInfo'>;
  getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  updateWorkspaceFolders: (
    start: number,
    deleteCount: number | undefined | null,
    ...foldersToAdd: { uri: vscode.Uri; name?: string }[]
  ) => boolean;
  flushMirrorWrites: () => Promise<void>;
}

/**
 * Promotes an addable global folder bookmark (already-filtered by contextValue in the tree, see
 * `bookmarksTreeDataProvider.ts:201`, T9) into the current workspace via
 * `vscode.workspace.updateWorkspaceFolders`. Contract pinned in
 * docs/superpowers/specs/2026-07-22-vscode-bookmarks-plus-design.md §5, issue #56.
 */
export function createAddToWorkspaceHandler(
  deps: AddToWorkspaceDeps
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'item' || node.scope !== 'global' || node.item.type !== 'folder') {
      return;
    }
    const uri = vscode.Uri.parse(node.item.uri);
    const folders = deps.getWorkspaceFolders();
    if (isInsideWorkspace(uri, folders)) {
      return;
    }

    const start = folders?.length ?? 0;
    await deps.flushMirrorWrites();
    const succeeded = deps.updateWorkspaceFolders(start, null, { uri });
    if (!succeeded) {
      await deps.prompter.showInfo('Could not add the folder to the workspace.');
    }
  };
}

export function registerAddCommands(
  context: vscode.ExtensionContext,
  stores: ScopedStores
): void {
  const prompter: Pick<Prompter, 'showInfo'> = {
    showInfo: (message) => vscode.window.showInformationMessage(message)
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bookmarks.addFile',
      createAddFileHandler(stores.workspace, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.addFolder',
      createAddFolderHandler(stores.workspace, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.addFileGlobal',
      createAddFileHandler(stores.global, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.addFolderGlobal',
      createAddFolderHandler(stores.global, prompter)
    )
  );
}

export function registerAddToWorkspaceCommand(
  context: vscode.ExtensionContext,
  workspaceStore: BookmarkStore
): void {
  const deps: AddToWorkspaceDeps = {
    prompter: createPrompter(),
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
    updateWorkspaceFolders: (start, deleteCount, ...foldersToAdd) =>
      vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...foldersToAdd),
    flushMirrorWrites: () => workspaceStore.flushMirrorWrites()
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bookmarks.addToWorkspace',
      createAddToWorkspaceHandler(deps)
    )
  );
}

export function registerItemCommands(
  context: vscode.ExtensionContext,
  stores: ScopedStores
): void {
  const revealDeps: RevealDeps = {
    reveal: (uri) => vscode.commands.executeCommand('revealInExplorer', uri),
    prompter: createPrompter(),
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
    addToWorkspace: (node) => vscode.commands.executeCommand('bookmarks.addToWorkspace', node),
    openInNewWindow: (uri) =>
      vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true })
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('bookmarks.remove', createRemoveHandler(stores)),
    vscode.commands.registerCommand('bookmarks.reveal', createRevealHandler(revealDeps)),
    vscode.commands.registerCommand(
      'bookmarks.promoteSuggestion',
      createPromoteSuggestionHandler(stores.workspace, createPrompter())
    ),
    vscode.commands.registerCommand(
      'bookmarks.promoteRecentItem',
      createPromoteRecentItemHandler(stores.workspace, createPrompter())
    )
  );
}

export function registerCollectionCommands(
  context: vscode.ExtensionContext,
  stores: ScopedStores
): void {
  const prompter = createPrompter();
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bookmarks.newCollection',
      createNewCollectionHandler(stores.workspace, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.newGlobalCollection',
      createNewCollectionHandler(stores.global, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.renameCollection',
      createRenameCollectionHandler(stores, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.deleteCollection',
      createDeleteCollectionHandler(stores, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.moveToCollection',
      createMoveToCollectionHandler(stores, prompter)
    )
  );
}

export function registerDescriptionCommands(
  context: vscode.ExtensionContext,
  stores: ScopedStores
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bookmarks.setDescription',
      createSetDescriptionHandler(stores, createPrompter())
    )
  );
}

export function registerViewCommands(
  context: vscode.ExtensionContext,
  provider: BookmarksTreeDataProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('bookmarks.toggleGroupByRepo', () => {
      provider.setGroupMode(
        provider.getGroupMode() === 'default' ? 'byRepo' : 'default'
      );
    }),
    vscode.commands.registerCommand('bookmarks.toggleShowFullPath', () => {
      provider.setShowFullPath(!provider.getShowFullPath());
    }),
    vscode.commands.registerCommand('bookmarks.refresh', () => {
      provider.refresh();
    })
  );
}
