import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { BookmarkNode, BookmarksTreeDataProvider } from '../../bookmarksTreeDataProvider';
import { FsGitCache } from '../../fsGitCache';
import { BookmarkCollection, BookmarkItem } from '../../types';
import { isInsideWorkspace } from '../../workspaceFolders';
import {
  ADD_TO_WORKSPACE_LABEL,
  AddToWorkspaceDeps,
  createAddFileHandler,
  createAddFolderHandler,
  createAddToWorkspaceHandler,
  createPromoteRecentItemHandler,
  createPromoteSuggestionHandler,
  createRemoveHandler,
  createRevealHandler,
  OPEN_IN_NEW_WINDOW_LABEL,
  Prompter,
  RevealDeps,
  ScopedStores,
  createNewCollectionHandler,
  createRenameCollectionHandler,
  createDeleteCollectionHandler,
  createMoveToCollectionHandler,
  createSetDescriptionHandler,
  registerViewCommands,
  registerAddCommands
} from '../../commands';
import { FakeMemento, FakePrompter } from './fixtures';

function makePrompter(overrides: Partial<Prompter> = {}): Prompter {
  return {
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showWarningConfirm: async () => false,
    showInfo: async () => {},
    showActionPrompt: async () => undefined,
    ...overrides
  };
}

/**
 * Builds a ScopedStores fixture (T4 / #55 D2 option A: `stores[node.scope]`). Any store not
 * supplied gets a fresh, empty BookmarkStore backed by its own FakeMemento — never shared with
 * the other scope, so "the other store is untouched" assertions are meaningful.
 */
function makeScopedStores(overrides: Partial<ScopedStores> = {}): ScopedStores {
  return {
    workspace: overrides.workspace ?? new BookmarkStore(new FakeMemento()),
    global: overrides.global ?? new BookmarkStore(new FakeMemento())
  };
}

interface StoreSnapshot {
  data: ReturnType<BookmarkStore['getAll']>;
  updateCallCount: number;
}

function snapshotStore(store: BookmarkStore, memento: FakeMemento): StoreSnapshot {
  // Deep-copy via JSON round-trip (BookmarkData is plain primitives/arrays) so this snapshot is
  // immune to `getAll()` returning the store's live internal object by reference — otherwise a
  // later `assertUntouched` deep-equal would tautologically compare the mutated object to itself.
  return {
    data: JSON.parse(JSON.stringify(store.getAll())) as ReturnType<BookmarkStore['getAll']>,
    updateCallCount: memento.updateCallCount
  };
}

/**
 * Asserts a store was not mutated by the handler under test: both its content (deep-equal
 * snapshot) and the fact that no write was even attempted (Memento.update call count unchanged).
 */
function assertUntouched(
  store: BookmarkStore,
  memento: FakeMemento,
  before: StoreSnapshot,
  label: string
): void {
  assert.deepStrictEqual(store.getAll(), before.data, `the ${label} store must be untouched`);
  assert.strictEqual(
    memento.updateCallCount,
    before.updateCallCount,
    `the ${label} store must not even attempt a write`
  );
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
    const stores = makeScopedStores();
    const item = await stores.workspace.addItem({ type: 'file', uri: 'file:///a.txt' });
    const handler = createRemoveHandler(stores);

    const nonItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };
    await handler(nonItemNode);
    assert.strictEqual(stores.workspace.getAll().items.length, 1, 'non-item nodes must be a no-op');

    await handler({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(stores.workspace.getAll().items.length, 0);
  });

  test('remove handler on a workspace-scoped node removes only from the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    const globalBefore = snapshotStore(global, globalMemento);
    const handler = createRemoveHandler(makeScopedStores({ workspace, global }));

    await handler({ kind: 'item', item: workspaceItem, scope: 'workspace' });

    assert.strictEqual(workspace.getAll().items.length, 0, 'the workspace item must be removed');
    assertUntouched(global, globalMemento, globalBefore, 'global');
    assert.strictEqual(global.getAll().items.find((i) => i.id === globalItem.id)?.id, globalItem.id);
  });

  test('remove handler on a global-scoped node removes only from the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const handler = createRemoveHandler(makeScopedStores({ workspace, global }));

    await handler({ kind: 'item', item: globalItem, scope: 'global' });

    assert.strictEqual(global.getAll().items.length, 0, 'the global item must be removed');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
    assert.strictEqual(workspace.getAll().items.find((i) => i.id === workspaceItem.id)?.id, workspaceItem.id);
  });

  // `createRevealHandler`'s tests (both its pre-existing plain-reveal branches and the new
  // addable-global-folder action-prompt branches, #93) live in their own
  // `commands - reveal (out-of-workspace global folder prompt, #93)` suite below, once its
  // `RevealDeps` fixtures (`folder()`, `folderItem()`) are in scope — see that suite for the full
  // reveal coverage, including the file/non-item/in-workspace no-prompt cases that used to live
  // here.
});

// T4 (#55 D2) scope-routing note: `createAddFileHandler` / `createAddFolderHandler` take a
// vscode.Uri, not a BookmarkNode, so there is no `node.scope` to route on — they stay bound to a
// single store here, and #55's global-add commands (bookmarks.addFileGlobal /
// bookmarks.addFolderGlobal) are separately-registered handlers over the global store (plan T5),
// not a scope-routed variant of these. `createRevealHandler` takes a node but never touches a
// store at all, so it is scope-irrelevant.

