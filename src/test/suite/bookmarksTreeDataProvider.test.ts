import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { FsGitCache } from '../../fsGitCache';
import { BookmarksTreeDataProvider, BookmarkNode, DND_MIME_TYPE } from '../../bookmarksTreeDataProvider';
import { FakeMemento } from './fixtures';

function makeProvider(resolve: (uri: string) => Promise<{ exists: boolean; repoName?: string }> = async () => ({ exists: true })) {
  const store = new BookmarkStore(new FakeMemento());
  const cache = new FsGitCache(resolve);
  const provider = new BookmarksTreeDataProvider(store, cache);
  return { store, cache, provider };
}

suite('BookmarksTreeDataProvider - default mode', () => {
  test('empty store yields no root children', async () => {
    const { provider } = makeProvider();
    const children = await provider.getChildren();
    assert.deepStrictEqual(children, []);
  });

  test('root shows collections before ungrouped items, each sorted by order', async () => {
    const { store, provider } = makeProvider();
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
    const { store, provider } = makeProvider();
    const collection = await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' }); // root item — must not appear

    const node: BookmarkNode = { kind: 'collection', collection, scope: 'workspace' };
    const children = await provider.getChildren(node);

    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].kind, 'item');
  });

  test('a folder bookmark tree item is always a leaf (collapsibleState None) and has no children', async () => {
    const { store, provider } = makeProvider();
    const folder = await store.addItem({ type: 'folder', uri: 'file:///dir' });
    const node: BookmarkNode = { kind: 'item', item: folder, scope: 'workspace' };

    const treeItem = await provider.getTreeItem(node);
    assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.None);

    const children = await provider.getChildren(node);
    assert.deepStrictEqual(children, []);
  });

  test('a broken bookmark renders with a warning icon and does not throw', async () => {
    const { store, provider } = makeProvider(async () => ({ exists: false }));
    const item = await store.addItem({ type: 'file', uri: 'file:///missing.txt' });
    const node: BookmarkNode = { kind: 'item', item, scope: 'workspace' };

    const treeItem = await provider.getTreeItem(node);
    assert.ok(treeItem.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((treeItem.iconPath as vscode.ThemeIcon).id, 'warning');
  });

  test('a valid bookmark with a resolved repo shows the repo name as its description', async () => {
    const { store, provider } = makeProvider(async () => ({ exists: true, repoName: 'my-repo' }));
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(treeItem.description, 'my-repo');
  });

  test('file bookmark tree item opens the file directly, bypassing bookmarks.reveal', async () => {
    const { store, provider } = makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(treeItem.command?.command, 'vscode.open');
  });

  test('folder bookmark tree item triggers bookmarks.reveal (its only possible click target)', async () => {
    const { store, provider } = makeProvider();
    const item = await store.addItem({ type: 'folder', uri: 'file:///dir' });
    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(treeItem.command?.command, 'bookmarks.reveal');
  });

  test('re-fires onDidChangeTreeData and invalidates the cache when the store changes', async () => {
    let resolveCalls = 0;
    const { store, provider } = makeProvider(async () => { resolveCalls++; return { exists: true }; });

    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(resolveCalls, 1);

    let redraws = 0;
    provider.onDidChangeTreeData(() => { redraws++; });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    assert.strictEqual(redraws, 1);

    await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(resolveCalls, 2, 'the cache must be invalidated on onBookmarksChanged');
  });
});

