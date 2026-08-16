import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { BookmarkNode, BookmarksTreeDataProvider } from '../../bookmarksTreeDataProvider';
import { FsGitCache } from '../../fsGitCache';
import { BookmarkItem } from '../../types';
import {
  createAddFileHandler,
  createAddFolderHandler,
  createRemoveHandler,
  createRevealHandler,
  Prompter,
  createNewCollectionHandler,
  createRenameCollectionHandler,
  createDeleteCollectionHandler,
  createMoveToCollectionHandler,
  createSetDescriptionHandler,
  registerViewCommands
} from '../../commands';
import { FakeMemento, FakePrompter } from './fixtures';

function makePrompter(overrides: Partial<Prompter> = {}): Prompter {
  return {
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showWarningConfirm: async () => false,
    showInfo: async () => {},
    ...overrides
  };
}

suite('commands - addFile / addFolder / remove / reveal', () => {
  test('addFile handler adds a root-level file bookmark for the given uri', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/a.txt');
    await createAddFileHandler(store, makePrompter())(uri);

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'file');
    assert.strictEqual(items[0].uri, uri.toString());
  });

  test('addFolder handler adds a root-level folder bookmark for the given uri', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/dir');
    await createAddFolderHandler(store, makePrompter())(uri);

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'folder');
  });

  test('addFile handler notifies exactly once for a duplicate and not for a normal add', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/a.txt');
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });
    const handler = createAddFileHandler(store, prompter);

    await handler(uri);
    assert.strictEqual(messages.length, 0);

    await handler(uri);

    assert.strictEqual(store.getAll().items.length, 1);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('addFolder handler notifies exactly once for a duplicate and not for a normal add', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/dir');
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });
    const handler = createAddFolderHandler(store, prompter);

    await handler(uri);
    assert.strictEqual(messages.length, 0);

    await handler(uri);

    assert.strictEqual(store.getAll().items.length, 1);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('remove handler deletes the targeted item and ignores non-item nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const handler = createRemoveHandler(store);

    const nonItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };
    await handler(nonItemNode);
    assert.strictEqual(store.getAll().items.length, 1, 'non-item nodes must be a no-op');

    await handler({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(store.getAll().items.length, 0);
  });

  test('reveal handler calls the injected reveal function with the item uri', async () => {
    const calls: string[] = [];
    const handler = createRevealHandler(async (uri) => { calls.push(uri.toString()); });
    const item: BookmarkItem = { id: '1', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 };

    await handler({ kind: 'item', item, scope: 'workspace' });
    assert.deepStrictEqual(calls, ['file:///a.txt']);
  });

  test('reveal handler works identically for folder items', async () => {
    const calls: string[] = [];
    const handler = createRevealHandler(async (uri) => { calls.push(uri.toString()); });
    const item: BookmarkItem = { id: '2', type: 'folder', uri: 'file:///dir', collectionId: null, order: 0 };

    await handler({ kind: 'item', item, scope: 'workspace' });
    assert.deepStrictEqual(calls, ['file:///dir']);
  });

  test('reveal handler is a no-op for non-item nodes', async () => {
    let called = false;
    const handler = createRevealHandler(async () => { called = true; });
    const nonItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };
    await handler(nonItemNode);
    assert.strictEqual(called, false);
  });
});