// T5 (#55) registerAddCommands wiring: registers four commands over a ScopedStores — the two
// existing workspace-bound commands (regression-checked here so the ScopedStores signature change
// cannot silently flip their routing) plus two new global-bound commands.
//
// `registerAddCommands` registers all four command ids ('bookmarks.addFile', '.addFolder',
// '.addFileGlobal', '.addFolderGlobal') on every call, and the real extension's own `activate()`
// registers those same four ids for real via the exact same `registerAddCommands` call, triggered
// by `onStartupFinished` (implied by package.json's `activationEvents: []`) at a non-deterministic
// point in the mocha run — independent of which test is currently executing. Each test here used to
// call `registerAddCommands` directly against the real `vscode.commands` registry, so if real
// activation happened to land between two of these tests (after one test's `dispose()` calls freed
// the ids, before the next test's `registerAddCommands` call re-registered them), the next
// `registerCommand` call would throw `command '...' already exists` — and since real activation is
// never disposed mid-process, every later `registerAddCommands` call in the whole run would then
// fail permanently too. This reproduced in CI (PR #75, commit 65cac1d): the `addFolder`-workspace
// test failed with `command 'bookmarks.addFile' already exists` after the two preceding tests in
// this same suite passed — i.e. activation landed mid-suite. Confirmed by instrumenting an
// artificial delay into this suite locally: shifting the wall-clock offset reproducibly moved the
// same class of real-activation collision (there, "Trying to add a disposable to a DisposableStore
// that has already been disposed of") into a different suite, proving activation genuinely fires
// asynchronously mid-run and collides with any suite that owns the real command/store lifecycle
// without isolating it. This is the same race the `commands - view` suite below already isolates
// itself from via `withIsolatedCommandRegistry` — applying the identical fix here.
suite('commands - registerAddCommands (workspace + global)', () => {
  test('bookmarks.addFileGlobal adds a bookmark to the global store; workspace store is untouched', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const workspaceBefore = snapshotStore(workspace, workspaceMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/global/a.txt');
        await vscode.commands.executeCommand('bookmarks.addFileGlobal', uri);

        const globalItems = global.getAll().items;
        assert.strictEqual(globalItems.length, 1);
        assert.strictEqual(globalItems[0].type, 'file');
        assert.strictEqual(globalItems[0].uri, uri.toString());
        assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('bookmarks.addFolderGlobal adds a bookmark to the global store; workspace store is untouched', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const workspaceBefore = snapshotStore(workspace, workspaceMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/global/dir');
        await vscode.commands.executeCommand('bookmarks.addFolderGlobal', uri);

        const globalItems = global.getAll().items;
        assert.strictEqual(globalItems.length, 1);
        assert.strictEqual(globalItems[0].type, 'folder');
        assert.strictEqual(globalItems[0].uri, uri.toString());
        assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('bookmarks.addFile still adds only to the workspace store after the ScopedStores signature change', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const globalBefore = snapshotStore(global, globalMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/workspace/a.txt');
        await vscode.commands.executeCommand('bookmarks.addFile', uri);

        const workspaceItems = workspace.getAll().items;
        assert.strictEqual(workspaceItems.length, 1);
        assert.strictEqual(workspaceItems[0].type, 'file');
        assert.strictEqual(workspaceItems[0].uri, uri.toString());
        assertUntouched(global, globalMemento, globalBefore, 'global');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('bookmarks.addFolder still adds only to the workspace store after the ScopedStores signature change', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const globalBefore = snapshotStore(global, globalMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/workspace/dir');
        await vscode.commands.executeCommand('bookmarks.addFolder', uri);

        const workspaceItems = workspace.getAll().items;
        assert.strictEqual(workspaceItems.length, 1);
        assert.strictEqual(workspaceItems[0].type, 'folder');
        assert.strictEqual(workspaceItems[0].uri, uri.toString());
        assertUntouched(global, globalMemento, globalBefore, 'global');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
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

  // T4 (#55 D2) scope-routing note: `bookmarks.newCollection` is pinned to the workspace store
  // per plan T5 ("global collections are created from the Global row's own inline button") —
  // `createNewCollectionHandler` takes no node, so there is no `node.scope` to route on, and it
  // is not part of the ScopedStores contract.

  test('createNewCollectionHandler bound to the global store creates a collection in the global store only, workspace store untouched', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = makePrompter({ showInputBox: async () => 'My Global Collection' });

    await createNewCollectionHandler(global, prompter)();

    const globalCollections = global.getAll().collections;
    assert.strictEqual(globalCollections.length, 1);
    assert.strictEqual(globalCollections[0].name, 'My Global Collection');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('renameCollection handler renames the targeted collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const prompter = makePrompter({ showInputBox: async () => 'Work Stuff' });

    await createRenameCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections[0].name, 'Work Stuff');
  });

  test('renameCollection handler does nothing when the prompt is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');

    await createRenameCollectionHandler(makeScopedStores({ workspace: store }), makePrompter())({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

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

    await createRenameCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });
    assert.strictEqual(store.getAll().collections.length, 0);
    assert.strictEqual(inputBoxCalled, false, 'must not prompt for a non-collection node');
  });

  test('renameCollection handler on a workspace-scoped node renames only in the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Work');
    await global.addCollection('Work'); // deliberately colliding name, distinct store
    const globalBefore = snapshotStore(global, globalMemento);
    const prompter = makePrompter({ showInputBox: async () => 'Work Stuff' });

    await createRenameCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'collection',
      collection: workspaceCollection,
      scope: 'workspace'
    });

    assert.strictEqual(workspace.getAll().collections[0].name, 'Work Stuff');
    assertUntouched(global, globalMemento, globalBefore, 'global');
  });

  test('renameCollection handler on a global-scoped node renames only in the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    await workspace.addCollection('Work'); // deliberately colliding name, distinct store
    const globalCollection = await global.addCollection('Work');
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = makePrompter({ showInputBox: async () => 'Personal' });

    await createRenameCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'collection',
      collection: globalCollection,
      scope: 'global'
    });

    assert.strictEqual(global.getAll().collections[0].name, 'Personal');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('deleteCollection handler does nothing when the confirmation is declined', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const declining = makePrompter({ showWarningConfirm: async () => false });

    await createDeleteCollectionHandler(makeScopedStores({ workspace: store }), declining)({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections.length, 1, 'declined confirmation must not delete');
    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, collection.id);
  });

  test('deleteCollection handler deletes the collection and ungroups its items after confirmation', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const confirming = makePrompter({ showWarningConfirm: async () => true });

    await createDeleteCollectionHandler(makeScopedStores({ workspace: store }), confirming)({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

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

    await createDeleteCollectionHandler(makeScopedStores({ workspace: store }), confirming)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().items.length, 1, 'non-collection nodes must be a no-op');
    assert.strictEqual(
      warningConfirmCalled,
      false,
      'must not confirm deletion for a non-collection node'
    );
  });

  test('deleteCollection handler on a global-scoped node deletes only in the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Notes'); // untouched control
    const globalCollection = await global.addCollection('Notes');
    const globalItem = await global.addItem({
      type: 'file',
      uri: 'file:///global-note.txt',
      collectionId: globalCollection.id
    });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const confirming = makePrompter({ showWarningConfirm: async () => true });

    await createDeleteCollectionHandler(makeScopedStores({ workspace, global }), confirming)({
      kind: 'collection',
      collection: globalCollection,
      scope: 'global'
    });

    const globalData = global.getAll();
    assert.strictEqual(globalData.collections.length, 0, 'the global collection must be deleted');
    assert.strictEqual(
      globalData.items.find((i) => i.id === globalItem.id)!.collectionId,
      null,
      'the global item must be ungrouped, not deleted'
    );
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
    assert.strictEqual(workspace.getAll().collections[0].id, workspaceCollection.id);
  });

  test(
    'deleteCollection handler on a global collection ungroups only the global item, leaving a ' +
      'workspace item at the same uri and its own collection untouched',
    async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      // Same uri and collection name in both scopes (D6: same URI is allowed once per scope) —
      // this must not fool the handler into ungrouping across scopes.
      const uri = 'file:///shared.txt';
      const workspaceCollection = await workspace.addCollection('Shared Name');
      const workspaceItem = await workspace.addItem({ type: 'file', uri, collectionId: workspaceCollection.id });
      const globalCollection = await global.addCollection('Shared Name');
      const globalItem = await global.addItem({ type: 'file', uri, collectionId: globalCollection.id });
      const workspaceBefore = snapshotStore(workspace, workspaceMemento);
      const confirming = makePrompter({ showWarningConfirm: async () => true });

      await createDeleteCollectionHandler(makeScopedStores({ workspace, global }), confirming)({
        kind: 'collection',
        collection: globalCollection,
        scope: 'global'
      });

      const globalData = global.getAll();
      assert.strictEqual(globalData.collections.length, 0);
      assert.strictEqual(
        globalData.items.find((i) => i.id === globalItem.id)!.collectionId,
        null,
        'the global item sharing a uri with a workspace item must be ungrouped'
      );
      assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
      assert.strictEqual(
        workspace.getAll().items.find((i) => i.id === workspaceItem.id)!.collectionId,
        workspaceCollection.id,
        'the workspace item and its collection must be unaffected by deleting the same-named, ' +
          'same-uri global collection'
      );
    }
  );

  test('moveToCollection handler moves the item into the chosen collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Work')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

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

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

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

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

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

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, null);
  });

  test('moveToCollection handler does nothing when the pick is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), makePrompter())({
      kind: 'item',
      item,
      scope: 'workspace'
    });
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

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)(nonItemNode);

    assert.strictEqual(quickPickCalled, false, 'must not prompt when there is no item to move');
  });

  test('moveToCollection handler offers only global collections (and Ungrouped) for a global-scoped node', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    // Deliberately colliding label so a label-based assertion could pass vacuously; the id set
    // is the only thing that actually proves scope isolation.
    await workspace.addCollection('Shared Name');
    const globalCollectionA = await global.addCollection('Shared Name');
    const globalCollectionB = await global.addCollection('Other Global');
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    let offeredIds: Array<string | null> = [];
    const prompter = makePrompter({
      showQuickPick: async (items) => {
        offeredIds = (items as unknown as Array<{ id: string | null }>).map((item) => item.id);
        return undefined;
      }
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItem,
      scope: 'global'
    });

    assert.deepStrictEqual(
      [...offeredIds].sort(),
      [null, globalCollectionA.id, globalCollectionB.id].sort(),
      'a global node picker must offer exactly the global collections plus Ungrouped, never workspace collections'
    );
  });

  test('moveToCollection handler offers only workspace collections (and Ungrouped) for a workspace-scoped node', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Shared Name');
    await global.addCollection('Shared Name'); // deliberately colliding label, distinct store
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    let offeredIds: Array<string | null> = [];
    const prompter = makePrompter({
      showQuickPick: async (items) => {
        offeredIds = (items as unknown as Array<{ id: string | null }>).map((item) => item.id);
        return undefined;
      }
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: workspaceItem,
      scope: 'workspace'
    });

    assert.deepStrictEqual(
      [...offeredIds].sort(),
      [null, workspaceCollection.id].sort(),
      'a workspace node picker must offer exactly the workspace collections plus Ungrouped, never global collections'
    );
  });

  test('moveToCollection handler computes the sibling count from the target scope store, not the other scope', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);

    // The workspace collection of the same name has a different sibling count (3) than the
    // global collection (1) being moved into — proves order comes from the resolved store.
    const workspaceCollection = await workspace.addCollection('Personal');
    await workspace.addItem({ type: 'file', uri: 'file:///w1.txt', collectionId: workspaceCollection.id });
    await workspace.addItem({ type: 'file', uri: 'file:///w2.txt', collectionId: workspaceCollection.id });
    await workspace.addItem({ type: 'file', uri: 'file:///w3.txt', collectionId: workspaceCollection.id });

    const globalCollection = await global.addCollection('Personal');
    await global.addItem({ type: 'file', uri: 'file:///g1.txt', collectionId: globalCollection.id });
    const globalItemToMove = await global.addItem({ type: 'file', uri: 'file:///g2.txt' });

    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Personal')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItemToMove,
      scope: 'global'
    });

    const moved = global.getAll().items.find((i) => i.id === globalItemToMove.id)!;
    assert.strictEqual(moved.collectionId, globalCollection.id);
    assert.strictEqual(
      moved.order,
      1,
      'order must equal the global collection\'s existing sibling count (1), not the workspace collection\'s (3)'
    );
  });

  test('moveToCollection handler on a workspace-scoped node leaves the global store untouched', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Work');
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///a.txt' });
    await global.addCollection('Work'); // deliberately colliding name, distinct store
    const globalBefore = snapshotStore(global, globalMemento);
    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Work')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: workspaceItem,
      scope: 'workspace'
    });

    assert.strictEqual(
      workspace.getAll().items.find((i) => i.id === workspaceItem.id)!.collectionId,
      workspaceCollection.id
    );
    assertUntouched(global, globalMemento, globalBefore, 'global');
  });

  test('moveToCollection handler on a global-scoped node leaves the workspace store untouched', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    await workspace.addCollection('Work'); // deliberately colliding name, distinct store
    const globalCollection = await global.addCollection('Work');
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///a.txt' });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Work')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItem,
      scope: 'global'
    });

    assert.strictEqual(
      global.getAll().items.find((i) => i.id === globalItem.id)!.collectionId,
      globalCollection.id
    );
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });
});

