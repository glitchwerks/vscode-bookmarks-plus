import { createSingleRootFixtureStore, SINGLE_ROOT_OWNER } from './singleRootFixture';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { FsGitCache } from '../../fsGitCache';
import {
  BookmarksTreeDataProvider,
  BookmarkNode,
  DND_MIME_TYPE,
  RecentlyViewedSource,
  SuggestionsSource
} from '../../bookmarksTreeDataProvider';
import { RecentItem } from '../../recentItems';
import { BookmarkData, BookmarkItem } from '../../types';
import { WorkspaceBookmarkStore, WorkspaceStoreView } from '../../workspaceBookmarkStore';
import { WorkspaceOwnerRef } from '../../workspacePartitionTypes';
import { FakeMemento } from './fixtures';

async function makeProvider(resolve: (uri: string) => Promise<{ exists: boolean; repoName?: string }> = async () => ({ exists: true })) {
  const store = await createSingleRootFixtureStore();
  const cache = new FsGitCache(resolve);
  const provider = new BookmarksTreeDataProvider(store, cache);
  return { store, cache, provider };
}

suite('BookmarksTreeDataProvider - default mode', () => {
  test('empty store yields no root children', async () => {
    const { provider } = await makeProvider();
    const children = await provider.getChildren();
    assert.deepStrictEqual(children, []);
  });

  test('root shows collections before ungrouped items, each sorted by order', async () => {
    const { store, provider } = await makeProvider();
    await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const children = await provider.getChildren();
    assert.strictEqual(children.length, 3);
    assert.strictEqual(children[0].kind, 'collection');
    assert.strictEqual(children[1].kind, 'item');
    assert.strictEqual(children[2].kind, 'item');
  });

  test('a collection node lists only its own items', async () => {
    const { store, provider } = await makeProvider();
    const collection = await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' }); // root item — must not appear

    const node: BookmarkNode = { kind: 'collection', collection, scope: 'workspace', owner: SINGLE_ROOT_OWNER };
    const children = await provider.getChildren(node);

    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].kind, 'item');
  });

  test('a folder bookmark tree item is always a leaf (collapsibleState None) and has no children', async () => {
    const { store, provider } = await makeProvider();
    const folder = await store.addItem({ type: 'folder', uri: 'file:///dir' });
    const node: BookmarkNode = { kind: 'item', item: folder, scope: 'workspace', owner: SINGLE_ROOT_OWNER };

    const treeItem = await provider.getTreeItem(node);
    assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.None);

    const children = await provider.getChildren(node);
    assert.deepStrictEqual(children, []);
  });

  test('a broken bookmark renders with a warning icon and does not throw', async () => {
    const { store, provider } = await makeProvider(async () => ({ exists: false }));
    const item = await store.addItem({ type: 'file', uri: 'file:///missing.txt' });
    const node: BookmarkNode = { kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER };

    const treeItem = await provider.getTreeItem(node);
    assert.ok(treeItem.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((treeItem.iconPath as vscode.ThemeIcon).id, 'warning');
  });

  test('a valid bookmark with a resolved repo shows the repo name as its description', async () => {
    const { store, provider } = await makeProvider(async () => ({ exists: true, repoName: 'my-repo' }));
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });
    assert.strictEqual(treeItem.description, 'my-repo');
  });

  test('file bookmark tree item opens the file directly, bypassing bookmarks.reveal', async () => {
    const { store, provider } = await makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });
    assert.strictEqual(treeItem.command?.command, 'vscode.open');
  });

  test('folder bookmark tree item triggers bookmarks.reveal (its only possible click target)', async () => {
    const { store, provider } = await makeProvider();
    const item = await store.addItem({ type: 'folder', uri: 'file:///dir' });
    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });
    assert.strictEqual(treeItem.command?.command, 'bookmarks.reveal');
  });

  test('re-fires onDidChangeTreeData and invalidates the cache when the store changes', async () => {
    let resolveCalls = 0;
    const { store, provider } = await makeProvider(async () => { resolveCalls++; return { exists: true }; });

    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });
    assert.strictEqual(resolveCalls, 1);

    let redraws = 0;
    provider.onDidChangeTreeData(() => { redraws++; });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    assert.strictEqual(redraws, 1);

    await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });
    assert.strictEqual(resolveCalls, 2, 'the cache must be invalidated on onBookmarksChanged');
  });
});