suite('commands - collections', () => {
  test('newCollection handler creates a collection with the prompted name', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = makePrompter({ showInputBox: async () => 'Work' });

    await createNewCollectionHandler(store, prompter)();

    const collections = store.getAll().collections;
    assert.strictEqual(collections.length, 1);
    assert.strictEqual(collections[0].name, 'Work');
  });

  test('newCollection handler does nothing when the prompt is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await createNewCollectionHandler(store, makePrompter())();
    assert.strictEqual(store.getAll().collections.length, 0);
  });

  test('renameCollection handler renames the targeted collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const prompter = makePrompter({ showInputBox: async () => 'Work Stuff' });

    await createRenameCollectionHandler(store, prompter)({ kind: 'collection', collection, scope: 'workspace' });

    assert.strictEqual(store.getAll().collections[0].name, 'Work Stuff');
  });

  test('renameCollection handler does nothing when the prompt is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');

    await createRenameCollectionHandler(store, makePrompter())({ kind: 'collection', collection, scope: 'workspace' });

    assert.strictEqual(store.getAll().collections[0].name, 'Work', 'cancelled prompt must not rename');
  });

  test('renameCollection handler ignores non-collection nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    let inputBoxCalled = false;
    const prompter = makePrompter({
      showInputBox: async () => {
        inputBoxCalled = true;
        return 'Whatever';
      }
    });

    await createRenameCollectionHandler(store, prompter)({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(store.getAll().collections.length, 0);
    assert.strictEqual(inputBoxCalled, false, 'must not prompt for a non-collection node');
  });

  test('deleteCollection handler does nothing when the confirmation is declined', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const declining = makePrompter({ showWarningConfirm: async () => false });

    await createDeleteCollectionHandler(store, declining)({ kind: 'collection', collection, scope: 'workspace' });

    assert.strictEqual(store.getAll().collections.length, 1, 'declined confirmation must not delete');
    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, collection.id);
  });

  test('deleteCollection handler deletes the collection and ungroups its items after confirmation', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const confirming = makePrompter({ showWarningConfirm: async () => true });

    await createDeleteCollectionHandler(store, confirming)({ kind: 'collection', collection, scope: 'workspace' });

    const data = store.getAll();
    assert.strictEqual(data.collections.length, 0);
    assert.strictEqual(
      data.items.find((i) => i.id === item.id)!.collectionId,
      null,
      'items must be ungrouped, not deleted'
    );
  });

  test('deleteCollection handler ignores non-collection nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    let warningConfirmCalled = false;
    const confirming = makePrompter({
      showWarningConfirm: async () => {
        warningConfirmCalled = true;
        return true;
      }
    });

    await createDeleteCollectionHandler(store, confirming)({ kind: 'item', item, scope: 'workspace' });

    assert.strictEqual(store.getAll().items.length, 1, 'non-collection nodes must be a no-op');
    assert.strictEqual(
      warningConfirmCalled,
      false,
      'must not confirm deletion for a non-collection node'
    );
  });

  test('moveToCollection handler moves the item into the chosen collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Work')
    });

    await createMoveToCollectionHandler(store, prompter)({ kind: 'item', item, scope: 'workspace' });

    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, collection.id);
  });

  test('moveToCollection handler reports a duplicate and leaves the item in its collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const uri = 'file:///a.txt';
    const item = await store.addItem({ type: 'file', uri });
    await store.addItem({ type: 'file', uri, collectionId: collection.id });
    const messages: string[] = [];
    const prompter = makePrompter({
      showQuickPick: async (items) =>
        items.find((quickPickItem) => quickPickItem.label === 'Work'),
      showInfo: async (message) => {
        messages.push(message);
      }
    });

    await createMoveToCollectionHandler(store, prompter)({ kind: 'item', item, scope: 'workspace' });

    assert.deepStrictEqual(messages, ['This item is already bookmarked.']);
    assert.strictEqual(
      store.getAll().items.find((storedItem) => storedItem.id === item.id)!.collectionId,
      null
    );
  });

  test('moveToCollection handler distinguishes collections with duplicate names by id', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addCollection('Work');
    const secondCollection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = makePrompter({
      showQuickPick: async (items) =>
        items.find(
          (quickPickItem) =>
            'id' in quickPickItem && quickPickItem.id === secondCollection.id
        )
    });

    await createMoveToCollectionHandler(store, prompter)({ kind: 'item', item, scope: 'workspace' });

    assert.strictEqual(
      store.getAll().items.find((storedItem) => storedItem.id === item.id)!.collectionId,
      secondCollection.id
    );
  });

  test('moveToCollection handler offers "Ungrouped" and moving to it clears collectionId', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const prompter = makePrompter({
      showQuickPick: async (items) =>
        items.find((quickPickItem) => quickPickItem.label === 'Ungrouped')
    });

    await createMoveToCollectionHandler(store, prompter)({ kind: 'item', item, scope: 'workspace' });

    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, null);
  });

  test('moveToCollection handler does nothing when the pick is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await createMoveToCollectionHandler(store, makePrompter())({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, null);
  });

  test('moveToCollection handler ignores non-item nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addCollection('Work');
    const nonItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };
    let quickPickCalled = false;
    const prompter = makePrompter({
      showQuickPick: async () => {
        quickPickCalled = true;
        return undefined;
      }
    });

    await createMoveToCollectionHandler(store, prompter)(nonItemNode);

    assert.strictEqual(quickPickCalled, false, 'must not prompt when there is no item to move');
  });
});