// The VS Code Extension Test Host activates this extension for real at some point during the
// mocha run (package.json's `"activationEvents": []` implies `onStartupFinished`), independent of
// test/file order — permanently registering the real `bookmarks.*` commands, including
// `bookmarks.toggleGroupByRepo` / `bookmarks.refresh`, through the real extension's own
// `context.subscriptions` (never disposed mid-process). `vscode.commands.registerCommand` is a
// single, non-idempotent, process-wide registry, so once real activation has claimed an id, any
// later `registerCommand` call for that same id — such as this suite's stub-context registration —
// throws `command '...' already exists`, and there is no supported API to unregister a command
// owned by a `Disposable` this suite never held. This is not just a "runs late in the file" problem:
// PR #75's CI run proved real activation can land in the middle of the (textually earlier, four-test)
// `registerAddCommands` suite too — the third test passed, then the fourth failed with `command
// 'bookmarks.addFile' already exists`, because activation registered it in the gap between the two
// tests. That suite now uses this same shim (see its comment above) rather than relying on running
// "early enough" to win a race that has no guaranteed winner.
//
// These two tests isolate themselves from that shared, uncontrollable global registry by swapping
// `vscode.commands.registerCommand` / `executeCommand` for an in-memory stand-in for the test's
// duration only, then restoring the originals. `registerViewCommands` still calls the exact same
// API surface with the exact same signatures, and the test still dispatches by command id through
// `vscode.commands.executeCommand` — so this still proves `registerViewCommands` wires
// `bookmarks.toggleGroupByRepo` / `bookmarks.refresh` to the given `BookmarksTreeDataProvider`
// exactly as a real command dispatch would. It just never touches the real extension's
// registrations, so the assertions no longer depend on winning a timing race against
// `onStartupFinished`. Any id not registered through the shim falls through to the real dispatcher,
// so this cannot mask an unrelated command lookup.
async function withIsolatedCommandRegistry<T>(run: () => Promise<T>): Promise<T> {
  const realRegisterCommand = vscode.commands.registerCommand;
  const realExecuteCommand = vscode.commands.executeCommand;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  (vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand = ((
    command: string,
    callback: (...args: unknown[]) => unknown,
    thisArg?: unknown
  ) => {
    handlers.set(command, thisArg === undefined ? callback : callback.bind(thisArg));
    return { dispose: () => handlers.delete(command) };
  }) as typeof vscode.commands.registerCommand;

  (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = (async (
    command: string,
    ...rest: unknown[]
  ) => {
    const handler = handlers.get(command);
    if (!handler) {
      return realExecuteCommand(command, ...rest);
    }
    return handler(...rest);
  }) as typeof vscode.commands.executeCommand;

  try {
    return await run();
  } finally {
    (vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand =
      realRegisterCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand =
      realExecuteCommand;
  }
}

suite('commands - view (toggleGroupByRepo / refresh)', () => {
  test('toggleGroupByRepo flips between default and byRepo', async () => {
    await withIsolatedCommandRegistry(async () => {
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
  });

  test('refresh invalidates the cache so the next render re-resolves', async () => {
    await withIsolatedCommandRegistry(async () => {
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
});

// --- #115: "Toggle Show Full Path" — a view-title-bar toggle mirroring toggleGroupByRepo's shape
// exactly (new command id `bookmarks.toggleShowFullPath`, wired through `registerViewCommands`,
// flips a flag on the provider, and triggers a refresh). See bookmarksTreeDataProvider.test.ts's
// "show full path (#115)" suite for the label/description rendering and persistence contract;
// this suite only proves the command plumbing, the same split `toggleGroupByRepo` already has
// between this file (wiring) and the provider's own tests (rendering).
suite('commands - view (toggleShowFullPath) (#115)', () => {
  test('toggleShowFullPath flips the full-path display flag, mirroring toggleGroupByRepo', async () => {
    await withIsolatedCommandRegistry(async () => {
      const store = new BookmarkStore(new FakeMemento());
      const cache = new FsGitCache(async () => ({ exists: true }));
      const provider = new BookmarksTreeDataProvider(store, cache);
      const subscriptions: vscode.Disposable[] = [];
      registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

      try {
        assert.strictEqual(provider.getShowFullPath(), false, 'the toggle must default to off');
        await vscode.commands.executeCommand('bookmarks.toggleShowFullPath');
        assert.strictEqual(provider.getShowFullPath(), true);
        await vscode.commands.executeCommand('bookmarks.toggleShowFullPath');
        assert.strictEqual(provider.getShowFullPath(), false);
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('toggleShowFullPath triggers a tree refresh (onDidChangeTreeData), same as toggleGroupByRepo', async () => {
    await withIsolatedCommandRegistry(async () => {
      const store = new BookmarkStore(new FakeMemento());
      const cache = new FsGitCache(async () => ({ exists: true }));
      const provider = new BookmarksTreeDataProvider(store, cache);
      const subscriptions: vscode.Disposable[] = [];
      registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

      try {
        let redraws = 0;
        provider.onDidChangeTreeData(() => {
          redraws++;
        });
        await vscode.commands.executeCommand('bookmarks.toggleShowFullPath');
        assert.strictEqual(redraws, 1, 'toggling full-path display must trigger a refresh, same as toggleGroupByRepo');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });
});

suite('commands - setDescription', () => {
  function itemNode(item: BookmarkItem): BookmarkNode {
    return { kind: 'item', item, scope: 'workspace' };
  }

  test('is a no-op when invoked without a tree node', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = new FakePrompter({ inputBoxResult: 'unused' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)();

    assert.strictEqual(prompter.inputBoxCallCount, 0);
  });

  test('sets a description on an item', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = new FakePrompter({ inputBoxResult: 'the entrypoint' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(store.getAll().items[0].description, 'the entrypoint');
  });

  test('pre-fills the input box with the current description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: 'updated' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(prompter.lastInputBoxOptions?.value, 'existing');
  });

  test('submitting an empty input box clears the description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: '' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(store.getAll().items[0].description, undefined);
  });

  test('dismissing the input box leaves the description unchanged', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: undefined });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(store.getAll().items[0].description, 'existing');
  });

  test('sets a description on a collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addCollection('Work');
    const prompter = new FakePrompter({ inputBoxResult: 'work-related bookmarks' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'collection',
      collection: store.getAll().collections[0],
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections[0].description, 'work-related bookmarks');
  });

  test('is a no-op on a repoGroup node', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = new FakePrompter({ inputBoxResult: 'nope' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'repoGroup',
      label: 'repo-a',
      repoKey: 'repo:repo-a'
    });

    assert.strictEqual(prompter.inputBoxCallCount, 0, 'the input box must not even open for a repo group');
  });

  test('sets a description on a global-scoped item without touching the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = new FakePrompter({ inputBoxResult: 'always available' });

    await createSetDescriptionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItem,
      scope: 'global'
    });

    assert.strictEqual(global.getAll().items[0].description, 'always available');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('sets a description on a global-scoped collection without touching the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    await workspace.addCollection('Work'); // deliberately colliding name, distinct store
    const globalCollection = await global.addCollection('Work');
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = new FakePrompter({ inputBoxResult: 'global collection note' });

    await createSetDescriptionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'collection',
      collection: globalCollection,
      scope: 'global'
    });

    assert.strictEqual(global.getAll().collections[0].description, 'global collection note');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('sets a description on a workspace-scoped item without touching the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    const globalBefore = snapshotStore(global, globalMemento);
    const prompter = new FakePrompter({ inputBoxResult: 'project-specific' });

    await createSetDescriptionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: workspaceItem,
      scope: 'workspace'
    });

    assert.strictEqual(workspace.getAll().items[0].description, 'project-specific');
    assertUntouched(global, globalMemento, globalBefore, 'global');
  });
});

// T10 (#55/#56) `createAddToWorkspaceHandler`: promotes an addable global folder into the current
// workspace via `vscode.workspace.updateWorkspaceFolders`. Contract pinned in
// docs/superpowers/specs/2026-07-22-vscode-bookmarks-plus-design.md §5, issue #56.
//
// `folder()` mirrors the fixture shape already used in workspaceFolders.test.ts:10-12 — `index`
// isn't part of any contract this handler reads, a fixed default is fine.
function folder(uri: vscode.Uri, name = 'workspace-folder', index = 0): vscode.WorkspaceFolder {
  return { uri, name, index };
}

interface UpdateWorkspaceFoldersCall {
  start: number;
  deleteCount: number | undefined | null;
  folders: { uri: vscode.Uri; name?: string }[];
}

interface AddToWorkspaceFakes {
  deps: AddToWorkspaceDeps;
  /** Ordered log of every side-effecting call the handler made, across all three fakes. */
  calls: string[];
  updateCalls: UpdateWorkspaceFoldersCall[];
  infoMessages: string[];
  confirmCalls: Array<{ message: string; confirmLabel: string }>;
}

/**
 * Builds a fresh set of `AddToWorkspaceDeps` fakes plus recorders. `calls` is the single shared
 * ordering log ('confirm' / 'flush' / 'update') used to pin the confirm-before-flush-before-update
 * sequence, the flush-must-precede-mutation risk (plan risk 2), and the never-call-twice rule all
 * in one assertion per test, rather than needing a dedicated "called exactly once" test.
 */
function makeAddToWorkspaceFakes(
  options: {
    folders?: readonly vscode.WorkspaceFolder[] | undefined;
    confirmResult?: boolean;
    updateResult?: boolean;
  } = {}
): AddToWorkspaceFakes {
  const calls: string[] = [];
  const updateCalls: UpdateWorkspaceFoldersCall[] = [];
  const infoMessages: string[] = [];
  const confirmCalls: Array<{ message: string; confirmLabel: string }> = [];
  const confirmResult = options.confirmResult ?? true;
  const updateResult = options.updateResult ?? true;

  const deps: AddToWorkspaceDeps = {
    prompter: {
      showWarningConfirm: async (message: string, confirmLabel: string) => {
        calls.push('confirm');
        confirmCalls.push({ message, confirmLabel });
        return confirmResult;
      },
      showInfo: async (message: string) => {
        infoMessages.push(message);
      }
    },
    getWorkspaceFolders: () => options.folders,
    updateWorkspaceFolders: (
      start: number,
      deleteCount: number | undefined | null,
      ...foldersToAdd: { uri: vscode.Uri; name?: string }[]
    ) => {
      calls.push('update');
      updateCalls.push({ start, deleteCount, folders: foldersToAdd });
      return updateResult;
    },
    flushMirrorWrites: async () => {
      calls.push('flush');
    }
  };

  return { deps, calls, updateCalls, infoMessages, confirmCalls };
}

function folderItem(uri: vscode.Uri, id = 'addable-folder'): BookmarkItem {
  return { id, type: 'folder', uri: uri.toString(), collectionId: null, order: 0 };
}

suite('commands - addToWorkspace', () => {
  // A location that is never inside any of this suite's fixture workspace-folder lists, so it is
  // always the "outside the workspace" addable case unless a test constructs its own uri.
  const outsideUri = vscode.Uri.file('/outside/new-folder');

  function assertNoSideEffects(fakes: AddToWorkspaceFakes): void {
    assert.deepStrictEqual(
      fakes.calls,
      [],
      'a refused node must never call updateWorkspaceFolders or flushMirrorWrites'
    );
  }

  test('refuses a workspace-scoped folder item', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'workspace'
    });
    assertNoSideEffects(fakes);
  });

  test('refuses a global-scoped file item', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    const item: BookmarkItem = {
      id: 'global-file',
      type: 'file',
      uri: outsideUri.toString(),
      collectionId: null,
      order: 0
    };
    await createAddToWorkspaceHandler(fakes.deps)({ kind: 'item', item, scope: 'global' });
    assertNoSideEffects(fakes);
  });

  test('refuses a global folder item that is already inside the workspace', async () => {
    const root = vscode.Uri.file('/workspace/project');
    const folders = [folder(root)];
    const descendantUri = vscode.Uri.file('/workspace/project/subfolder');
    assert.strictEqual(
      isInsideWorkspace(descendantUri, folders),
      true,
      'fixture precondition: the descendant uri must actually be inside these folders'
    );
    const fakes = makeAddToWorkspaceFakes({ folders });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(descendantUri),
      scope: 'global'
    });
    assertNoSideEffects(fakes);
  });

  test('refuses a collection node', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    const collection: BookmarkCollection = { id: 'c1', name: 'Work', order: 0 };
    await createAddToWorkspaceHandler(fakes.deps)({ kind: 'collection', collection, scope: 'global' });
    assertNoSideEffects(fakes);
  });

  test('refuses a repoGroup node', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'repoGroup',
      label: 'repo-a',
      repoKey: 'repo:repo-a'
    });
    assertNoSideEffects(fakes);
  });

  test('refuses a globalRoot node', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({ kind: 'globalRoot' });
    assertNoSideEffects(fakes);
  });

  test('empty window (folders undefined): adds at index 0, no confirm, flush before update', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['flush', 'update'],
      'an empty window must flush the mirror before updating folders, and never confirm'
    );
    assert.strictEqual(fakes.updateCalls.length, 1);
    const call = fakes.updateCalls[0];
    assert.strictEqual(call.start, 0);
    assert.strictEqual(call.deleteCount, null);
    assert.strictEqual(call.folders.length, 1);
    assert.strictEqual(call.folders[0].uri.toString(), outsideUri.toString());
  });

  test('empty window (folders []): adds at index 0, no confirm, flush before update', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: [] });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(fakes.calls, ['flush', 'update']);
    assert.strictEqual(fakes.updateCalls.length, 1);
    assert.strictEqual(fakes.updateCalls[0].start, 0);
    assert.strictEqual(fakes.updateCalls[0].deleteCount, null);
    assert.strictEqual(fakes.updateCalls[0].folders[0].uri.toString(), outsideUri.toString());
  });

  test(
    'single-root, confirmed: shows a confirm naming the mirror and restart consequences, then ' +
      'flushes, then adds at index 1',
    async () => {
      const root = vscode.Uri.file('/workspace/project');
      const folders = [folder(root)];
      const fakes = makeAddToWorkspaceFakes({ folders, confirmResult: true });

      await createAddToWorkspaceHandler(fakes.deps)({
        kind: 'item',
        item: folderItem(outsideUri),
        scope: 'global'
      });

      assert.deepStrictEqual(
        fakes.calls,
        ['confirm', 'flush', 'update'],
        'must confirm, then flush the mirror, then update folders — in that order'
      );
      assert.strictEqual(fakes.confirmCalls.length, 1);
      const { message, confirmLabel } = fakes.confirmCalls[0];
      assert.ok(message.length > 0, 'the confirm message must not be empty');
      assert.match(
        message,
        /mirror|bookmarks\.json/i,
        'the confirm message must name the mirror-disabling consequence'
      );
      assert.match(
        message,
        /restart|reload/i,
        'the confirm message must name the possible extension-host restart consequence'
      );
      assert.ok(confirmLabel.length > 0, 'the confirm label must not be empty');

      assert.strictEqual(fakes.updateCalls.length, 1);
      assert.strictEqual(fakes.updateCalls[0].start, 1, 'start index must equal the current folder count (1)');
      assert.strictEqual(fakes.updateCalls[0].deleteCount, null);
      assert.strictEqual(fakes.updateCalls[0].folders[0].uri.toString(), outsideUri.toString());
    }
  );

  test('single-root, declined: never updates workspace folders or flushes the mirror', async () => {
    const root = vscode.Uri.file('/workspace/project');
    const folders = [folder(root)];
    const fakes = makeAddToWorkspaceFakes({ folders, confirmResult: false });

    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['confirm'],
      'declining the confirmation must stop before any flush or update call'
    );
  });

  test('multi-root: no confirm, adds at index equal to the current folder count', async () => {
    const folders = [
      folder(vscode.Uri.file('/workspace/repo-a'), 'repo-a', 0),
      folder(vscode.Uri.file('/workspace/repo-b'), 'repo-b', 1),
      folder(vscode.Uri.file('/workspace/repo-c'), 'repo-c', 2)
    ];
    const fakes = makeAddToWorkspaceFakes({ folders });

    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['flush', 'update'],
      'a transition that is already multi-root must not confirm'
    );
    assert.strictEqual(fakes.updateCalls.length, 1);
    assert.strictEqual(fakes.updateCalls[0].start, 3, 'start index must equal the current folder count (3)');
    assert.strictEqual(fakes.updateCalls[0].deleteCount, null);
  });

  test('a false return from updateWorkspaceFolders surfaces an info message and does not throw', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined, updateResult: false });

    await assert.doesNotReject(
      createAddToWorkspaceHandler(fakes.deps)({
        kind: 'item',
        item: folderItem(outsideUri),
        scope: 'global'
      })
    );

    assert.strictEqual(fakes.infoMessages.length, 1, 'a false return must surface exactly one info message');
    assert.ok(fakes.infoMessages[0].length > 0, 'the failure message must not be empty');
  });

  test('a true return from updateWorkspaceFolders is silent (no info message)', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined, updateResult: true });

    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.strictEqual(fakes.infoMessages.length, 0, 'success must not surface an info message');
  });
});