suite('BookmarksTreeDataProvider - group-by-repo mode', () => {
  test('an item with no resolvable repo falls into the Unknown group without throwing', async () => {
    const { store, provider } = await makeProvider(async () => ({ exists: true, repoName: undefined }));
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].kind, 'repoGroup');
    assert.strictEqual((roots[0] as { label: string }).label, 'Unknown');
  });

  test('a broken item also falls into the Unknown group in group-by-repo mode', async () => {
    const { store, provider } = await makeProvider(async () => ({ exists: false }));
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///missing.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual((roots[0] as { label: string }).label, 'Unknown');
  });

  test('degrades to an all-Unknown render (no throw) when no active git repository is found', async () => {
    const { store, provider } = await makeProvider(async () => ({ exists: true })); // simulates vscode.git unavailable
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual((roots[0] as { label: string }).label, 'Unknown');
  });

  test('groups items under their resolved repo, nested by collection, and each repo only sees its own items', async () => {
    const { store, provider } = await makeProvider(async (uri) => ({
      exists: true,
      repoName: uri.includes('repo-a') ? 'repo-a' : 'repo-b'
    }));
    provider.setGroupMode('byRepo');

    const collection = await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///repo-a/x.txt', collectionId: collection.id });
    await store.addItem({ type: 'file', uri: 'file:///repo-b/y.txt', collectionId: collection.id });
    await store.addItem({ type: 'file', uri: 'file:///repo-a/z.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 2);

    const repoA = roots.find((n) => (n as { label: string }).label === 'repo-a')!;
    const repoAChildren = await provider.getChildren(repoA);
    // repo-a has one collection-with-items and one root item.
    assert.strictEqual(repoAChildren.length, 2);
    const repoACollection = repoAChildren.find((n) => n.kind === 'collection')!;

    const itemsInRepoACollection = await provider.getChildren(repoACollection);
    assert.strictEqual(itemsInRepoACollection.length, 1);
    assert.strictEqual((itemsInRepoACollection[0] as { item: { uri: string } }).item.uri, 'file:///repo-a/x.txt');
  });

  test('a real repository literally named "Unknown" does not merge with the unresolved fallback bucket', async () => {
    const { store, provider } = await makeProvider(async (uri) =>
      uri.includes('real-repo') ? { exists: true, repoName: 'Unknown' } : { exists: true, repoName: undefined }
    );
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///real-repo/a.txt' });
    await store.addItem({ type: 'file', uri: 'file:///no-repo/b.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 2, 'real repo named Unknown and the unresolved fallback must be distinct groups');
    assert.ok(roots.every((n) => (n as { label: string }).label === 'Unknown'));

    const childCounts = await Promise.all(roots.map((r) => provider.getChildren(r)));
    const counts = childCounts.map((c) => c.length).sort();
    assert.deepStrictEqual(counts, [1, 1], 'each group must contain exactly its own item, not a merged pair');
  });
});

/**
 * T6 (#55 D5): the drag transfer payload is a scope-tagged envelope, not a bare id array — this
 * is what lets handleDrop tell a workspace-scoped drag apart from a global-scoped one and refuse
 * cross-scope moves. Every existing drop test must build its transfer through this shape.
 */
type DragScope = 'workspace' | 'global';
interface DragEnvelope {
  scope: DragScope;
  ids: string[];
}

function makeDropTransfer(scope: DragScope, ids: string[]): vscode.DataTransfer {
  const dt = new vscode.DataTransfer();
  dt.set(DND_MIME_TYPE, new vscode.DataTransferItem({ scope, ...(scope === 'workspace' ? { owner: SINGLE_ROOT_OWNER } : {}), ids }));
  return dt;
}

/** Reads the scope-tagged envelope back out of a DataTransfer set up by handleDrag, if any. */
function getTransferEnvelope(dt: vscode.DataTransfer): DragEnvelope | undefined {
  return dt.get(DND_MIME_TYPE)?.value as DragEnvelope | undefined;
}

suite('BookmarksTreeDataProvider - drag and drop', () => {
  for (const scope of ['workspace', 'global'] as const) {
    test(`${scope} drop retains successful moves around multiple failures and warns once`, async () => {
      const workspace = await createSingleRootFixtureStore();
      const global = new BookmarkStore(new FakeMemento());
      const store = scope === 'workspace' ? workspace : global;
      const source = await store.addCollection('Source');
      const destination = await store.addCollection('Destination');
      const add = (name: string, collectionId: string) => store.addItem({ type: 'file', uri: `file:///${name}.txt`, collectionId });
      const first = await add('first', source.id);
      const blockedA = await add('blocked-a', source.id);
      const blockedB = await add('blocked-b', source.id);
      const last = await add('last', source.id);
      const existingA = await add('blocked-a', destination.id);
      const existingB = await add('blocked-b', destination.id);
      const warnings: string[] = [];
      // Supply the warning boundary without replacing VS Code's read-only window API.
      const provider = new BookmarksTreeDataProvider(workspace,
        new FsGitCache(async () => ({ exists: true })), global, undefined, undefined, undefined, undefined,
        (message: string) => { warnings.push(message); });
      const token = new vscode.CancellationTokenSource();
      let changes = 0;
      const subscription = store.onBookmarksChanged(() => changes++);
      try {
        const target: BookmarkNode = { kind: 'item', item: existingA, scope,
          ...(scope === 'workspace' ? { owner: SINGLE_ROOT_OWNER } : {}) };
        await provider.handleDrop(target, makeDropTransfer(scope, [first.id, blockedA.id, blockedB.id, last.id]), token.token);
        const inCollection = (id: string) => store.getAll().items.filter(item => item.collectionId === id)
          .sort((a, b) => a.order - b.order).map(item => ({ id: item.id, order: item.order }));
        assert.deepStrictEqual(inCollection(source.id), [{ id: blockedA.id, order: 0 }, { id: blockedB.id, order: 1 }]);
        // Global nodes retain their live item reference; workspace nodes are snapshots.
        const destinationIds = scope === 'global'
          ? [first.id, last.id, existingA.id, existingB.id]
          : [last.id, first.id, existingA.id, existingB.id];
        assert.deepStrictEqual(inCollection(destination.id), destinationIds
          .map((id, order) => ({ id, order })));
        assert.strictEqual(changes, 2, 'only successful item moves publish changes');
        assert.strictEqual(warnings.length, 1, 'multiple item failures produce one drop warning');
        assert.match(warnings[0], /some bookmarks could not be moved/i);
        assert.deepStrictEqual((scope === 'workspace' ? global : workspace).getAll().items, []);
        await provider.handleDrop(target, makeDropTransfer(scope, [last.id]), token.token);
        assert.strictEqual(warnings.length, 1, 'a subsequent successful drop produces no warning');
      } finally { subscription.dispose(); token.dispose(); workspace.dispose(); global.dispose(); }
    });
  }

  test('dropping with no target appends the item to the root, at the end', async () => {
    const { store, provider } = await makeProvider();
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(undefined, makeDropTransfer('workspace', [a.id]), token);

    const data = store.getAll();
    const byId = (id: string) => data.items.find((i) => i.id === id)!;
    assert.strictEqual(byId(a.id).collectionId, null);
    assert.strictEqual(byId(a.id).order, 1);
    assert.strictEqual(byId(b.id).order, 0);
  });

  test('dropping on a collection node moves the item into it', async () => {
    const { store, provider } = await makeProvider();
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const other = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const targetNode: BookmarkNode = { kind: 'collection', collection, scope: 'workspace', owner: SINGLE_ROOT_OWNER };
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer('workspace', [item.id]), token);

    const data = store.getAll();
    const moved = data.items.find((i) => i.id === item.id)!;
    const remainingRoot = data.items.filter((i) => i.collectionId === null);

    assert.strictEqual(moved.collectionId, collection.id);
    assert.strictEqual(remainingRoot.length, 1);
    assert.strictEqual(remainingRoot[0].id, other.id);
    assert.strictEqual(remainingRoot[0].order, 0);
  });

  test('dropping on a sibling item reorders within the same parent', async () => {
    const { store, provider } = await makeProvider();
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    const c = await store.addItem({ type: 'file', uri: 'file:///c.txt' });

    const targetNode: BookmarkNode = { kind: 'item', item: a, scope: 'workspace', owner: SINGLE_ROOT_OWNER }; // drop c onto a's position
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer('workspace', [c.id]), token);

    const data = store.getAll();
    const byId = (id: string) => data.items.find((i) => i.id === id)!;
    assert.strictEqual(byId(c.id).order, 0);
    assert.strictEqual(byId(a.id).order, 1);
    assert.strictEqual(byId(b.id).order, 2);
  });

  test('drag and drop are disabled in group-by-repo mode', async () => {
    const { store, provider } = await makeProvider();
    provider.setGroupMode('byRepo');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(undefined, makeDropTransfer('workspace', [item.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === item.id)!;
    assert.strictEqual(untouched.collectionId, null);
    assert.strictEqual(untouched.order, 0);
  });

  test('handleDrag is disabled in group-by-repo mode and sets no transfer data', async () => {
    const { store, provider } = await makeProvider();
    provider.setGroupMode('byRepo');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag([{ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER }], dt, token);

    assert.strictEqual(dt.get(DND_MIME_TYPE), undefined);
  });

  test('handleDrag on an all-workspace-scope selection sets a workspace-scoped transfer envelope', async () => {
    const { store, provider } = await makeProvider();
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag(
      [
        { kind: 'item', item: a, scope: 'workspace', owner: SINGLE_ROOT_OWNER },
        { kind: 'item', item: b, scope: 'workspace', owner: SINGLE_ROOT_OWNER }
      ],
      dt,
      token
    );

    const envelope = getTransferEnvelope(dt);
    assert.ok(envelope, 'expected a transfer envelope to be set for an all-workspace selection');
    assert.strictEqual(envelope!.scope, 'workspace');
    assert.deepStrictEqual([...envelope!.ids].sort(), [a.id, b.id].sort());
  });

  test('handleDrag on an all-global-scope selection sets a global-scoped transfer envelope', async () => {
    const { globalStore, provider } = await makeProviderWithGlobal();
    const a = await globalStore.addItem({ type: 'file', uri: 'file:///global-a.txt' });
    const b = await globalStore.addItem({ type: 'file', uri: 'file:///global-b.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag(
      [
        { kind: 'item', item: a, scope: 'global' },
        { kind: 'item', item: b, scope: 'global' }
      ],
      dt,
      token
    );

    const envelope = getTransferEnvelope(dt);
    assert.ok(envelope, 'expected a transfer envelope to be set for an all-global selection');
    assert.strictEqual(envelope!.scope, 'global');
    assert.deepStrictEqual([...envelope!.ids].sort(), [a.id, b.id].sort());
  });

  test('handleDrag with a mixed-scope selection sets no transfer data', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();
    const workspaceItem = await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });
    const globalItem = await globalStore.addItem({ type: 'file', uri: 'file:///global-a.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag(
      [
        { kind: 'item', item: workspaceItem, scope: 'workspace', owner: SINGLE_ROOT_OWNER },
        { kind: 'item', item: globalItem, scope: 'global' }
      ],
      dt,
      token
    );

    assert.strictEqual(
      dt.get(DND_MIME_TYPE),
      undefined,
      'a selection mixing workspace and global items must set no transfer data at all'
    );
  });

  test('a global-scope envelope dropped on a workspace collection is a no-op in both stores', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();
    const workspaceCollection = await store.addCollection('WorkCol');
    const globalItem = await globalStore.addItem({ type: 'file', uri: 'file:///global-a.txt' });

    const targetNode: BookmarkNode = { kind: 'collection', collection: workspaceCollection, scope: 'workspace', owner: SINGLE_ROOT_OWNER };
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer('global', [globalItem.id]), token);

    const untouchedGlobal = globalStore.getAll().items.find((i) => i.id === globalItem.id)!;
    assert.strictEqual(untouchedGlobal.collectionId, null, 'the global item must not move into the workspace collection');
    assert.strictEqual(
      store.getAll().items.length,
      0,
      'nothing may be created in the workspace store by a refused cross-scope drop'
    );
  });

  test('a global-scope envelope dropped on a global collection moves within the global store, workspace store untouched', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();
    const globalCollection = await globalStore.addCollection('GlobalCol');
    const globalItem = await globalStore.addItem({ type: 'file', uri: 'file:///global-a.txt' });
    await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });

    const targetNode: BookmarkNode = { kind: 'collection', collection: globalCollection, scope: 'global' };
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer('global', [globalItem.id]), token);

    const moved = globalStore.getAll().items.find((i) => i.id === globalItem.id)!;
    assert.strictEqual(moved.collectionId, globalCollection.id, 'the global item must move into the global collection');
    assert.strictEqual(
      store.getAll().items.every((i) => i.uri === 'file:///workspace-a.txt'),
      true,
      'the workspace store must be untouched by a same-scope global drop'
    );
    assert.strictEqual(store.getAll().items.length, 1);
  });

  test('a global-scope envelope dropped on the Global row ungroups within the global store', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();
    const globalCollection = await globalStore.addCollection('GlobalCol');
    const globalItem = await globalStore.addItem({
      type: 'file',
      uri: 'file:///global-a.txt',
      collectionId: globalCollection.id
    });
    await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });

    const rootChildren = await provider.getChildren();
    const globalRootNode = rootChildren.find((n) => n.kind === 'globalRoot')!;
    assert.ok(globalRootNode, 'expected a Global row to drop onto');

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(globalRootNode, makeDropTransfer('global', [globalItem.id]), token);

    const moved = globalStore.getAll().items.find((i) => i.id === globalItem.id)!;
    assert.strictEqual(moved.collectionId, null, 'dropping on the Global row must ungroup the item within the global store');
    assert.strictEqual(store.getAll().items.length, 1, 'the workspace store must be untouched');
    assert.strictEqual(store.getAll().items[0].collectionId, null);
  });

  test('a global-scope envelope dropped with no target is a no-op (refused per D5)', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();
    const globalCollection = await globalStore.addCollection('GlobalCol');
    const globalItem = await globalStore.addItem({
      type: 'file',
      uri: 'file:///global-a.txt',
      collectionId: globalCollection.id
    });
    await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(undefined, makeDropTransfer('global', [globalItem.id]), token);

    const untouched = globalStore.getAll().items.find((i) => i.id === globalItem.id)!;
    assert.strictEqual(
      untouched.collectionId,
      globalCollection.id,
      'an untargeted drop of a global-scope payload must refuse, not fall back to the workspace root'
    );
    assert.strictEqual(store.getAll().items.length, 1, 'the workspace store must be untouched');
  });

  test('a workspace-scope envelope dropped on a global collection is a no-op in both stores', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();
    const globalCollection = await globalStore.addCollection('GlobalCol');
    const workspaceItem = await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });

    const targetNode: BookmarkNode = { kind: 'collection', collection: globalCollection, scope: 'global' };
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer('workspace', [workspaceItem.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === workspaceItem.id)!;
    assert.strictEqual(untouched.collectionId, null, 'the workspace item must not move into the global collection');
    assert.strictEqual(
      globalStore.getAll().items.length,
      0,
      'nothing may be created in the global store by a refused cross-scope drop'
    );
  });

  test('a workspace-scope envelope dropped on the Global row is a no-op in both stores', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();
    const workspaceItem = await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });

    const rootChildren = await provider.getChildren();
    const globalRootNode = rootChildren.find((n) => n.kind === 'globalRoot')!;
    assert.ok(globalRootNode, 'expected a Global row to drop onto');

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(globalRootNode, makeDropTransfer('workspace', [workspaceItem.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === workspaceItem.id)!;
    assert.strictEqual(untouched.collectionId, null, 'a workspace-scoped payload must not be absorbed into the global store');
    assert.strictEqual(untouched.order, 0, 'the workspace item must not have been moved at all');
    assert.strictEqual(globalStore.getAll().items.length, 0, 'nothing may be created in the global store');
  });

  test('a global-scope envelope is a no-op when the provider has no globalStore (defensive)', async () => {
    const { store, provider } = await makeProvider();
    const workspaceItem = await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    // Not reachable via the real UI (handleDrag can't produce a global envelope without a global
    // store), but handleDrop must still defend against it rather than throwing or falling through
    // to the workspace store.
    await provider.handleDrop(undefined, makeDropTransfer('global', [workspaceItem.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === workspaceItem.id)!;
    assert.strictEqual(untouched.collectionId, null);
    assert.strictEqual(untouched.order, 0, 'the workspace store must not be mistakenly used as the fallback for a global envelope');
  });
});