suite('commands - view (toggleGroupByRepo / refresh)', () => {
  test('toggleGroupByRepo flips between default and byRepo', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const cache = new FsGitCache(async () => ({ exists: true }));
    const provider = new BookmarksTreeDataProvider(store, cache);
    const subscriptions: vscode.Disposable[] = [];
    registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

    try {
      assert.strictEqual(provider.getGroupMode(), 'default');
      await vscode.commands.executeCommand('bookmarks.toggleGroupByRepo');
      assert.strictEqual(provider.getGroupMode(), 'byRepo');
      await vscode.commands.executeCommand('bookmarks.toggleGroupByRepo');
      assert.strictEqual(provider.getGroupMode(), 'default');
    } finally {
      subscriptions.forEach((d) => d.dispose());
    }
  });

  test('refresh invalidates the cache so the next render re-resolves', async () => {
    let resolveCalls = 0;
    const store = new BookmarkStore(new FakeMemento());
    const cache = new FsGitCache(async () => {
      resolveCalls++;
      return { exists: true };
    });
    const provider = new BookmarksTreeDataProvider(store, cache);
    const subscriptions: vscode.Disposable[] = [];
    registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

    try {
      const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
      await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
      assert.strictEqual(resolveCalls, 1);

      await vscode.commands.executeCommand('bookmarks.refresh');
      await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
      assert.strictEqual(resolveCalls, 2);
    } finally {
      subscriptions.forEach((d) => d.dispose());
    }
  });
});

suite('commands - setDescription', () => {
  function itemNode(item: BookmarkItem): BookmarkNode {
    return { kind: 'item', item, scope: 'workspace' };
  }

  test('is a no-op when invoked without a tree node', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = new FakePrompter({ inputBoxResult: 'unused' });

    await createSetDescriptionHandler(store, prompter)();

    assert.strictEqual(prompter.inputBoxCallCount, 0);
  });

  test('sets a description on an item', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = new FakePrompter({ inputBoxResult: 'the entrypoint' });

    await createSetDescriptionHandler(store, prompter)(itemNode(store.getAll().items[0]));

    assert.strictEqual(store.getAll().items[0].description, 'the entrypoint');
  });

  test('pre-fills the input box with the current description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: 'updated' });

    await createSetDescriptionHandler(store, prompter)(itemNode(store.getAll().items[0]));

    assert.strictEqual(prompter.lastInputBoxOptions?.value, 'existing');
  });

  test('submitting an empty input box clears the description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: '' });

    await createSetDescriptionHandler(store, prompter)(itemNode(store.getAll().items[0]));

    assert.strictEqual(store.getAll().items[0].description, undefined);
  });

  test('dismissing the input box leaves the description unchanged', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: undefined });

    await createSetDescriptionHandler(store, prompter)(itemNode(store.getAll().items[0]));

    assert.strictEqual(store.getAll().items[0].description, 'existing');
  });

  test('sets a description on a collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addCollection('Work');
    const prompter = new FakePrompter({ inputBoxResult: 'work-related bookmarks' });

    await createSetDescriptionHandler(store, prompter)({
      kind: 'collection',
      collection: store.getAll().collections[0],
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections[0].description, 'work-related bookmarks');
  });

  test('is a no-op on a repoGroup node', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = new FakePrompter({ inputBoxResult: 'nope' });

    await createSetDescriptionHandler(store, prompter)({ kind: 'repoGroup', label: 'repo-a', repoKey: 'repo:repo-a' });

    assert.strictEqual(prompter.inputBoxCallCount, 0, 'the input box must not even open for a repo group');
  });
});