// Issue #93: clicking a global folder bookmark outside the workspace used to silently no-op
// (revealInExplorer has nothing to reveal for a folder that isn't part of any open workspace
// folder). `createRevealHandler` now takes a `RevealDeps` bag instead of a bare reveal function,
// and branches: an "addable global folder" (same condition as `isAddableGlobalFolder` in
// bookmarksTreeDataProvider.ts:199 — global scope, folder type, not already inside the workspace)
// shows a two-action prompt instead of revealing; every other node shape reveals exactly as
// before. `ADD_TO_WORKSPACE_LABEL` / `OPEN_IN_NEW_WINDOW_LABEL` are imported from `commands.ts`
// rather than hardcoded here so the test file and the implementation share one source of truth for
// the action labels.
interface RevealFakes {
  deps: RevealDeps;
  /** Ordered log of every side-effecting call the handler made, across all four fakes. */
  calls: string[];
  revealedUris: string[];
  promptCalls: Array<{ message: string; actions: string[] }>;
  addToWorkspaceCalls: BookmarkNode[];
  openInNewWindowUris: string[];
}

function makeRevealFakes(
  options: {
    folders?: readonly vscode.WorkspaceFolder[] | undefined;
    actionPromptResult?: string | undefined;
  } = {}
): RevealFakes {
  const calls: string[] = [];
  const revealedUris: string[] = [];
  const promptCalls: Array<{ message: string; actions: string[] }> = [];
  const addToWorkspaceCalls: BookmarkNode[] = [];
  const openInNewWindowUris: string[] = [];

  const deps: RevealDeps = {
    reveal: async (uri) => {
      calls.push('reveal');
      revealedUris.push(uri.toString());
    },
    prompter: {
      showActionPrompt: async (message, actions) => {
        calls.push('prompt');
        promptCalls.push({ message, actions });
        return options.actionPromptResult;
      }
    },
    getWorkspaceFolders: () => options.folders,
    addToWorkspace: async (node) => {
      calls.push('addToWorkspace');
      addToWorkspaceCalls.push(node);
    },
    openInNewWindow: async (uri) => {
      calls.push('openInNewWindow');
      openInNewWindowUris.push(uri.toString());
    }
  };

  return { deps, calls, revealedUris, promptCalls, addToWorkspaceCalls, openInNewWindowUris };
}

