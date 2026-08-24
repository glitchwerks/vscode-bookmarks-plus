import * as vscode from 'vscode';
import { BookmarkStore, DuplicateBookmarkError } from './bookmarkStore';
import {
  BookmarkNode,
  BookmarksTreeDataProvider
} from './bookmarksTreeDataProvider';
import { isInsideWorkspace } from './workspaceFolders';

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

export interface ScopedStores {
  workspace: BookmarkStore;
  global: BookmarkStore;
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
  store: BookmarkStore,
  prompter: Pick<Prompter, 'showInfo'>,
  type: 'file' | 'folder',
  uri: vscode.Uri
): Promise<void> {
  try {
    await store.addItem({ type, uri: uri.toString() });
  } catch (error: unknown) {
    if (!(error instanceof DuplicateBookmarkError)) {
      throw error;
    }
    await prompter.showInfo('This item is already bookmarked.');
  }
}

export function createAddFileHandler(
  store: BookmarkStore,
  prompter: Pick<Prompter, 'showInfo'>
): (uri: vscode.Uri) => Promise<void> {
  return async (uri: vscode.Uri): Promise<void> => {
    await addBookmark(store, prompter, 'file', uri);
  };
}

export function createAddFolderHandler(
  store: BookmarkStore,
  prompter: Pick<Prompter, 'showInfo'>
): (uri: vscode.Uri) => Promise<void> {
  return async (uri: vscode.Uri): Promise<void> => {
    await addBookmark(store, prompter, 'folder', uri);
  };
}

export function createRemoveHandler(
  stores: ScopedStores
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'item') {
      return;
    }
    const store = stores[node.scope];
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
  store: BookmarkStore,
  prompter: Prompter
): () => Promise<void> {
  return async (): Promise<void> => {
    const name = await prompter.showInputBox({ prompt: 'New collection name' });
    if (!name) {
      return;
    }
    await store.addCollection(name);
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
    const store = stores[node.scope];
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
    if (node === undefined || node.kind === 'repoGroup' || node.kind === 'globalRoot') {
      return;
    }
    const store = stores[node.scope];
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
    const store = stores[node.scope];
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
    const store = stores[node.scope];
    const data = store.getAll();
    const options: Array<vscode.QuickPickItem & { id: string | null }> = [
      { label: 'Ungrouped', id: null },
      ...data.collections.map((collection) => ({
        label: collection.name,
        id: collection.id
      }))
    ];
    const pick = await prompter.showQuickPick(
      options,
      { placeHolder: 'Move bookmark to collection' }
    );
    if (pick === undefined) {
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
    if (start === 1) {
      const confirmed = await deps.prompter.showWarningConfirm(
        'Adding this folder will add a second root to the workspace. This disables the ' +
          '.vscode/bookmarks.json mirror for the workspace and may restart or reload the ' +
          'extension host.',
        'Add Folder'
      );
      if (!confirmed) {
        return;
      }
    }

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
    vscode.commands.registerCommand('bookmarks.reveal', createRevealHandler(revealDeps))
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
    vscode.commands.registerCommand('bookmarks.refresh', () => {
      provider.refresh();
    })
  );
}
