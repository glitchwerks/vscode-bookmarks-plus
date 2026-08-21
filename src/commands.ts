import * as vscode from 'vscode';
import { BookmarkStore, DuplicateBookmarkError } from './bookmarkStore';
import {
  BookmarkNode,
  BookmarksTreeDataProvider
} from './bookmarksTreeDataProvider';

export interface Prompter {
  showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: T[],
    options: vscode.QuickPickOptions
  ): Thenable<T | undefined>;
  showWarningConfirm(message: string, confirmLabel: string): Thenable<boolean>;
  showInfo(message: string): Thenable<unknown>;
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
    showInfo: (message) => vscode.window.showInformationMessage(message)
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
  store: BookmarkStore
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'item') {
      return;
    }
    await store.removeItem(node.item.id);
  };
}

export function createRevealHandler(
  reveal: (uri: vscode.Uri) => Thenable<unknown>
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'item') {
      return;
    }
    await reveal(vscode.Uri.parse(node.item.uri));
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
  store: BookmarkStore,
  prompter: Prompter
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'collection') {
      return;
    }
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
  store: BookmarkStore,
  prompter: Pick<Prompter, 'showInputBox'>
): (node?: BookmarkNode) => Promise<void> {
  return async (node?: BookmarkNode): Promise<void> => {
    if (node === undefined || node.kind === 'repoGroup' || node.kind === 'globalRoot') {
      return;
    }
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
  store: BookmarkStore,
  prompter: Prompter
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'collection') {
      return;
    }
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
  store: BookmarkStore,
  prompter: Prompter
): (node: BookmarkNode) => Promise<void> {
  return async (node: BookmarkNode): Promise<void> => {
    if (node.kind !== 'item') {
      return;
    }
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

export function registerAddCommands(
  context: vscode.ExtensionContext,
  store: BookmarkStore
): void {
  const prompter: Pick<Prompter, 'showInfo'> = {
    showInfo: (message) => vscode.window.showInformationMessage(message)
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bookmarks.addFile',
      createAddFileHandler(store, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.addFolder',
      createAddFolderHandler(store, prompter)
    )
  );
}

export function registerItemCommands(
  context: vscode.ExtensionContext,
  store: BookmarkStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('bookmarks.remove', createRemoveHandler(store)),
    vscode.commands.registerCommand(
      'bookmarks.reveal',
      createRevealHandler((uri) =>
        vscode.commands.executeCommand('revealInExplorer', uri)
      )
    )
  );
}

export function registerCollectionCommands(
  context: vscode.ExtensionContext,
  store: BookmarkStore
): void {
  const prompter = createPrompter();
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bookmarks.newCollection',
      createNewCollectionHandler(store, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.renameCollection',
      createRenameCollectionHandler(store, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.deleteCollection',
      createDeleteCollectionHandler(store, prompter)
    ),
    vscode.commands.registerCommand(
      'bookmarks.moveToCollection',
      createMoveToCollectionHandler(store, prompter)
    )
  );
}

export function registerDescriptionCommands(
  context: vscode.ExtensionContext,
  store: BookmarkStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'bookmarks.setDescription',
      createSetDescriptionHandler(store, createPrompter())
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