suite('BookmarksTreeDataProvider - descriptions', () => {
  test('an item with a description gets a tooltip containing both the path and the description', async () => {
    const store = await createSingleRootFixtureStore();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'the entrypoint');
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: true })));

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(typeof treeItem.tooltip, 'string');
    assert.ok((treeItem.tooltip as string).includes('the entrypoint'));
    assert.ok((treeItem.tooltip as string).includes('a.txt'));
  });

  test('an item without a description leaves the tooltip undefined (default path hover survives)', async () => {
    const store = await createSingleRootFixtureStore();
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: true })));

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.tooltip, undefined);
  });

  test('a description never displaces the repo-name badge in TreeItem.description', async () => {
    const store = await createSingleRootFixtureStore();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'the entrypoint');
    const provider = new BookmarksTreeDataProvider(
      store,
      new FsGitCache(async () => ({ exists: true, repoName: 'repo-a' }))
    );

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.description, 'repo-a');
  });

  test('a description never displaces the "missing" badge on a broken bookmark', async () => {
    const store = await createSingleRootFixtureStore();
    const item = await store.addItem({ type: 'file', uri: 'file:///gone.txt' });
    await store.setItemDescription(item.id, 'was here');
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: false })));

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.description, 'missing');
    assert.ok((treeItem.tooltip as string).includes('was here'));
  });

  test('a collection with a description gets it as the tooltip; without one the tooltip is undefined', async () => {
    const store = await createSingleRootFixtureStore();
    const collection = await store.addCollection('Work');
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: true })));

    const before = await provider.getTreeItem({ kind: 'collection', collection: store.getAll().collections[0], scope: 'workspace', owner: SINGLE_ROOT_OWNER });
    assert.strictEqual(before.tooltip, undefined);

    await store.setCollectionDescription(collection.id, 'work-related bookmarks');
    const after = await provider.getTreeItem({ kind: 'collection', collection: store.getAll().collections[0], scope: 'workspace', owner: SINGLE_ROOT_OWNER });
    assert.strictEqual(after.tooltip, 'work-related bookmarks');
  });
});

// --- T3: pinned Global row -------------------------------------------------------------------

function findGlobalRoot(nodes: BookmarkNode[]): BookmarkNode | undefined {
  return nodes.find((n) => n.kind === 'globalRoot');
}

/** The root children other than the pinned Global row. */
function excludeGlobalRoot(nodes: BookmarkNode[]): BookmarkNode[] {
  return nodes.filter((n) => n.kind !== 'globalRoot');
}

async function makeProviderWithGlobal(
  resolve: (uri: string) => Promise<{ exists: boolean; repoName?: string }> = async () => ({ exists: true }),
  getWorkspaceFolders?: () => readonly vscode.WorkspaceFolder[] | undefined
) {
  const store = await createSingleRootFixtureStore();
  const globalStore = new BookmarkStore(new FakeMemento());
  const cache = new FsGitCache(resolve);
  const provider = getWorkspaceFolders
    ? new BookmarksTreeDataProvider(store, cache, globalStore, getWorkspaceFolders)
    : new BookmarksTreeDataProvider(store, cache, globalStore);
  return { store, globalStore, cache, provider };
}

suite('BookmarksTreeDataProvider - Global row (T3)', () => {
  test('omitting globalStore leaves root children unaffected — no Global row is synthesized (regression guard)', async () => {
    const { store, provider } = await makeProvider();
    await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const children = await provider.getChildren();

    assert.strictEqual(children.length, 3, "today's child count must be unchanged when no globalStore is passed");
    assert.deepStrictEqual(children.map((n) => n.kind), ['collection', 'item', 'item']);
    assert.ok(
      children.every((n) => n.kind !== 'globalRoot'),
      'omitting globalStore must never synthesize a Global row'
    );
  });

  test('a globalStore constructor argument produces a Global row, positioned first among root children, even when both stores are empty', async () => {
    const { provider } = await makeProviderWithGlobal();

    const children = await provider.getChildren();

    assert.ok(children.length > 0, 'the Global row must be present even when both stores are empty');
    const globalRootNode = findGlobalRoot(children);
    assert.ok(globalRootNode, 'expected a node with kind "globalRoot" among root children');
    assert.strictEqual(children[0].kind, 'globalRoot', 'the Global row must be the first root child');
  });

  test('the Global row tree item carries contextValue "bookmarkGlobalRoot"', async () => {
    const { provider } = await makeProviderWithGlobal();

    const children = await provider.getChildren();
    const globalRootNode = findGlobalRoot(children);
    assert.ok(globalRootNode, 'expected a Global row to fetch a tree item for');

    const treeItem = await provider.getTreeItem(globalRootNode);
    assert.strictEqual(treeItem.contextValue, 'bookmarkGlobalRoot');
  });

  test('the Global row is still present and first even when the workspace store already has content', async () => {
    const { store, provider } = await makeProviderWithGlobal();
    await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const children = await provider.getChildren();
    assert.strictEqual(children[0].kind, 'globalRoot');
  });

  test('global collections and items render only under the Global row, tagged scope "global"', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();

    await store.addCollection('WorkCol');
    await store.addItem({ type: 'file', uri: 'file:///workspace-root.txt' });

    const globalCollection = await globalStore.addCollection('GlobalCol');
    const globalCollectionItem = await globalStore.addItem({
      type: 'file',
      uri: 'file:///global-in-collection.txt',
      collectionId: globalCollection.id
    });
    const globalRootItem = await globalStore.addItem({ type: 'file', uri: 'file:///global-root.txt' });

    const rootChildren = await provider.getChildren();
    const globalRootNode = findGlobalRoot(rootChildren);
    assert.ok(globalRootNode, 'expected a Global row among root children');

    // Global content must never leak into the workspace-scoped root children.
    for (const n of excludeGlobalRoot(rootChildren)) {
      if (n.kind === 'collection') {
        assert.notStrictEqual(n.collection.id, globalCollection.id, 'the global collection must not appear in workspace root children');
      }
      if (n.kind === 'item') {
        assert.notStrictEqual(n.item.id, globalRootItem.id, 'the global item must not appear in workspace root children');
      }
    }

    const globalChildren = await provider.getChildren(globalRootNode);
    assert.strictEqual(globalChildren.length, 2, 'the Global row must list the global collection and the global root item');

    const globalCollectionNode = globalChildren.find((n) => n.kind === 'collection');
    assert.ok(globalCollectionNode && globalCollectionNode.kind === 'collection');
    assert.strictEqual(globalCollectionNode.collection.id, globalCollection.id);
    assert.strictEqual(globalCollectionNode.scope, 'global', 'a collection rendered under the Global row must be tagged scope "global"');

    const globalItemNode = globalChildren.find((n) => n.kind === 'item');
    assert.ok(globalItemNode && globalItemNode.kind === 'item');
    assert.strictEqual(globalItemNode.item.id, globalRootItem.id);
    assert.strictEqual(globalItemNode.scope, 'global', 'an item rendered under the Global row must be tagged scope "global"');

    const itemsInGlobalCollection = await provider.getChildren(globalCollectionNode);
    assert.strictEqual(itemsInGlobalCollection.length, 1);
    assert.strictEqual(itemsInGlobalCollection[0].kind, 'item');
    assert.strictEqual((itemsInGlobalCollection[0] as { item: { id: string } }).item.id, globalCollectionItem.id);
    assert.strictEqual((itemsInGlobalCollection[0] as { scope: string }).scope, 'global');
  });

  test("workspace collections and items never leak into the Global row's children", async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal();

    const workspaceCollection = await store.addCollection('WorkCol');
    const workspaceCollectionItem = await store.addItem({
      type: 'file',
      uri: 'file:///workspace-in-collection.txt',
      collectionId: workspaceCollection.id
    });
    const workspaceRootItem = await store.addItem({ type: 'file', uri: 'file:///workspace-root.txt' });
    await globalStore.addItem({ type: 'file', uri: 'file:///global-root.txt' });

    const rootChildren = await provider.getChildren();
    const globalRootNode = findGlobalRoot(rootChildren);
    assert.ok(globalRootNode, 'expected a Global row among root children');

    const globalChildren = await provider.getChildren(globalRootNode);

    // Pin the positive shape first, so this test cannot pass vacuously on an empty result — an
    // implementation that (bug) returns [] for the Global row's children would otherwise sail
    // through the leak checks below with nothing to check.
    assert.strictEqual(globalChildren.length, 1, 'the Global row must list exactly the one global root item');
    assert.strictEqual(globalChildren[0].kind, 'item');
    assert.strictEqual((globalChildren[0] as { item: { uri: string } }).item.uri, 'file:///global-root.txt');

    for (const n of globalChildren) {
      if (n.kind === 'collection') {
        assert.notStrictEqual(n.collection.id, workspaceCollection.id, "the workspace collection must not appear under the Global row");
      }
      if (n.kind === 'item') {
        assert.notStrictEqual(n.item.id, workspaceRootItem.id, "the workspace root item must not appear under the Global row");
        assert.notStrictEqual(n.item.id, workspaceCollectionItem.id, "the workspace collection item must not appear under the Global row");
      }
    }
  });

  test("changes to the global store fire onDidChangeTreeData and invalidate the cache, independent of the workspace store's subscription", async () => {
    let resolveCalls = 0;
    const { store, globalStore, provider } = await makeProviderWithGlobal(async () => {
      resolveCalls++;
      return { exists: true };
    });

    const globalItem = await globalStore.addItem({ type: 'file', uri: 'file:///global-a.txt' });
    await provider.getTreeItem({ kind: 'item', item: globalItem, scope: 'global' });
    assert.strictEqual(resolveCalls, 1);

    let redraws = 0;
    provider.onDidChangeTreeData(() => {
      redraws++;
    });

    // Mutate only the global store — the workspace store is never touched in this test, so a
    // redraw here can only be explained by a subscription to the global store's own event.
    await globalStore.addItem({ type: 'file', uri: 'file:///global-b.txt' });

    assert.strictEqual(redraws, 1, 'a change to the global store alone must trigger a tree refresh');
    assert.strictEqual(store.getAll().items.length, 0, 'sanity check: the workspace store was never mutated in this test');

    await provider.getTreeItem({ kind: 'item', item: globalItem, scope: 'global' });
    assert.strictEqual(resolveCalls, 2, 'the cache must be invalidated when the global store changes, same as for the workspace store');

    // Prove the workspace subscription still fires too — a "swap" implementation that subscribes
    // to globalStore *instead of* store when the third constructor argument is present would
    // satisfy every assertion above while breaking this one.
    await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });
    assert.strictEqual(redraws, 2, 'the workspace store subscription must keep firing alongside the global store subscription');
  });

  test('in byRepo mode, the workspace section groups by repo while the Global row stays flat and ungrouped', async () => {
    const { store, globalStore, provider } = await makeProviderWithGlobal(async (uri) => ({
      exists: true,
      repoName: uri.includes('repo-a') ? 'repo-a' : uri.includes('repo-b') ? 'repo-b' : undefined
    }));
    provider.setGroupMode('byRepo');

    await store.addItem({ type: 'file', uri: 'file:///repo-a/workspace.txt' });
    await store.addItem({ type: 'file', uri: 'file:///repo-b/workspace.txt' });

    const globalCollection = await globalStore.addCollection('GlobalCol');
    // Deliberately resolvable to repo-a, to prove the Global row does not participate in
    // group-by-repo even when its content *could* be grouped (D4-A).
    const globalItem = await globalStore.addItem({
      type: 'file',
      uri: 'file:///repo-a/global.txt',
      collectionId: globalCollection.id
    });

    const rootChildren = await provider.getChildren();
    const globalRootNode = findGlobalRoot(rootChildren);
    assert.ok(globalRootNode, 'expected a Global row among root children even in byRepo mode');

    const workspaceSection = excludeGlobalRoot(rootChildren);
    assert.strictEqual(workspaceSection.length, 2, 'repo-a and repo-b workspace groups');
    assert.ok(
      workspaceSection.every((n) => n.kind === 'repoGroup'),
      'the workspace section must still group by repo in byRepo mode'
    );
    assert.ok(
      workspaceSection.every((n) => n.kind !== 'repoGroup' || n.label !== 'GlobalCol'),
      'the global collection must not surface as a workspace repo group'
    );

    // The global item's uri is deliberately resolvable to repo-a — drill into that group and
    // prove the global collection/item were not folded into it (D4-A). A shallow check on the
    // root-level repoGroup labels alone cannot catch this: it would still pass even if the leak
    // happened one level down, inside repo-a's own children.
    const repoAGroup = workspaceSection.find((n) => n.kind === 'repoGroup' && n.label === 'repo-a');
    assert.ok(repoAGroup, 'expected a repo-a workspace group');
    const repoAChildren = await provider.getChildren(repoAGroup!);
    assert.strictEqual(repoAChildren.length, 1, 'repo-a must hold only the workspace item, not the global one');
    assert.ok(
      repoAChildren.every((n) => n.kind !== 'item' || n.item.id !== globalItem.id),
      'a global item must never be folded into a workspace repo group (D4-A)'
    );
    assert.ok(
      repoAChildren.every((n) => n.kind !== 'collection' || n.collection.id !== globalCollection.id),
      'a global collection must never be nested inside a workspace repo group (D4-A)'
    );

    const globalChildren = await provider.getChildren(globalRootNode);
    assert.ok(
      globalChildren.every((n) => n.kind === 'collection' || n.kind === 'item'),
      "the Global row's children must stay in the default (collection/item) layout, never repoGroup, regardless of the group-by-repo toggle"
    );
    assert.strictEqual(globalChildren.length, 1, 'only the global collection sits at the Global row root; the global item is nested inside it');

    const globalCollectionNode = globalChildren[0];
    assert.ok(globalCollectionNode.kind === 'collection');
    assert.strictEqual(globalCollectionNode.collection.id, globalCollection.id);

    const itemsInGlobalCollection = await provider.getChildren(globalCollectionNode);
    assert.strictEqual(itemsInGlobalCollection.length, 1);
    assert.strictEqual(itemsInGlobalCollection[0].kind, 'item');
    assert.strictEqual((itemsInGlobalCollection[0] as { item: { id: string } }).item.id, globalItem.id);
  });
});