suite('commands - reveal (out-of-workspace global folder prompt, #93)', () => {
  // Never inside any of this suite's fixture workspace-folder lists, so it is always the
  // "outside the workspace" case unless a test constructs its own uri/folders pair.
  const outsideUri = vscode.Uri.file('/outside/new-folder');

  function assertNoCalls(fakes: RevealFakes, label: string): void {
    assert.deepStrictEqual(fakes.calls, [], `${label} must not call reveal, prompt, addToWorkspace, or openInNewWindow`);
  }

  test('is a no-op for non-item nodes (repoGroup)', async () => {
    const fakes = makeRevealFakes();
    await createRevealHandler(fakes.deps)({ kind: 'repoGroup', label: 'x', repoKey: 'x' });
    assertNoCalls(fakes, 'a repoGroup node');
  });

  test('is a no-op for non-item nodes (globalRoot)', async () => {
    const fakes = makeRevealFakes();
    await createRevealHandler(fakes.deps)({ kind: 'globalRoot' });
    assertNoCalls(fakes, 'a globalRoot node');
  });

  test('is a no-op for non-item nodes (collection)', async () => {
    const fakes = makeRevealFakes();
    const collection: BookmarkCollection = { id: 'c1', name: 'Work', order: 0 };
    await createRevealHandler(fakes.deps)({ kind: 'collection', collection, scope: 'global' });
    assertNoCalls(fakes, 'a collection node');
  });

  test('reveals a workspace-scoped file item without prompting', async () => {
    const fakes = makeRevealFakes({ folders: undefined });
    const item: BookmarkItem = { id: '1', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 };

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'workspace' });

    assert.deepStrictEqual(fakes.calls, ['reveal']);
    assert.deepStrictEqual(fakes.revealedUris, ['file:///a.txt']);
  });

  test('reveals a global-scoped file item without prompting, even when it is outside every workspace folder', async () => {
    const fakes = makeRevealFakes({ folders: undefined });
    const item: BookmarkItem = { id: '2', type: 'file', uri: outsideUri.toString(), collectionId: null, order: 0 };

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'global' });

    assert.deepStrictEqual(fakes.calls, ['reveal'], 'a file is never "addable", so it always just reveals');
    assert.deepStrictEqual(fakes.revealedUris, [outsideUri.toString()]);
  });

  test('reveals a workspace-scoped folder item without prompting, regardless of workspace-folder membership', async () => {
    // Deliberately outside every fixture workspace folder — proves the no-prompt behavior here
    // comes from scope (not global), not from the folder happening to already be inside the
    // workspace.
    const fakes = makeRevealFakes({ folders: undefined });
    const item: BookmarkItem = { id: '3', type: 'folder', uri: outsideUri.toString(), collectionId: null, order: 0 };

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'workspace' });

    assert.deepStrictEqual(fakes.calls, ['reveal']);
    assert.deepStrictEqual(fakes.revealedUris, [outsideUri.toString()]);
  });

  test('reveals a global folder item that is already inside the workspace without prompting', async () => {
    const root = vscode.Uri.file('/workspace/project');
    const folders = [folder(root)];
    const descendantUri = vscode.Uri.file('/workspace/project/subfolder');
    assert.strictEqual(
      isInsideWorkspace(descendantUri, folders),
      true,
      'fixture precondition: the descendant uri must actually be inside these folders'
    );
    const fakes = makeRevealFakes({ folders });

    await createRevealHandler(fakes.deps)({ kind: 'item', item: folderItem(descendantUri), scope: 'global' });

    assert.deepStrictEqual(fakes.calls, ['reveal'], 'an already-in-workspace global folder is not "addable"');
    assert.deepStrictEqual(fakes.revealedUris, [descendantUri.toString()]);
  });

  test(
    'prompts with the Add-to-Workspace and Open-in-New-Window actions for an addable global ' +
      'folder outside the workspace, and does not reveal',
    async () => {
      const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: undefined });

      await createRevealHandler(fakes.deps)({
        kind: 'item',
        item: folderItem(outsideUri),
        scope: 'global'
      });

      assert.strictEqual(fakes.promptCalls.length, 1, 'exactly one action prompt must be shown');
      const { message, actions } = fakes.promptCalls[0];
      assert.ok(message.length > 0, 'the prompt message must not be empty');
      assert.deepStrictEqual(
        actions,
        [ADD_TO_WORKSPACE_LABEL, OPEN_IN_NEW_WINDOW_LABEL],
        'the two offered actions must be exactly the Add-to-Workspace and Open-in-New-Window labels, in that order'
      );
      assert.strictEqual(fakes.revealedUris.length, 0, 'reveal must never be called for an addable global folder');
    }
  );

  test('the same addable-global-folder condition also applies when the folder list is empty ([])', async () => {
    const fakes = makeRevealFakes({ folders: [], actionPromptResult: undefined });

    await createRevealHandler(fakes.deps)({ kind: 'item', item: folderItem(outsideUri), scope: 'global' });

    assert.strictEqual(fakes.promptCalls.length, 1);
    assert.strictEqual(fakes.revealedUris.length, 0);
  });

  test('picking Add to Workspace calls addToWorkspace with the node and calls neither openInNewWindow nor reveal', async () => {
    const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: ADD_TO_WORKSPACE_LABEL });
    const node: BookmarkNode = { kind: 'item', item: folderItem(outsideUri), scope: 'global' };

    await createRevealHandler(fakes.deps)(node);

    assert.deepStrictEqual(fakes.calls, ['prompt', 'addToWorkspace']);
    assert.deepStrictEqual(fakes.addToWorkspaceCalls, [node]);
    assert.strictEqual(fakes.openInNewWindowUris.length, 0);
    assert.strictEqual(fakes.revealedUris.length, 0);
  });

  test('picking Open in New Window calls openInNewWindow with the parsed uri and calls neither addToWorkspace nor reveal', async () => {
    const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: OPEN_IN_NEW_WINDOW_LABEL });
    const item = folderItem(outsideUri);

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'global' });

    assert.deepStrictEqual(fakes.calls, ['prompt', 'openInNewWindow']);
    assert.deepStrictEqual(fakes.openInNewWindowUris, [outsideUri.toString()]);
    assert.strictEqual(fakes.addToWorkspaceCalls.length, 0);
    assert.strictEqual(fakes.revealedUris.length, 0);
  });

  test('dismissing the action prompt (undefined) does nothing further', async () => {
    const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: undefined });

    await createRevealHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['prompt'],
      'dismissing the prompt must not call addToWorkspace, openInNewWindow, or reveal'
    );
  });

  test('the exported action labels are the user-visible strings the prompt must offer', () => {
    // Pins the label *values*, not just their names — the branch tests above only prove the
    // prompt is offered `[ADD_TO_WORKSPACE_LABEL, OPEN_IN_NEW_WINDOW_LABEL]` and route on
    // whichever string each constant happens to hold, which is satisfied no matter what those
    // constants are set to. This is the one assertion in the suite that pins the actual spec text.
    assert.strictEqual(ADD_TO_WORKSPACE_LABEL, 'Add to Workspace');
    assert.strictEqual(OPEN_IN_NEW_WINDOW_LABEL, 'Open in New Window');
  });
});