suite('BookmarksTreeDataProvider - group-by-repo mode', () => {
  test('an item with no resolvable repo falls into the Unknown group without throwing', async () => {
    const { store, provider } = makeProvider(async () => ({ exists: true, repoName: undefined }));
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].kind, 'repoGroup');
    assert.strictEqual((roots[0] as { label: string }).label, 'Unknown');
  });

  test('a broken item also falls into the Unknown group in group-by-repo mode', async () => {
    const { store, provider } = makeProvider(async () => ({ exists: false }));
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///missing.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual((roots[0] as { label: string }).label, 'Unknown');
  });

  test('degrades to an all-Unknown render (no throw) when no active git repository is found', async () => {
    const { store, provider } = makeProvider(async () => ({ exists: true })); // simulates vscode.git unavailable
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual((roots[0] as { label: string }).label, 'Unknown');
  });

  test('groups items under their resolved repo, nested by collection, and each repo only sees its own items', async () => {
    const { store, provider } = makeProvider(async (uri) => ({
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
    const { store, provider } = makeProvider(async (uri) =>
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

function makeDropTransfer(ids: string[]): vscode.DataTransfer {
  const dt = new vscode.DataTransfer();
  dt.set(DND_MIME_TYPE, new vscode.DataTransferItem(ids));
  return dt;
}

suite('BookmarksTreeDataProvider - drag and drop', () => {
  test('dropping with no target appends the item to the root, at the end', async () => {
    const { store, provider } = makeProvider();
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(undefined, makeDropTransfer([a.id]), token);

    const data = store.getAll();
    const byId = (id: string) => data.items.find((i) => i.id === id)!;
    assert.strictEqual(byId(a.id).collectionId, null);
    assert.strictEqual(byId(a.id).order, 1);
    assert.strictEqual(byId(b.id).order, 0);
  });

  test('dropping on a collection node moves the item into it', async () => {
    const { store, provider } = makeProvider();
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const other = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const targetNode: BookmarkNode = { kind: 'collection', collection, scope: 'workspace' };
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer([item.id]), token);

    const data = store.getAll();
    const moved = data.items.find((i) => i.id === item.id)!;
    const remainingRoot = data.items.filter((i) => i.collectionId === null);

    assert.strictEqual(moved.collectionId, collection.id);
    assert.strictEqual(remainingRoot.length, 1);
    assert.strictEqual(remainingRoot[0].id, other.id);
    assert.strictEqual(remainingRoot[0].order, 0);
  });

  test('dropping on a sibling item reorders within the same parent', async () => {
    const { store, provider } = makeProvider();
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    const c = await store.addItem({ type: 'file', uri: 'file:///c.txt' });

    const targetNode: BookmarkNode = { kind: 'item', item: a, scope: 'workspace' }; // drop c onto a's position
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer([c.id]), token);

    const data = store.getAll();
    const byId = (id: string) => data.items.find((i) => i.id === id)!;
    assert.strictEqual(byId(c.id).order, 0);
    assert.strictEqual(byId(a.id).order, 1);
    assert.strictEqual(byId(b.id).order, 2);
  });

  test('drag and drop are disabled in group-by-repo mode', async () => {
    const { store, provider } = makeProvider();
    provider.setGroupMode('byRepo');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(undefined, makeDropTransfer([item.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === item.id)!;
    assert.strictEqual(untouched.collectionId, null);
    assert.strictEqual(untouched.order, 0);
  });

  test('handleDrag is disabled in group-by-repo mode and sets no transfer data', async () => {
    const { store, provider } = makeProvider();
    provider.setGroupMode('byRepo');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag([{ kind: 'item', item, scope: 'workspace' }], dt, token);

    assert.strictEqual(dt.get(DND_MIME_TYPE), undefined);
  });
});

suite('BookmarksTreeDataProvider - descriptions', () => {
  test('an item with a description gets a tooltip containing both the path and the description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'the entrypoint');
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: true })));

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace' });

    assert.strictEqual(typeof treeItem.tooltip, 'string');
    assert.ok((treeItem.tooltip as string).includes('the entrypoint'));
    assert.ok((treeItem.tooltip as string).includes('a.txt'));
  });

  test('an item without a description leaves the tooltip undefined (default path hover survives)', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: true })));

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace' });

    assert.strictEqual(treeItem.tooltip, undefined);
  });

  test('a description never displaces the repo-name badge in TreeItem.description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'the entrypoint');
    const provider = new BookmarksTreeDataProvider(
      store,
      new FsGitCache(async () => ({ exists: true, repoName: 'repo-a' }))
    );

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace' });

    assert.strictEqual(treeItem.description, 'repo-a');
  });

  test('a description never displaces the "missing" badge on a broken bookmark', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///gone.txt' });
    await store.setItemDescription(item.id, 'was here');
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: false })));

    const treeItem = await provider.getTreeItem({ kind: 'item', item: store.getAll().items[0], scope: 'workspace' });

    assert.strictEqual(treeItem.description, 'missing');
    assert.ok((treeItem.tooltip as string).includes('was here'));
  });

  test('a collection with a description gets it as the tooltip; without one the tooltip is undefined', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const provider = new BookmarksTreeDataProvider(store, new FsGitCache(async () => ({ exists: true })));

    const before = await provider.getTreeItem({ kind: 'collection', collection: store.getAll().collections[0], scope: 'workspace' });
    assert.strictEqual(before.tooltip, undefined);

    await store.setCollectionDescription(collection.id, 'work-related bookmarks');
    const after = await provider.getTreeItem({ kind: 'collection', collection: store.getAll().collections[0], scope: 'workspace' });
    assert.strictEqual(after.tooltip, 'work-related bookmarks');
  });
});