// --- T9: "addable" contextValue for global folders outside the current workspace (#56) --------
//
// A global-scoped *folder* bookmark whose target directory is not already part of the current
// workspace gets a distinct contextValue so a future "Add to Workspace" command (T10) can target
// it via a `view/item/context` `when` clause. Every other combination (workspace-scoped items,
// global files, global folders already inside the workspace) keeps today's plain 'bookmarkItem'.

/** Builds a `vscode.WorkspaceFolder`-shaped fixture, mirroring workspaceFolders.test.ts's `folder()`. */
function workspaceFolder(uri: vscode.Uri, name = 'workspace-folder', index = 0): vscode.WorkspaceFolder {
  return { uri, name, index };
}

suite('BookmarksTreeDataProvider - addable contextValue for global folders (T9)', () => {
  test('a global folder bookmark outside every workspace folder gets the addable contextValue', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/other-project'))];
    const { globalStore, provider } = await makeProviderWithGlobal(undefined, () => folders);
    const item = await globalStore.addItem({ type: 'folder', uri: 'file:///global/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem-addable');
  });

  test('a global folder bookmark already inside a workspace folder keeps the plain contextValue', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/global/some-repo'))];
    const { globalStore, provider } = await makeProviderWithGlobal(undefined, () => folders);
    const item = await globalStore.addItem({ type: 'folder', uri: 'file:///global/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem');
  });

  test('a global file bookmark outside every workspace folder never gets the addable contextValue', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/other-project'))];
    const { globalStore, provider } = await makeProviderWithGlobal(undefined, () => folders);
    const item = await globalStore.addItem({ type: 'file', uri: 'file:///global/some-file.txt' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem', 'files can never be added as a workspace folder');
  });

  test('a workspace-scoped folder bookmark outside every current workspace folder is still never addable', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/other-project'))];
    const { store, provider } = await makeProviderWithGlobal(undefined, () => folders);
    const item = await store.addItem({ type: 'folder', uri: 'file:///workspace/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(
      treeItem.contextValue,
      'bookmarkItem',
      'workspace-scoped items are never addable, regardless of where their target sits'
    );
  });

  test('a global folder bookmark gets the addable contextValue when no workspace is open at all (folders undefined)', async () => {
    const { globalStore, provider } = await makeProviderWithGlobal(undefined, () => undefined);
    const item = await globalStore.addItem({ type: 'folder', uri: 'file:///global/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem-addable', 'an empty window (no workspace) still counts as "outside"');
  });

  test('a global folder bookmark gets the addable contextValue when the workspace folder list is empty', async () => {
    const { globalStore, provider } = await makeProviderWithGlobal(undefined, () => []);
    const item = await globalStore.addItem({ type: 'folder', uri: 'file:///global/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem-addable');
  });
});

// --- #95: Suggested bookmarks from recently opened items ---------------------------------------
//
// Plan: docs/superpowers/plans/2026-08-25-suggested-bookmarks-from-recent-items.md, T5.
// New node kinds:
//   { kind: 'suggestedRoot' }
//   { kind: 'suggestion'; recentItem: RecentItem }
// The constructor gains a 5th, optional `suggestions` argument — `{ getRecentItems, maxItems }` —
// so every existing call site above (none of which pass it) keeps compiling and behaving exactly
// as before: omitting it means the Suggested row is never synthesized. This is additive, not a
// breaking change to anything above this comment.
//
// `src/recentItems.ts` does not exist yet, so the `RecentItem` import above — and every test in
// this section — is expected to fail to compile until T2 adds it.

function recentItem(overrides: Partial<RecentItem> = {}): RecentItem {
  return {
    uri: 'file:///suggested-a.txt',
    firstSeen: 1000,
    previewCount: 0,
    promoted: true,
    ...overrides
  };
}

async function makeProviderWithSuggestions(
  recentItems: RecentItem[],
  maxItems = 10,
  options: {
    resolve?: (uri: string) => Promise<{ exists: boolean; repoName?: string }>;
    globalStore?: BookmarkStore;
  } = {}
) {
  const store = await createSingleRootFixtureStore();
  const cache = new FsGitCache(options.resolve ?? (async () => ({ exists: true })));
  const provider = new BookmarksTreeDataProvider(store, cache, options.globalStore, undefined, {
    getRecentItems: () => recentItems,
    maxItems
  });
  return { store, cache, provider };
}

function findSuggestedRoot(nodes: BookmarkNode[]): BookmarkNode | undefined {
  return nodes.find((n) => n.kind === 'suggestedRoot');
}

suite('BookmarksTreeDataProvider - suggested bookmarks (#95)', () => {
  test('omitting the suggestions option leaves root children unaffected — no Suggested row is synthesized (regression guard)', async () => {
    const { provider } = await makeProvider(); // the pre-#95 constructor call shape, unchanged
    const children = await provider.getChildren();
    assert.ok(children.every((n) => n.kind !== 'suggestedRoot'));
  });

  test('the Suggested row is absent when there are zero promoted recent items', async () => {
    const { provider } = await makeProviderWithSuggestions([recentItem({ promoted: false, previewCount: 1 })]);
    const children = await provider.getChildren();
    assert.strictEqual(
      findSuggestedRoot(children),
      undefined,
      'a preview-only (unpromoted) entry must not surface a Suggested row'
    );
  });

  test('the Suggested row appears, positioned last, when at least one promoted suggestion exists (D8)', async () => {
    const { provider } = await makeProviderWithSuggestions([recentItem()]);
    const children = await provider.getChildren();
    assert.strictEqual(children[children.length - 1].kind, 'suggestedRoot');
  });

  test('the Suggested row sits below the Global row when both are present (D8)', async () => {
    const globalStore = new BookmarkStore(new FakeMemento());
    const { provider } = await makeProviderWithSuggestions([recentItem()], 10, { globalStore });
    const children = await provider.getChildren();
    assert.strictEqual(children[0].kind, 'globalRoot');
    assert.strictEqual(children[children.length - 1].kind, 'suggestedRoot');
  });

  test('the Suggested row still appears last in byRepo mode (D8: present in both group modes)', async () => {
    const { store, provider } = await makeProviderWithSuggestions([recentItem()]);
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///bookmarked.txt' });

    const children = await provider.getChildren();
    assert.strictEqual(children[children.length - 1].kind, 'suggestedRoot');
  });

  test('the Suggested row tree item defaults to collapsed (D8)', async () => {
    const { provider } = await makeProviderWithSuggestions([recentItem()]);
    const children = await provider.getChildren();
    const node = findSuggestedRoot(children)!;
    const treeItem = await provider.getTreeItem(node);
    assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  });

  test('a suggestion leaf tree item opens the file directly and carries the bookmarkSuggestion contextValue (T5)', async () => {
    const uri = 'file:///suggested-a.txt';
    const { provider } = await makeProviderWithSuggestions([recentItem({ uri })]);
    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);
    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].kind, 'suggestion');

    const treeItem = await provider.getTreeItem(leaves[0]);
    assert.strictEqual(treeItem.contextValue, 'bookmarkSuggestion');
    assert.strictEqual(treeItem.resourceUri?.toString(), uri);
    assert.strictEqual(treeItem.command?.command, 'vscode.open');
    assert.strictEqual((treeItem.command?.arguments?.[0] as vscode.Uri).toString(), uri);
  });

  test('getChildren for the Suggested row excludes a uri already bookmarked in the workspace store (C7/D9)', async () => {
    const bookmarkedUri = 'file:///already.txt';
    const otherUri = 'file:///still-suggested.txt';
    const { store, provider } = await makeProviderWithSuggestions([
      recentItem({ uri: bookmarkedUri, firstSeen: 100 }),
      recentItem({ uri: otherUri, firstSeen: 200 })
    ]);
    await store.addItem({ type: 'file', uri: bookmarkedUri });

    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);

    assert.strictEqual(leaves.length, 1);
    assert.strictEqual((leaves[0] as unknown as { recentItem: RecentItem }).recentItem.uri, otherUri);
  });

  test('getChildren for the Suggested row excludes a uri already bookmarked in the global store (D9: either store)', async () => {
    const bookmarkedUri = 'file:///already-global.txt';
    const otherUri = 'file:///still-suggested.txt';
    const globalStore = new BookmarkStore(new FakeMemento());
    await globalStore.addItem({ type: 'file', uri: bookmarkedUri });

    const { provider } = await makeProviderWithSuggestions(
      [recentItem({ uri: bookmarkedUri, firstSeen: 100 }), recentItem({ uri: otherUri, firstSeen: 200 })],
      10,
      { globalStore }
    );

    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);

    assert.strictEqual(leaves.length, 1);
    assert.strictEqual((leaves[0] as unknown as { recentItem: RecentItem }).recentItem.uri, otherUri);
  });

  test('getChildren for the Suggested row never includes a non-promoted (preview-only) entry', async () => {
    const { provider } = await makeProviderWithSuggestions([
      recentItem({ uri: 'file:///promoted.txt', promoted: true, firstSeen: 100 }),
      recentItem({ uri: 'file:///preview-only.txt', promoted: false, previewCount: 1, firstSeen: 200 })
    ]);

    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);

    assert.strictEqual(leaves.length, 1);
    assert.strictEqual((leaves[0] as unknown as { recentItem: RecentItem }).recentItem.uri, 'file:///promoted.txt');
  });

  test('getChildren for the Suggested row is capped by maxItems, keeping the most-recently-first-seen entries (D3/D6)', async () => {
    const { provider } = await makeProviderWithSuggestions(
      [
        recentItem({ uri: 'file:///oldest.txt', firstSeen: 100 }),
        recentItem({ uri: 'file:///middle.txt', firstSeen: 200 }),
        recentItem({ uri: 'file:///newest.txt', firstSeen: 300 })
      ],
      2
    );

    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);

    const uris = leaves.map((n) => (n as unknown as { recentItem: RecentItem }).recentItem.uri).sort();
    assert.deepStrictEqual(uris, ['file:///middle.txt', 'file:///newest.txt'].sort());
  });

  test('a maxItems of 0 hides the Suggested row entirely, even with promoted entries present (D3)', async () => {
    const { provider } = await makeProviderWithSuggestions([recentItem()], 0);
    const children = await provider.getChildren();
    assert.strictEqual(findSuggestedRoot(children), undefined);
  });

  test('suggestion leaves render most-recently-first-seen first (D6 sort)', async () => {
    const { provider } = await makeProviderWithSuggestions([
      recentItem({ uri: 'file:///older.txt', firstSeen: 100 }),
      recentItem({ uri: 'file:///newer.txt', firstSeen: 200 })
    ]);

    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);

    assert.deepStrictEqual(
      leaves.map((n) => (n as unknown as { recentItem: RecentItem }).recentItem.uri),
      ['file:///newer.txt', 'file:///older.txt']
    );
  });
});