// --- #95 R4: regression guards for the widened BookmarkNode union — createRemoveHandler and
// createRevealHandler must keep treating a 'suggestion' node exactly like any other non-'item'
// node (a no-op), the same way both already handle 'collection' / 'repoGroup' / 'globalRoot'
// throughout this file. Built with `as unknown as BookmarkNode` so this file compiles against
// both today's four-arm union and the widened one from T5 (plan docs/superpowers/plans/2026-08-25-
// suggested-bookmarks-from-recent-items.md) — these prove today's `node.kind !== 'item'` guards
// already cover the new kind, rather than being expected to start red.
suite('commands - suggestion-kind regression guards (#95 R4)', () => {
  function suggestionNode(uri = 'file:///suggested.txt'): BookmarkNode {
    return {
      kind: 'suggestion',
      recentItem: { uri, firstSeen: 1000, previewCount: 0, promoted: true }
    } as unknown as BookmarkNode;
  }

  test('remove handler ignores a suggestion node', async () => {
    const stores = makeScopedStores();
    await stores.workspace.addItem({ type: 'file', uri: 'file:///a.txt' });
    const handler = createRemoveHandler(stores);

    await handler(suggestionNode());

    assert.strictEqual(stores.workspace.getAll().items.length, 1, 'a suggestion node must not remove anything');
  });

  test('reveal handler ignores a suggestion node', async () => {
    const fakes = makeRevealFakes();
    await createRevealHandler(fakes.deps)(suggestionNode());
    assert.deepStrictEqual(
      fakes.calls,
      [],
      'a suggestion node must not reveal, prompt, addToWorkspace, or openInNewWindow'
    );
  });
});

