import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { FsGitCache } from '../../fsGitCache';
import { BookmarksTreeDataProvider, BookmarkNode, DND_MIME_TYPE } from '../../bookmarksTreeDataProvider';
import { RecentItem } from '../../recentItems';
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
  dt.set(DND_MIME_TYPE, new vscode.DataTransferItem({ scope, ids }));
  return dt;
}

/** Reads the scope-tagged envelope back out of a DataTransfer set up by handleDrag, if any. */
function getTransferEnvelope(dt: vscode.DataTransfer): DragEnvelope | undefined {
  return dt.get(DND_MIME_TYPE)?.value as DragEnvelope | undefined;
}

suite('BookmarksTreeDataProvider - drag and drop', () => {
  test('dropping with no target appends the item to the root, at the end', async () => {
    const { store, provider } = makeProvider();
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
    const { store, provider } = makeProvider();
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const other = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const targetNode: BookmarkNode = { kind: 'collection', collection, scope: 'workspace' };
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
    const { store, provider } = makeProvider();
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    const c = await store.addItem({ type: 'file', uri: 'file:///c.txt' });

    const targetNode: BookmarkNode = { kind: 'item', item: a, scope: 'workspace' }; // drop c onto a's position
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(targetNode, makeDropTransfer('workspace', [c.id]), token);

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
    await provider.handleDrop(undefined, makeDropTransfer('workspace', [item.id]), token);

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

  test('handleDrag on an all-workspace-scope selection sets a workspace-scoped transfer envelope', async () => {
    const { store, provider } = makeProvider();
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag(
      [
        { kind: 'item', item: a, scope: 'workspace' },
        { kind: 'item', item: b, scope: 'workspace' }
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
    const { globalStore, provider } = makeProviderWithGlobal();
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
    const { store, globalStore, provider } = makeProviderWithGlobal();
    const workspaceItem = await store.addItem({ type: 'file', uri: 'file:///workspace-a.txt' });
    const globalItem = await globalStore.addItem({ type: 'file', uri: 'file:///global-a.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag(
      [
        { kind: 'item', item: workspaceItem, scope: 'workspace' },
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
    const { store, globalStore, provider } = makeProviderWithGlobal();
    const workspaceCollection = await store.addCollection('WorkCol');
    const globalItem = await globalStore.addItem({ type: 'file', uri: 'file:///global-a.txt' });

    const targetNode: BookmarkNode = { kind: 'collection', collection: workspaceCollection, scope: 'workspace' };
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
    const { store, globalStore, provider } = makeProviderWithGlobal();
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
    const { store, globalStore, provider } = makeProviderWithGlobal();
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
    const { store, globalStore, provider } = makeProviderWithGlobal();
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
    const { store, globalStore, provider } = makeProviderWithGlobal();
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
    const { store, globalStore, provider } = makeProviderWithGlobal();
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
    const { store, provider } = makeProvider();
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

// --- T3: pinned Global row -------------------------------------------------------------------

function findGlobalRoot(nodes: BookmarkNode[]): BookmarkNode | undefined {
  return nodes.find((n) => n.kind === 'globalRoot');
}

/** The root children other than the pinned Global row. */
function excludeGlobalRoot(nodes: BookmarkNode[]): BookmarkNode[] {
  return nodes.filter((n) => n.kind !== 'globalRoot');
}

function makeProviderWithGlobal(
  resolve: (uri: string) => Promise<{ exists: boolean; repoName?: string }> = async () => ({ exists: true }),
  getWorkspaceFolders?: () => readonly vscode.WorkspaceFolder[] | undefined
) {
  const store = new BookmarkStore(new FakeMemento());
  const globalStore = new BookmarkStore(new FakeMemento());
  const cache = new FsGitCache(resolve);
  const provider = getWorkspaceFolders
    ? new BookmarksTreeDataProvider(store, cache, globalStore, getWorkspaceFolders)
    : new BookmarksTreeDataProvider(store, cache, globalStore);
  return { store, globalStore, cache, provider };
}

suite('BookmarksTreeDataProvider - Global row (T3)', () => {
  test('omitting globalStore leaves root children unaffected — no Global row is synthesized (regression guard)', async () => {
    const { store, provider } = makeProvider();
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
    const { provider } = makeProviderWithGlobal();

    const children = await provider.getChildren();

    assert.ok(children.length > 0, 'the Global row must be present even when both stores are empty');
    const globalRootNode = findGlobalRoot(children);
    assert.ok(globalRootNode, 'expected a node with kind "globalRoot" among root children');
    assert.strictEqual(children[0].kind, 'globalRoot', 'the Global row must be the first root child');
  });

  test('the Global row tree item carries contextValue "bookmarkGlobalRoot"', async () => {
    const { provider } = makeProviderWithGlobal();

    const children = await provider.getChildren();
    const globalRootNode = findGlobalRoot(children);
    assert.ok(globalRootNode, 'expected a Global row to fetch a tree item for');

    const treeItem = await provider.getTreeItem(globalRootNode);
    assert.strictEqual(treeItem.contextValue, 'bookmarkGlobalRoot');
  });

  test('the Global row is still present and first even when the workspace store already has content', async () => {
    const { store, provider } = makeProviderWithGlobal();
    await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const children = await provider.getChildren();
    assert.strictEqual(children[0].kind, 'globalRoot');
  });

  test('global collections and items render only under the Global row, tagged scope "global"', async () => {
    const { store, globalStore, provider } = makeProviderWithGlobal();

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
    const { store, globalStore, provider } = makeProviderWithGlobal();

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
    const { store, globalStore, provider } = makeProviderWithGlobal(async () => {
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
    const { store, globalStore, provider } = makeProviderWithGlobal(async (uri) => ({
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
    const { globalStore, provider } = makeProviderWithGlobal(undefined, () => folders);
    const item = await globalStore.addItem({ type: 'folder', uri: 'file:///global/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem-addable');
  });

  test('a global folder bookmark already inside a workspace folder keeps the plain contextValue', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/global/some-repo'))];
    const { globalStore, provider } = makeProviderWithGlobal(undefined, () => folders);
    const item = await globalStore.addItem({ type: 'folder', uri: 'file:///global/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem');
  });

  test('a global file bookmark outside every workspace folder never gets the addable contextValue', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/other-project'))];
    const { globalStore, provider } = makeProviderWithGlobal(undefined, () => folders);
    const item = await globalStore.addItem({ type: 'file', uri: 'file:///global/some-file.txt' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem', 'files can never be added as a workspace folder');
  });

  test('a workspace-scoped folder bookmark outside every current workspace folder is still never addable', async () => {
    const folders = [workspaceFolder(vscode.Uri.file('/workspace/other-project'))];
    const { store, provider } = makeProviderWithGlobal(undefined, () => folders);
    const item = await store.addItem({ type: 'folder', uri: 'file:///workspace/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });

    assert.strictEqual(
      treeItem.contextValue,
      'bookmarkItem',
      'workspace-scoped items are never addable, regardless of where their target sits'
    );
  });

  test('a global folder bookmark gets the addable contextValue when no workspace is open at all (folders undefined)', async () => {
    const { globalStore, provider } = makeProviderWithGlobal(undefined, () => undefined);
    const item = await globalStore.addItem({ type: 'folder', uri: 'file:///global/some-repo' });

    const treeItem = await provider.getTreeItem({ kind: 'item', item, scope: 'global' });

    assert.strictEqual(treeItem.contextValue, 'bookmarkItem-addable', 'an empty window (no workspace) still counts as "outside"');
  });

  test('a global folder bookmark gets the addable contextValue when the workspace folder list is empty', async () => {
    const { globalStore, provider } = makeProviderWithGlobal(undefined, () => []);
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

function makeProviderWithSuggestions(
  recentItems: RecentItem[],
  maxItems = 10,
  options: {
    resolve?: (uri: string) => Promise<{ exists: boolean; repoName?: string }>;
    globalStore?: BookmarkStore;
  } = {}
) {
  const store = new BookmarkStore(new FakeMemento());
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
    const { provider } = makeProvider(); // the pre-#95 constructor call shape, unchanged
    const children = await provider.getChildren();
    assert.ok(children.every((n) => n.kind !== 'suggestedRoot'));
  });

  test('the Suggested row is absent when there are zero promoted recent items', async () => {
    const { provider } = makeProviderWithSuggestions([recentItem({ promoted: false, previewCount: 1 })]);
    const children = await provider.getChildren();
    assert.strictEqual(
      findSuggestedRoot(children),
      undefined,
      'a preview-only (unpromoted) entry must not surface a Suggested row'
    );
  });

  test('the Suggested row appears, positioned last, when at least one promoted suggestion exists (D8)', async () => {
    const { provider } = makeProviderWithSuggestions([recentItem()]);
    const children = await provider.getChildren();
    assert.strictEqual(children[children.length - 1].kind, 'suggestedRoot');
  });

  test('the Suggested row sits below the Global row when both are present (D8)', async () => {
    const globalStore = new BookmarkStore(new FakeMemento());
    const { provider } = makeProviderWithSuggestions([recentItem()], 10, { globalStore });
    const children = await provider.getChildren();
    assert.strictEqual(children[0].kind, 'globalRoot');
    assert.strictEqual(children[children.length - 1].kind, 'suggestedRoot');
  });

  test('the Suggested row still appears last in byRepo mode (D8: present in both group modes)', async () => {
    const { store, provider } = makeProviderWithSuggestions([recentItem()]);
    provider.setGroupMode('byRepo');
    await store.addItem({ type: 'file', uri: 'file:///bookmarked.txt' });

    const children = await provider.getChildren();
    assert.strictEqual(children[children.length - 1].kind, 'suggestedRoot');
  });

  test('the Suggested row tree item defaults to collapsed (D8)', async () => {
    const { provider } = makeProviderWithSuggestions([recentItem()]);
    const children = await provider.getChildren();
    const node = findSuggestedRoot(children)!;
    const treeItem = await provider.getTreeItem(node);
    assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  });

  test('a suggestion leaf tree item opens the file directly and carries the bookmarkSuggestion contextValue (T5)', async () => {
    const uri = 'file:///suggested-a.txt';
    const { provider } = makeProviderWithSuggestions([recentItem({ uri })]);
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
    const { store, provider } = makeProviderWithSuggestions([
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

    const { provider } = makeProviderWithSuggestions(
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
    const { provider } = makeProviderWithSuggestions([
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
    const { provider } = makeProviderWithSuggestions(
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
    const { provider } = makeProviderWithSuggestions([recentItem()], 0);
    const children = await provider.getChildren();
    assert.strictEqual(findSuggestedRoot(children), undefined);
  });

  test('suggestion leaves render most-recently-first-seen first (D6 sort)', async () => {
    const { provider } = makeProviderWithSuggestions([
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
    const { provider } = makeProviderWithSuggestions(
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
    const { provider } = makeProviderWithSuggestions([recentItem({ uri: staleUri })], 10, {
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
    const { provider } = makeProviderWithSuggestions(
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
    const { store, provider } = makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag([{ kind: 'item', item, scope: 'workspace' }, suggestionNode()], dt, token);

    const envelope = getTransferEnvelope(dt);
    assert.ok(envelope, 'the real item must still be draggable despite the mixed-in suggestion node');
    assert.deepStrictEqual(envelope!.ids, [item.id]);
  });

  test('handleDrag on an all-suggestion selection sets no transfer data', async () => {
    const { provider } = makeProvider();
    const dt = new vscode.DataTransfer();
    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrag([suggestionNode('file:///a.txt'), suggestionNode('file:///b.txt')], dt, token);
    assert.strictEqual(dt.get(DND_MIME_TYPE), undefined);
  });

  test('handleDrop on a suggestion node target is a no-op', async () => {
    const { store, provider } = makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(suggestionNode(), makeDropTransfer('workspace', [item.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === item.id)!;
    assert.strictEqual(untouched.collectionId, null);
    assert.strictEqual(untouched.order, 0, 'a suggestion node is not a valid drop target');
  });

  test('handleDrop on a suggestedRoot node target is a no-op', async () => {
    const { store, provider } = makeProvider();
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    const token = new vscode.CancellationTokenSource().token;
    await provider.handleDrop(suggestedRootNode(), makeDropTransfer('workspace', [item.id]), token);

    const untouched = store.getAll().items.find((i) => i.id === item.id)!;
    assert.strictEqual(untouched.collectionId, null);
    assert.strictEqual(untouched.order, 0, 'a suggestedRoot node is not a valid drop target');
  });
});