// --- #115: "Toggle Show Full Path" ---------------------------------------------------------
//
// Adds `provider.getShowFullPath()` / `provider.setShowFullPath(boolean)`, mirroring the existing
// `getGroupMode()` / `setGroupMode()` pair exactly (default off, in-memory flag, no store
// mutation). `src/bookmarksTreeDataProvider.ts` does not have these members yet, so this whole
// suite — and every suite below it in this file — is expected to fail to compile until they are
// added, matching this file's own precedent for introducing new provider API (see the header
// comments above the #95 and #108 suites).
//
// Design decisions this test-implementer is pinning (none of these are stated by issue #115
// itself, so flag them for router/implementer confirmation):
//
//   1. Slot: the relative path replaces `TreeItem.label`, never `TreeItem.description`. The
//      "descriptions" suite above already pins `description` to the repo-name badge / "missing"
//      badge, so `label` is the only free slot — using `description` would contradict tests this
//      implementer cannot edit. See "does not displace" tests below for the explicit AC-2 pin.
//   2. Path separator: labels always use `/`, even on Windows (`path.relative` would otherwise
//      yield `src\index.ts` on a Windows CI/dev box). Assert the POSIX form explicitly.
//   3. Fallback rule is per-URI, not per-scope: "no workspace root to be relative to" means the
//      bookmark's own URI falls outside every current `getWorkspaceFolders()` entry — checked with
//      the same `getWorkspaceFolders` DI seam the T9 suite above already uses (an *empty* or
//      *undefined* folder list, or a URI outside every folder, all count as "no root"). A
//      global-scoped bookmark *inside* a workspace folder still gets a relative path; a
//      workspace-scoped bookmark *outside* every folder still falls back to filename-only. The
//      fallback display is filename-only (the pre-#115 baseline), not the absolute path.
//   4. Persistence seam (AC: "Toggle state persists across window reloads, matching existing
//      toggleGroupByRepo persistence behavior"): no test anywhere in this suite (checked) actually
//      exercises `groupMode` surviving a reload — `registerViewCommands` is only ever exercised
//      with a bare `{ subscriptions }` stub context (see commands.test.ts), so there is nothing to
//      literally mirror. This test-implementer invents the minimal seam instead: an *optional 7th
//      constructor argument*, `viewState?: vscode.Memento` (after `recentlyViewed`), matching this
//      file's existing convention of additive optional DI params (`globalStore`,
//      `getWorkspaceFolders`, `suggestions`, `recentlyViewed`). `setShowFullPath()` writes through
//      to `viewState` (key/shape left to the implementer); the constructor reads the persisted
//      value back if `viewState` is supplied. Omitting `viewState` must keep working exactly like
//      today (in-memory only, default off) — every existing call site above passes none of the new
//      args and must keep compiling and behaving unchanged.