// --- #95 T6: bookmarks.promoteSuggestion — routes through the exact same addBookmark() helper
// every other add path uses (commands.ts:47-61), so DuplicateBookmarkError produces the identical
// "already bookmarked" info toast. Promoting removes the item from the Suggested list on the next
// render because it becomes bookmarked and C7/D9's either-store filter then excludes it — that
// filter is exercised directly in bookmarksTreeDataProvider.test.ts ("excludes a uri already
// bookmarked ..."); this suite only proves the store write and duplicate-handling contract of the
// command itself.
//
// Assumption (not pinned by the plan, which leaves the exact signature to implementation time):
// `createPromoteSuggestionHandler` is bound to a single (workspace) store, mirroring
// `createAddFileHandler`'s shape — the same store `bookmarks.addFile` targets — rather than a
// `ScopedStores` bag, since a recent-item has no scope of its own to route on.
suite('commands - promoteSuggestion (#95 T6)', () => {
  function suggestionNode(uri: string): BookmarkNode {
    return {
      kind: 'suggestion',
      recentItem: { uri, firstSeen: 1000, previewCount: 0, promoted: true }
    } as unknown as BookmarkNode;
  }

  test('adds the suggested uri as a file bookmark to the workspace store', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///suggested-a.txt';

    await createPromoteSuggestionHandler(store, makePrompter())(suggestionNode(uri));

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'file');
    assert.strictEqual(items[0].uri, uri);
  });

  test('shows the same "already bookmarked" info message as every other add path on a duplicate', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///suggested-a.txt';
    await store.addItem({ type: 'file', uri });
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });

    await createPromoteSuggestionHandler(store, prompter)(suggestionNode(uri));

    assert.strictEqual(
      store.getAll().items.length,
      1,
      'promoting an already-bookmarked uri must not create a duplicate'
    );
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('ignores non-suggestion nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const nonSuggestionNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };

    await createPromoteSuggestionHandler(store, makePrompter())(nonSuggestionNode);

    assert.strictEqual(store.getAll().items.length, 0, 'a non-suggestion node must not add anything');
  });
});

// --- #108: bookmarks promote-from-Recent — mirrors createPromoteSuggestionHandler exactly in
// shape: routed through the same addBookmark() helper (commands.ts) so DuplicateBookmarkError
// produces the identical "already bookmarked" info toast. Workspace-scoped, same as
// promoteSuggestion, since a recentItem node has no scope of its own to route on.
//
// `createPromoteRecentItemHandler` does not exist yet — this suite is expected to fail to compile
// until it is added.
suite('commands - promoteRecentItem (#108)', () => {
  function recentItemNode(uri: string): BookmarkNode {
    return { kind: 'recentItem', uri } as unknown as BookmarkNode;
  }

  test('adds the recent uri as a file bookmark to the workspace store', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///recent-a.txt';

    await createPromoteRecentItemHandler(store, makePrompter())(recentItemNode(uri));

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'file');
    assert.strictEqual(items[0].uri, uri);
  });

  test('shows the same "already bookmarked" info message as every other add path on a duplicate', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///recent-a.txt';
    await store.addItem({ type: 'file', uri });
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });

    await createPromoteRecentItemHandler(store, prompter)(recentItemNode(uri));

    assert.strictEqual(
      store.getAll().items.length,
      1,
      'promoting an already-bookmarked recent uri must not create a duplicate'
    );
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('ignores non-recentItem nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const nonRecentItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };

    await createPromoteRecentItemHandler(store, makePrompter())(nonRecentItemNode);

    assert.strictEqual(store.getAll().items.length, 0, 'a non-recentItem node must not add anything');
  });

  test('ignores a suggestion node too (only recentItem nodes are promoted by this handler)', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const suggestionNode: BookmarkNode = {
      kind: 'suggestion',
      recentItem: { uri: 'file:///suggested.txt', firstSeen: 1000, previewCount: 0, promoted: true }
    } as unknown as BookmarkNode;

    await createPromoteRecentItemHandler(store, makePrompter())(suggestionNode);

    assert.strictEqual(store.getAll().items.length, 0);
  });
});