suite('BookmarksTreeDataProvider - show full path toggle (#115)', () => {
  test('defaults to off', async () => {
    const { provider } = await makeProvider();
    assert.strictEqual(provider.getShowFullPath(), false);
  });

  test('sanity: toggle off keeps the pre-#115 filename-only label unchanged', async () => {
    const { store, provider } = await makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///workspace/repo-a/src/index.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.label, 'index.ts');
  });

  test('toggle on: label becomes the path relative to the workspace root, using "/" separators', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/repo-a'))];
    const { store, provider } = await makeProviderWithGlobal(undefined, () => folders);
    provider.setShowFullPath(true);
    const item = await store.addItem({ type: 'file', uri: 'file:///workspace/repo-a/src/index.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.label, 'src/index.ts');
  });

  test('toggle on + Group by Repo: relative-path label has no duplicated repo-name prefix (AC-2)', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/repo-a'))];
    const { store, provider } = await makeProviderWithGlobal(async () => ({ exists: true, repoName: 'repo-a' }), () => folders);
    provider.setGroupMode('byRepo');
    provider.setShowFullPath(true);
    await store.addItem({ type: 'file', uri: 'file:///workspace/repo-a/src/index.ts' });

    const roots = await provider.getChildren();
    const repoGroup = roots.find((n) => n.kind === 'repoGroup' && (n as { label: string }).label === 'repo-a')!;
    assert.ok(repoGroup, 'expected a repo-a group to drill into');
    const children = await provider.getChildren(repoGroup);
    assert.strictEqual(children.length, 1);
    const treeItem = await provider.getTreeItem(children[0]);

    assert.strictEqual(treeItem.label, 'src/index.ts');
    assert.ok(
      !(treeItem.label as string).startsWith('repo-a'),
      'the relative-path label must not repeat the repo-name prefix the Group-by-Repo grouping already shows'
    );
  });

  test('toggle on does not displace the repo-name description badge', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/repo-a'))];
    const { store, provider } = await makeProviderWithGlobal(async () => ({ exists: true, repoName: 'repo-a' }), () => folders);
    provider.setShowFullPath(true);
    const item = await store.addItem({ type: 'file', uri: 'file:///workspace/repo-a/src/index.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.label, 'src/index.ts');
    assert.strictEqual(treeItem.description, 'repo-a', 'the repo-name description badge must survive the full-path toggle');
  });

  test('toggle on does not displace the "missing" description badge', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/repo-a'))];
    const { store, provider } = await makeProviderWithGlobal(async () => ({ exists: false }), () => folders);
    provider.setShowFullPath(true);
    const item = await store.addItem({ type: 'file', uri: 'file:///workspace/repo-a/gone.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.description, 'missing', 'the "missing" badge must survive the full-path toggle');
  });

  test('toggle on, no workspace root available (folders undefined): falls back to filename-only (D-115.3)', async () => {
    const { store, provider } = await makeProviderWithGlobal(undefined, () => undefined);
    provider.setShowFullPath(true);
    const item = await store.addItem({ type: 'file', uri: 'file:///anywhere/index.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.label, 'index.ts');
  });

  test('toggle on, empty workspace folder list: falls back to filename-only', async () => {
    const { store, provider } = await makeProviderWithGlobal(undefined, () => []);
    provider.setShowFullPath(true);
    const item = await store.addItem({ type: 'file', uri: 'file:///anywhere/index.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.label, 'index.ts');
  });

  test('toggle on: a global-scoped bookmark inside a current workspace folder still gets a relative-path label (fallback is per-URI, not per-scope)', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/repo-a'))];
    const { globalStore, provider } = await makeProviderWithGlobal(undefined, () => folders);
    provider.setShowFullPath(true);
    const item = await globalStore.addItem({ type: 'file', uri: 'file:///workspace/repo-a/src/util.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.label, 'src/util.ts');
  });

  test('toggle on: a workspace-scoped bookmark outside every workspace folder falls back to filename-only', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/repo-a'))];
    const { store, provider } = await makeProviderWithGlobal(undefined, () => folders);
    provider.setShowFullPath(true);
    const item = await store.addItem({ type: 'file', uri: 'file:///elsewhere/outside.ts' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER });

    assert.strictEqual(treeItem.label, 'outside.ts');
  });

  test('setShowFullPath persists through an optional viewState memento, read back by a freshly constructed provider (simulated reload)', async () => {
    const viewState = new FakeMemento();
    const store = await createSingleRootFixtureStore();
    const cache = new FsGitCache(async () => ({ exists: true }));

    const provider1 = new BookmarksTreeDataProvider(store, cache, undefined, undefined, undefined, undefined, viewState);
    assert.strictEqual(provider1.getShowFullPath(), false);
    provider1.setShowFullPath(true);
    assert.strictEqual(provider1.getShowFullPath(), true);

    // Simulated reload: a brand-new provider instance over the *same* viewState memento (a fresh
    // provider over a fresh memento, by contrast, must come back false — checked below).
    const provider2 = new BookmarksTreeDataProvider(store, cache, undefined, undefined, undefined, undefined, viewState);
    assert.strictEqual(
      provider2.getShowFullPath(),
      true,
      'a freshly constructed provider must read the persisted toggle state back from viewState'
    );
  });

  test('omitting viewState leaves the toggle in-memory only — no persistence, no throw (regression guard)', async () => {
    const { provider } = await makeProvider(); // the pre-#115 constructor call shape, unchanged
    provider.setShowFullPath(true);
    assert.strictEqual(provider.getShowFullPath(), true, 'in-memory toggling must still work with no viewState supplied');
  });
});

// --- CodeRabbit finding (PR #103, bookmarksTreeDataProvider.ts review): stale persisted
// suggestion URIs -------------------------------------------------------------------------------
//
// `loadRecentItems` retains valid records after a file is deleted or renamed (D4, plan §4: the
// persisted list intentionally "can point at deleted/renamed files" — that's what makes it survive
// a window reload). Without an existence check at render time, a stale record still renders as a
// clickable Suggested leaf whose `vscode.open` command fails silently against a path that no
// longer exists.
//
// D4's staleness sub-decision was left open at implementation time (filter-at-render vs.
// prune-on-read; "pick exactly one, do not do both" — plan §4 D4). This test-implementer picks
// **filter-at-render via FsGitCache**, for reasons worth recording here since the plan explicitly
// deferred the choice:
//   - `FsGitCache` is already the existence-check seam this same file uses for bookmarked `item`
//     nodes (`getTreeItem`'s `entry.exists` branch, driving the "missing" warning icon) — reusing
//     it for suggestion nodes is the smallest, most consistent change, and the test fixture below
//     (`makeProviderWithSuggestions`'s `options.resolve`) already exists for exactly this purpose.
//   - `getChildren`/`getTreeItem` are already `async` and already `await this.cache.get(...)`
//     elsewhere in this class, so filtering at render composes with the existing shape without a
//     new synchronous/asynchronous seam.
//   - Prune-on-read would require turning the currently-synchronous, pure `loadRecentItems(memento)`
//     into an async, cache-dependent function that also re-persists on every read — a materially
//     larger change for the same observable, user-visible result (a stale suggestion never
//     appears), which the plan's D4 note treats as equivalent ("pick exactly one").
//
// These tests assert the observable outcome the CodeRabbit finding and the plan actually require:
// a persisted suggestion whose FsGitCache existence check resolves `exists: false` must not appear
// as a clickable Suggested leaf. They do not assert *how* the row/leaf list is assembled inside
// `getSuggestedLeaves`/`withRoots` (e.g. sync vs. async, exact intermediate shape). They do,
// however, pin filter-at-render specifically: `makeProviderWithSuggestions` injects
// `getRecentItems: () => recentItems` directly, bypassing `loadRecentItems(memento)` entirely, so
// a prune-on-read implementation (one that only prunes inside `loadRecentItems`) would leave these
// three tests failing — the provider itself must consult `FsGitCache` when consuming
// `getRecentItems()`'s result, which is the filter-at-render strategy chosen above.
suite('BookmarksTreeDataProvider - suggested bookmarks staleness filtering (CodeRabbit: stale persisted suggestion URIs)', () => {
  test('a persisted suggestion whose file no longer exists on disk is filtered out of the Suggested leaves', async () => {
    const staleUri = 'file:///deleted.txt';
    const validUri = 'file:///still-there.txt';
    const { provider } = await makeProviderWithSuggestions(
      [recentItem({ uri: staleUri, firstSeen: 100 }), recentItem({ uri: validUri, firstSeen: 200 })],
      10,
      { resolve: async (uri) => ({ exists: uri !== staleUri }) }
    );

    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);

    assert.strictEqual(leaves.length, 1, 'the stale (non-existent) suggestion must not render as a clickable node');
    assert.strictEqual((leaves[0] as unknown as { recentItem: RecentItem }).recentItem.uri, validUri);
  });

  test('when every persisted suggestion is stale, the Suggested row does not appear at all (D8: hidden when empty)', async () => {
    const staleUri = 'file:///deleted-only.txt';
    const { provider } = await makeProviderWithSuggestions([recentItem({ uri: staleUri })], 10, {
      resolve: async () => ({ exists: false })
    });

    const children = await provider.getChildren();
    assert.strictEqual(
      findSuggestedRoot(children),
      undefined,
      'a Suggested row with zero surviving (existing) suggestions must not render at all, matching ' +
        'the zero-promoted-items case'
    );
  });

  test('a stale suggestion is excluded before maxItems eviction, so it does not crowd out a valid entry that would otherwise be capped', async () => {
    const staleUri = 'file:///stale-cap.txt';
    const validA = 'file:///valid-a.txt';
    const validB = 'file:///valid-b.txt';
    const { provider } = await makeProviderWithSuggestions(
      [
        // Most recently first-seen, so a cap-then-filter (wrong order) would keep the stale entry
        // and evict a valid one; filter-then-cap (required) must not.
        recentItem({ uri: staleUri, firstSeen: 300 }),
        recentItem({ uri: validA, firstSeen: 200 }),
        recentItem({ uri: validB, firstSeen: 100 })
      ],
      2,
      { resolve: async (uri) => ({ exists: uri !== staleUri }) }
    );

    const rootChildren = await provider.getChildren();
    const suggestedRoot = findSuggestedRoot(rootChildren)!;
    const leaves = await provider.getChildren(suggestedRoot);
    const uris = leaves.map((n) => (n as unknown as { recentItem: RecentItem }).recentItem.uri).sort();

    assert.deepStrictEqual(
      uris,
      [validA, validB].sort(),
      'stale entries must be excluded before the maxItems cap is applied, not counted against it'
    );
  });
});

// --- #95 R4: regression guards for the widened BookmarkNode union at the four kind-switching
// sites the plan names — handleDrag / handleDrop here; createRemoveHandler / createRevealHandler
// in commands.test.ts. Each new-kind node is built with `as unknown as BookmarkNode` so this file
// compiles against both today's four-arm union and the widened one from T5 — these prove today's
// behavior already guards against the new kind (a widened union making a `switch`/`if` chain
// silently fall through), rather than being expected to start red.
suite('BookmarksTreeDataProvider - suggestion-kind regression guards (#95 R4)', () => {
  function suggestionNode(uri = 'file:///suggested.txt'): BookmarkNode {
    return { kind: 'suggestion', recentItem: recentItem({ uri }) } as unknown as BookmarkNode;
  }
  function suggestedRootNode(): BookmarkNode {
    return { kind: 'suggestedRoot' } as unknown as BookmarkNode;
  }

  test('handleDrag ignores a suggestion node mixed into an otherwise-draggable selection', async () => {
    const { store, provider } = await makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag([{ kind: 'item', item, scope: 'workspace', owner: SINGLE_ROOT_OWNER }, suggestionNode()], dt, token);

    const envelope = getTransferEnvelope(dt);
    assert.ok(envelope, 'the real item must still be draggable despite the mixed-in suggestion node');
    assert.deepStrictEqual(envelope!.ids, [item.id]);
  });

  test('handleDrag on an all-suggestion selection sets no transfer data', async () => {
    const { provider } = await makeProvider();
    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag([suggestionNode('file:///a.txt'), suggestionNode('file:///b.txt')], dt, token);
    assert.strictEqual(dt.get(DND_MIME_TYPE), undefined);
  });

  test('handleDrop on a suggestion node target is a no-op', async () => {
    const { store, provider } = await makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(suggestionNode(), makeDropTransfer('workspace', [item.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === item.id)!;
    assert.strictEqual(untouched.collectionId, null);
    assert.strictEqual(untouched.order, 0, 'a suggestion node is not a valid drop target');
  });

  test('handleDrop on a suggestedRoot node target is a no-op', async () => {
    const { store, provider } = await makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(suggestedRootNode(), makeDropTransfer('workspace', [item.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === item.id)!;
    assert.strictEqual(untouched.collectionId, null);
    assert.strictEqual(untouched.order, 0, 'a suggestedRoot node is not a valid drop target');
  });
});

// --- #108: "Recent" root row from plain MRU recently-viewed uris -------------------------------
//
// New node kinds: { kind: 'recentRoot' } and { kind: 'recentItem'; uri: string }. The constructor
// gains a 6th, optional argument after `suggestions` — `recentlyViewed?: { getUris: () => string[] }`
// — a minimal DI seam with no `maxItems` field, since the cap is fixed (RECENTLY_VIEWED_MAX_ITEMS)
// and enforced entirely by `recentlyViewed.ts`'s `recordView`, not by the tree provider.
//
// `src/recentlyViewed.ts` does not exist yet, so this suite is expected to fail to compile until
// it is added.
//
// Deliberately does NOT test Recent's position in byRepo mode — the spec does not pin that, and
// inventing an assertion here would over-constrain the implementer beyond the contract.

function findRecentRoot(nodes: BookmarkNode[]): BookmarkNode | undefined {
  return nodes.find((n) => n.kind === 'recentRoot');
}

async function makeProviderWithRecentlyViewed(
  uris: string[],
  options: {
    resolve?: (uri: string) => Promise<{ exists: boolean; repoName?: string }>;
    globalStore?: BookmarkStore;
    suggestions?: { getRecentItems: () => RecentItem[]; maxItems: number };
  } = {}
) {
  const store = await createSingleRootFixtureStore();
  const cache = new FsGitCache(options.resolve ?? (async () => ({ exists: true })));
  const provider = new BookmarksTreeDataProvider(
    store,
    cache,
    options.globalStore,
    undefined,
    options.suggestions,
    { getUris: () => uris }
  );
  return { store, cache, provider };
}

suite('BookmarksTreeDataProvider - Recent row (#108)', () => {
  test('omitting the recentlyViewed option leaves root children unaffected — no Recent row is synthesized (regression guard)', async () => {
    const { provider } = await makeProvider(); // the pre-#108 constructor call shape, unchanged
    const children = await provider.getChildren();
    assert.ok(children.every((n) => n.kind !== 'recentRoot'));
  });

  test('the Recent row is absent when recentlyViewed.getUris() returns an empty list', async () => {
    const { provider } = await makeProviderWithRecentlyViewed([]);
    const children = await provider.getChildren();
    assert.strictEqual(findRecentRoot(children), undefined);
  });

  test('the Recent row appears when recentlyViewed.getUris() returns at least one uri', async () => {
    const { provider } = await makeProviderWithRecentlyViewed(['file:///recent-a.txt']);
    const children = await provider.getChildren();
    assert.ok(findRecentRoot(children), 'expected a recentRoot node among root children');
  });

  test('the Recent row is positioned after the Suggested row: Global, ...normal children, Suggested, Recent', async () => {
    const globalStore = new BookmarkStore(new FakeMemento());
    const store = await createSingleRootFixtureStore();
    const cache = new FsGitCache(async () => ({ exists: true }));
    const provider = new BookmarksTreeDataProvider(
      store,
      cache,
      globalStore,
      undefined,
      { getRecentItems: () => [recentItem()], maxItems: 10 },
      { getUris: () => ['file:///recent-a.txt'] }
    );
    await store.addItem({ type: 'file', uri: 'file:///bookmarked.txt' });

    const children = await provider.getChildren();

    const kinds = children.map((n) => n.kind);
    assert.strictEqual(kinds[0], 'globalRoot', 'Global must be first');
    assert.strictEqual(
      kinds[kinds.length - 1],
      'recentRoot',
      'Recent must be the very last root child, after Suggested'
    );
    assert.strictEqual(
      kinds[kinds.length - 2],
      'suggestedRoot',
      'Suggested must immediately precede Recent'
    );
  });

  test('the Recent row tree item: label "Recent", collapsed, contextValue bookmarkRecentRoot, ThemeIcon set', async () => {
    const { provider } = await makeProviderWithRecentlyViewed(['file:///recent-a.txt']);
    const children = await provider.getChildren();
    const node = findRecentRoot(children)!;

    const treeItem = await provider.getTreeItem(node);
    assert.strictEqual(treeItem.label, 'Recent');
    assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(treeItem.contextValue, 'bookmarkRecentRoot');
    assert.ok(treeItem.iconPath instanceof vscode.ThemeIcon, 'expected iconPath to be a ThemeIcon');
  });

  test('a recentItem tree item: label is the uri basename, no children, contextValue bookmarkRecentItem, resourceUri set, opens via vscode.open', async () => {
    const uri = 'file:///workspace/recent-file.txt';
    const { provider } = await makeProviderWithRecentlyViewed([uri]);
    const rootChildren = await provider.getChildren();
    const recentRoot = findRecentRoot(rootChildren)!;
    const leaves = await provider.getChildren(recentRoot);

    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].kind, 'recentItem');

    const treeItem = await provider.getTreeItem(leaves[0]);
    assert.strictEqual(treeItem.label, 'recent-file.txt');
    assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(treeItem.contextValue, 'bookmarkRecentItem');
    assert.strictEqual(treeItem.resourceUri?.toString(), uri);
    assert.strictEqual(treeItem.command?.command, 'vscode.open');
    assert.strictEqual((treeItem.command?.arguments?.[0] as vscode.Uri).toString(), uri);
  });

  test('getChildren(recentRoot) returns one recentItem per uri, in the same order the source returns them (source owns MRU ordering, provider does not re-sort)', async () => {
    const uris = ['file:///c.txt', 'file:///a.txt', 'file:///b.txt'];
    const { provider } = await makeProviderWithRecentlyViewed(uris);

    const rootChildren = await provider.getChildren();
    const recentRoot = findRecentRoot(rootChildren)!;
    const leaves = await provider.getChildren(recentRoot);

    assert.deepStrictEqual(
      leaves.map((n) => (n as unknown as { uri: string }).uri),
      uris,
      'the provider must preserve the source order verbatim, not re-sort it'
    );
  });

  test('a uri that is already bookmarked in the store still appears as a recentItem — Recent does NOT filter out already-bookmarked items, unlike Suggested', async () => {
    const uri = 'file:///already-bookmarked.txt';
    const { store, provider } = await makeProviderWithRecentlyViewed([uri]);
    await store.addItem({ type: 'file', uri });

    const rootChildren = await provider.getChildren();
    const recentRoot = findRecentRoot(rootChildren)!;
    const leaves = await provider.getChildren(recentRoot);

    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(
      (leaves[0] as unknown as { uri: string }).uri,
      uri,
      'an already-bookmarked uri must still surface under Recent — this is the key design ' +
        'difference from Suggested, which excludes already-bookmarked uris'
    );
  });

  test('a uri that no longer exists on disk still appears as a recentItem — Recent is not filtered for filesystem existence/staleness, unlike Suggested', async () => {
    const uri = 'file:///stale-recent.txt';
    const { provider } = await makeProviderWithRecentlyViewed([uri], {
      resolve: async () => ({ exists: false })
    });

    const rootChildren = await provider.getChildren();
    const recentRoot = findRecentRoot(rootChildren)!;
    const leaves = await provider.getChildren(recentRoot);

    assert.strictEqual(
      leaves.length,
      1,
      'a stale (non-existent) recent uri must still render as a clickable node under Recent'
    );
    assert.strictEqual((leaves[0] as unknown as { uri: string }).uri, uri);
  });
});

// --- #62: partition-aware workspace topology -----------------------------------------------

const OWNER_A: WorkspaceOwnerRef = { kind: 'partition', partitionId: 'partition-a' };
const OWNER_B: WorkspaceOwnerRef = { kind: 'partition', partitionId: 'partition-b' };

function partitionItem(id: string, uri = `file:///workspace/${id}.ts`, collectionId: string | null = null): BookmarkItem {
  return { id, type: 'file', uri, collectionId, order: 0 };
}

function partitionData(items: BookmarkItem[] = [], collections: BookmarkData['collections'] = []): BookmarkData {
  return { version: 2, items, collections };
}

function readyWorkspaceView(options: {
  attached?: Array<{ partitionId: string; label: string; data?: BookmarkData }>;
  unassigned?: BookmarkData;
  detached?: Array<{ partitionId: string; label?: string; data?: BookmarkData }>;
} = {}): WorkspaceStoreView {
  return {
    kind: 'ready',
    attached: (options.attached ?? []).map((entry) => ({
      partitionId: entry.partitionId,
      label: entry.label,
      rootUri: `file:///workspace/${entry.partitionId}`,
      canonicalRootUri: `file:///workspace/${entry.partitionId}`,
      replacementEligible: false,
      data: entry.data ?? partitionData()
    })),
    unassigned: options.unassigned ?? partitionData(),
    detached: (options.detached ?? []).map((entry) => ({
      partitionId: entry.partitionId,
      lastKnownRootUri: entry.label ?? `file:///old/${entry.partitionId}`,
      canonicalLastKnownRootUri: entry.label ?? `file:///old/${entry.partitionId}`,
      replacementEligible: false,
      data: entry.data ?? partitionData()
    })),
    unavailableRoots: []
  };
}

function unavailableWorkspaceView(): WorkspaceStoreView {
  return { kind: 'unavailable', attached: [], detached: [], unassigned: partitionData(), unavailableRoots: [], reason: 'bad data' };
}

function providerForWorkspaceView(
  view: WorkspaceStoreView,
  options: {
    globalStore?: BookmarkStore;
    repoForUri?: (uri: string) => string | undefined;
    suggestions?: SuggestionsSource;
    recentlyViewed?: RecentlyViewedSource;
  } = {}
) {
  const changes = new vscode.EventEmitter<void>();
  const moves: Array<{ owner: WorkspaceOwnerRef; id: string; collectionId: string | null; index: number }> = [];
  const aggregate = (): BookmarkData => ({
    version: 2,
    items: [
      ...view.attached.flatMap((partition) => partition.data.items),
      ...view.detached.flatMap((partition) => partition.data.items),
      ...view.unassigned.items
    ],
    collections: [
      ...view.attached.flatMap((partition) => partition.data.collections),
      ...view.detached.flatMap((partition) => partition.data.collections),
      ...view.unassigned.collections
    ]
  });
  const workspaceStore = {
    onBookmarksChanged: changes.event,
    getAll: aggregate,
    getView: () => view,
    moveItem: async (owner: WorkspaceOwnerRef, id: string, collectionId: string | null, index: number) => {
      moves.push({ owner, id, collectionId, index });
    }
  } as unknown as WorkspaceBookmarkStore;
  const provider = new BookmarksTreeDataProvider(
    workspaceStore,
    new FsGitCache(async (uri) => ({ exists: true, repoName: options.repoForUri?.(uri) })),
    options.globalStore,
    undefined,
    options.suggestions,
    options.recentlyViewed
  );
  return { provider, moves, changes };
}

function partitionEnvelope(owner: WorkspaceOwnerRef | undefined, ids: string[]): vscode.DataTransfer {
  const transfer = new vscode.DataTransfer();
  transfer.set(DND_MIME_TYPE, new vscode.DataTransferItem({ scope: 'workspace', owner, ids }));
  return transfer;
}

suite('BookmarksTreeDataProvider - workspace partitions (#62)', () => {
  test('unavailable workspace suppresses Suggested including stale expansion while retaining Global and Recent', async () => {
    const globalStore = new BookmarkStore(new FakeMemento());
    const globalItem = await globalStore.addItem({ type: 'file', uri: 'file:///global.ts' });
    const { provider, changes } = providerForWorkspaceView(unavailableWorkspaceView(), {
      globalStore,
      suggestions: { getRecentItems: () => [{ uri: 'file:///preserved.ts', firstSeen: 1, previewCount: 0, promoted: true }], maxItems: 1 },
      recentlyViewed: { getUris: () => ['file:///recent.ts'] }
    });
    try {
      assert.deepStrictEqual((await provider.getChildren()).map(node => node.kind), ['globalRoot', 'workspaceDiagnostic', 'recentRoot']);
      assert.deepStrictEqual(await provider.getChildren({ kind: 'suggestedRoot' }), []);
      const globalChildren = await provider.getChildren({ kind: 'globalRoot' });
      assert.strictEqual(globalChildren[0].kind === 'item' && globalChildren[0].item.id, globalItem.id);
      assert.deepStrictEqual(await provider.getChildren({ kind: 'recentRoot' }), [{ kind: 'recentItem', uri: 'file:///recent.ts' }]);
    } finally { changes.dispose(); globalStore.dispose(); }
  });

  test('keeps one attached root flat and carries its partition owner', async () => {
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      attached: [{ partitionId: OWNER_A.partitionId, label: 'Root A', data: partitionData([partitionItem('a')]) }]
    }));

    const roots = await provider.getChildren();
    assert.strictEqual(roots.some((node) => node.kind === 'workspaceRoot'), false);
    const item = roots.find((node) => node.kind === 'item');
    assert.deepStrictEqual(item && (item as Extract<BookmarkNode, { kind: 'item' }>).owner, OWNER_A);
  });

  test('wraps every attached root in a multi-root workspace in current workspace order', async () => {
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      attached: [
        { partitionId: OWNER_B.partitionId, label: 'Root B' },
        { partitionId: OWNER_A.partitionId, label: 'Root A' }
      ]
    }));

    const roots = await provider.getChildren();
    assert.deepStrictEqual(
      roots.filter((node) => node.kind === 'workspaceRoot').map((node) => (node as Extract<BookmarkNode, { kind: 'workspaceRoot' }>).partitionId),
      [OWNER_B.partitionId, OWNER_A.partitionId]
    );
  });

  test('shows preservation sections only when their owner data is populated', async () => {
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      unassigned: partitionData([partitionItem('unassigned')]),
      detached: [
        { partitionId: 'detached-a', data: partitionData([partitionItem('detached-a')]) },
        { partitionId: 'detached-empty' }
      ]
    }));

    const roots = await provider.getChildren();
    assert.strictEqual(roots.some((node) => node.kind === 'unassignedRoot'), true);
    assert.strictEqual(roots.some((node) => node.kind === 'detachedRoot'), true);
    const detachedRoot = roots.find((node) => node.kind === 'detachedRoot')!;
    const detachedPartitions = await provider.getChildren(detachedRoot);
    assert.deepStrictEqual(
      detachedPartitions.map((node) => (node as Extract<BookmarkNode, { kind: 'detachedPartition' }>).partitionId),
      ['detached-a', 'detached-empty']
    );
  });

  test('shows a workspace diagnostic instead of unavailable workspace content', async () => {
    const { provider } = providerForWorkspaceView(unavailableWorkspaceView());
    const roots = await provider.getChildren();
    assert.strictEqual(roots.filter((node) => node.kind === 'workspaceDiagnostic').length, 1);
  });

  test('keeps equal repo names isolated inside each owner', async () => {
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      attached: [
        { partitionId: OWNER_A.partitionId, label: 'Root A', data: partitionData([partitionItem('a', 'file:///workspace/a/a.ts')]) },
        { partitionId: OWNER_B.partitionId, label: 'Root B', data: partitionData([partitionItem('b', 'file:///workspace/b/b.ts')]) }
      ]
    }), { repoForUri: () => 'shared-repo' });
    provider.setGroupMode('byRepo');

    const roots = await provider.getChildren();
    const rootA = roots.find((node) => node.kind === 'workspaceRoot' && (node as Extract<BookmarkNode, { kind: 'workspaceRoot' }>).partitionId === OWNER_A.partitionId)!;
    const groups = await provider.getChildren(rootA);
    assert.strictEqual(groups.length, 1);
    const items = await provider.getChildren(groups[0]);
    assert.deepStrictEqual(items.map((node) => (node as Extract<BookmarkNode, { kind: 'item' }>).item.id), ['a']);
  });

  test('prefixes tree item identities with their owner to prevent collisions', async () => {
    const shared = partitionItem('same-id');
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      attached: [
        { partitionId: OWNER_A.partitionId, label: 'Root A', data: partitionData([shared]) },
        { partitionId: OWNER_B.partitionId, label: 'Root B', data: partitionData([{ ...shared, uri: 'file:///workspace/b/same-id.ts' }]) }
      ]
    }));
    const roots = await provider.getChildren();
    const first = (await provider.getChildren(roots[0]))[0];
    const second = (await provider.getChildren(roots[1]))[0];
    assert.notStrictEqual((await provider.getTreeItem(first)).id, (await provider.getTreeItem(second)).id);
  });

  test('orders Global, workspace, preservation, Suggested, and Recent deterministically', async () => {
    const globalStore = new BookmarkStore(new FakeMemento());
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      attached: [{ partitionId: OWNER_A.partitionId, label: 'Root A', data: partitionData([partitionItem('a')]) }],
      unassigned: partitionData([partitionItem('u')]),
      detached: [{ partitionId: 'detached-a', data: partitionData([partitionItem('d')]) }]
    }), {
      globalStore,
      suggestions: { getRecentItems: () => [{ uri: 'file:///suggested.ts', firstSeen: 1, previewCount: 0, promoted: true }], maxItems: 1 },
      recentlyViewed: { getUris: () => ['file:///recent.ts'] }
    });
    assert.deepStrictEqual((await provider.getChildren()).map((node) => node.kind), [
      'globalRoot', 'item', 'unassignedRoot', 'detachedRoot', 'suggestedRoot', 'recentRoot'
    ]);
  });

  test('does not re-suggest bookmarks preserved in Detached or Unassigned while Recent stays unfiltered', async () => {
    const detachedUri = 'file:///old/detached.ts';
    const unassignedUri = 'file:///outside/unassigned.ts';
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      unassigned: partitionData([partitionItem('u', unassignedUri)]),
      detached: [{ partitionId: 'old', data: partitionData([partitionItem('d', detachedUri)]) }]
    }), {
      suggestions: {
        getRecentItems: () => [
          { uri: detachedUri, firstSeen: 2, previewCount: 0, promoted: true },
          { uri: unassignedUri, firstSeen: 1, previewCount: 0, promoted: true }
        ], maxItems: 2
      },
      recentlyViewed: { getUris: () => [detachedUri] }
    });
    const roots = await provider.getChildren();
    assert.strictEqual(roots.some((node) => node.kind === 'suggestedRoot'), false);
    assert.strictEqual(roots.some((node) => node.kind === 'recentRoot'), true);
  });

  test('permits same-owner workspace drops and rejects missing or cross-owner envelopes without mutation', async () => {
    const collection = { id: 'collection-a', name: 'A', order: 0 };
    const { provider, moves } = providerForWorkspaceView(readyWorkspaceView({
      attached: [
        { partitionId: OWNER_A.partitionId, label: 'Root A', data: partitionData([partitionItem('a')], [collection]) },
        { partitionId: OWNER_B.partitionId, label: 'Root B', data: partitionData([partitionItem('b')]) }
      ]
    }));
    const token = new vscode.CancellationTokenSource().token;
    const roots = await provider.getChildren();
    const rootA = roots.find((node) => node.kind === 'workspaceRoot' && (node as Extract<BookmarkNode, { kind: 'workspaceRoot' }>).partitionId === OWNER_A.partitionId)!;
    const target = (await provider.getChildren(rootA)).find((node) => node.kind === 'collection')!;

    await provider.handleDrop(target, partitionEnvelope(undefined, ['a']), token);
    await provider.handleDrop(target, partitionEnvelope(OWNER_B, ['b']), token);
    assert.deepStrictEqual(moves, []);

    await provider.handleDrop(target, partitionEnvelope(OWNER_A, ['a']), token);
    assert.deepStrictEqual(moves, [{ owner: OWNER_A, id: 'a', collectionId: 'collection-a', index: 0 }]);
  });

  test('rejects a multi-selection drag that mixes workspace owners', async () => {
    const { provider } = providerForWorkspaceView(readyWorkspaceView());
    const transfer = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag([
      { kind: 'item', item: partitionItem('a'), scope: 'workspace', owner: OWNER_A },
      { kind: 'item', item: partitionItem('b'), scope: 'workspace', owner: OWNER_B }
    ], transfer, token);
    assert.strictEqual(transfer.get(DND_MIME_TYPE), undefined);
  });

  test('allows an untargeted drop to the attached owner in a flat single-root tree', async () => {
    const store = await createSingleRootFixtureStore();
    const collection = await store.addCollection('Only collection');
    const item = await store.addItem({ type: 'file', uri: 'file:///a', collectionId: collection.id });
    assert.strictEqual(store.getOwnerData(SINGLE_ROOT_OWNER)!.items[0].collectionId, collection.id);
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: true })));
    await provider.handleDrop(undefined, partitionEnvelope(SINGLE_ROOT_OWNER, [item.id]), new vscode.CancellationTokenSource().token);
    assert.strictEqual(store.getOwnerData(SINGLE_ROOT_OWNER)!.items[0].collectionId, null);
    assert.strictEqual(store.getOwnerData(SINGLE_ROOT_OWNER)!.items[0].order, 0);
    store.dispose();
  });

  test('keeps Detached visible and lists empty detached partitions for recovery', async () => {
    const { provider } = providerForWorkspaceView(readyWorkspaceView({
      detached: [{ partitionId: 'empty-a' }, { partitionId: 'empty-b' }]
    }));
    const roots = await provider.getChildren();
    const detached = roots.find((node) => node.kind === 'detachedRoot')!;
    assert.ok(detached);
    assert.deepStrictEqual(
      (await provider.getChildren(detached)).map((node) => (node as Extract<BookmarkNode, { kind: 'detachedPartition' }>).partitionId),
      ['empty-a', 'empty-b']
    );
  });

  test('rejects Unassigned, Detached, and no-longer-attached workspace drop targets', async () => {
    const unassignedCollection = { id: 'unassigned-collection', name: 'Unassigned', order: 0 };
    const detachedCollection = { id: 'detached-collection', name: 'Detached', order: 0 };
    const view = readyWorkspaceView({
      attached: [{ partitionId: OWNER_A.partitionId, label: 'Root A', data: partitionData([partitionItem('a')]) }],
      unassigned: partitionData([partitionItem('u')], [unassignedCollection]),
      detached: [{ partitionId: 'detached-a', data: partitionData([partitionItem('d')], [detachedCollection]) }]
    });
    const { provider, moves } = providerForWorkspaceView(view);
    const token = new vscode.CancellationTokenSource().token;
    const roots = await provider.getChildren();
    const unassignedTarget = (await provider.getChildren(roots.find((node) => node.kind === 'unassignedRoot')!)).find((node) => node.kind === 'collection')!;
    const detachedRoot = roots.find((node) => node.kind === 'detachedRoot')!;
    const detachedTarget = (await provider.getChildren((await provider.getChildren(detachedRoot))[0])).find((node) => node.kind === 'item')!;
    await provider.handleDrop(unassignedTarget, partitionEnvelope({ kind: 'unassigned' }, ['u']), token);
    await provider.handleDrop(detachedTarget, partitionEnvelope({ kind: 'partition', partitionId: 'detached-a' }, ['d']), token);

    const attachedTarget = (await provider.getChildren()).find((node) => node.kind === 'item')!;
    (view as unknown as { attached: unknown[] }).attached = [];
    (view as unknown as { detached: unknown[] }).detached = [{
      partitionId: OWNER_A.partitionId, lastKnownRootUri: 'file:///old/a', canonicalLastKnownRootUri: 'file:///old/a', replacementEligible: false,
      data: partitionData([partitionItem('a')])
    }];
    await provider.handleDrop(attachedTarget, partitionEnvelope(OWNER_A, ['a']), token);
    assert.deepStrictEqual(moves, []);
  });

  test('gives equal-label workspace and detached wrappers stable partition identities', async () => {
    const view = readyWorkspaceView({
      attached: [{ partitionId: OWNER_A.partitionId, label: 'Same' }, { partitionId: OWNER_B.partitionId, label: 'Same' }],
      detached: [{ partitionId: 'old-a', label: 'Same' }, { partitionId: 'old-b', label: 'Same' }]
    });
    const { provider } = providerForWorkspaceView(view);
    const roots = await provider.getChildren();
    const attachedIds = await Promise.all(roots.filter((node) => node.kind === 'workspaceRoot').map((node) => provider.getTreeItem(node)));
    assert.strictEqual(new Set(attachedIds.map((item) => item.id)).size, 2);
    const detached = roots.find((node) => node.kind === 'detachedRoot')!;
    const detachedIds = await Promise.all((await provider.getChildren(detached)).map((node) => provider.getTreeItem(node)));
    assert.strictEqual(new Set(detachedIds.map((item) => item.id)).size, 2);
    (view.attached[0] as { label: string }).label = 'Renamed';
    const renamed = await provider.getChildren();
    assert.strictEqual((await provider.getTreeItem(renamed.find((node) => node.kind === 'workspaceRoot')!)).id, attachedIds[0].id);
  });
});
