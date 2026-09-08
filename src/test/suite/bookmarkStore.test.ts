import * as assert from 'assert';
import { BookmarkStore, DuplicateBookmarkError } from '../../bookmarkStore';
import { BookmarkData } from '../../types';
import { FakeMemento, FakeOutput } from './fixtures';

suite('BookmarkStore - load and core CRUD', () => {
  test('initializes empty data when storage is empty', () => {
    const store = new BookmarkStore(new FakeMemento());
    assert.deepStrictEqual(store.getAll(), { version: 2, items: [], collections: [] });
  });

  test('recovers from malformed stored data without throwing, and logs a warning', () => {
    const memento = new FakeMemento({ 'bookmarks.data': { totally: 'wrong shape' } });
    const output = new FakeOutput();
    const store = new BookmarkStore(memento, output);

    assert.deepStrictEqual(store.getAll(), { version: 2, items: [], collections: [] });
    assert.strictEqual(output.lines.length, 1);
  });

  test('recovers when the stored value is null', () => {
    const memento = new FakeMemento({ 'bookmarks.data': null });
    const store = new BookmarkStore(memento);
    assert.deepStrictEqual(store.getAll(), { version: 2, items: [], collections: [] });
  });

  test('addItem assigns sequential order within the root parent', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const first = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const second = await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    assert.strictEqual(first.order, 0);
    assert.strictEqual(second.order, 1);
  });

  test('addItem assigns sequential order within a collection, independent of root order', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    await store.addItem({ type: 'file', uri: 'file:///root.txt' });
    const collectionId = 'col-1';
    const first = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId });
    const second = await store.addItem({ type: 'file', uri: 'file:///b.txt', collectionId });
    assert.strictEqual(first.order, 0);
    assert.strictEqual(second.order, 1);
  });

  test('addItem rejects a duplicate uri in the root collection without adding another item', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    const input = { type: 'file' as const, uri: 'file:///a.txt' };
    let fireCount = 0;
    store.onBookmarksChanged(() => { fireCount++; });
    await store.addItem(input);
    const updateCallsAfterFirstAdd = memento.updateCallCount;

    await assert.rejects(
      () => store.addItem({ ...input, collectionId: null }),
      (error: unknown) => {
        assert.ok(error instanceof DuplicateBookmarkError);
        assert.strictEqual(error.uri, input.uri);
        assert.strictEqual(error.collectionId, null);
        return true;
      }
    );

    assert.strictEqual(store.getAll().items.length, 1);
    assert.strictEqual(memento.updateCallCount, updateCallsAfterFirstAdd);
    assert.strictEqual(fireCount, 1);
  });

  test('addItem rejects a duplicate uri and collectionId even when the item type differs', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const uri = 'file:///a.txt';
    await store.addItem({ type: 'file', uri, collectionId: collection.id });

    await assert.rejects(
      () => store.addItem({ type: 'folder', uri, collectionId: collection.id }),
      (error: unknown) => {
        assert.ok(error instanceof DuplicateBookmarkError);
        assert.strictEqual(error.collectionId, collection.id);
        return true;
      }
    );

    assert.strictEqual(store.getAll().items.length, 1);
  });

  test('addItem allows the same uri in a different collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const uri = 'file:///a.txt';

    await store.addItem({ type: 'file', uri });
    await store.addItem({ type: 'file', uri, collectionId: collection.id });

    assert.strictEqual(store.getAll().items.length, 2);
  });

  test('multi-root URI resolution: the stored uri is the absolute URI verbatim, regardless of workspace root', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const absoluteUri = 'file:///workspace-root-two/nested/file.ts';
    const item = await store.addItem({ type: 'file', uri: absoluteUri });

    const retrieved = store.getAll().items.find((i) => i.id === item.id)!;
    assert.strictEqual(retrieved.uri, absoluteUri, 'no relative-path resolution should ever be applied');
  });

  test('removeItem renumbers remaining siblings to stay contiguous', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    const c = await store.addItem({ type: 'file', uri: 'file:///c.txt' });

    await store.removeItem(a.id);

    const remaining = store.getAll().items.sort((x, y) => x.order - y.order);
    assert.strictEqual(remaining.length, 2);
    assert.deepStrictEqual(remaining.map((i) => i.id), [b.id, c.id]);
    assert.deepStrictEqual(remaining.map((i) => i.order), [0, 1]);
  });

  test('removeItem on an unknown id is a no-op', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.removeItem('does-not-exist');
    assert.strictEqual(store.getAll().items.length, 1);
  });

  test('getAll does not fire onBookmarksChanged', () => {
    const store = new BookmarkStore(new FakeMemento());
    let fired = false;
    store.onBookmarksChanged(() => { fired = true; });
    store.getAll();
    assert.strictEqual(fired, false);
  });

  test('addItem fires onBookmarksChanged exactly once', async () => {
    const store = new BookmarkStore(new FakeMemento());
    let fireCount = 0;
    store.onBookmarksChanged(() => { fireCount++; });
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    assert.strictEqual(fireCount, 1);
  });
});

suite('BookmarkStore - moveItem', () => {
  test('reordering within the same parent renumbers all siblings to 0..n-1', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    const c = await store.addItem({ type: 'file', uri: 'file:///c.txt' });

    // Move c (order 2) to index 0.
    await store.moveItem(c.id, null, 0);

    const byId = (id: string) => store.getAll().items.find((i) => i.id === id)!;
    assert.strictEqual(byId(c.id).order, 0);
    assert.strictEqual(byId(a.id).order, 1);
    assert.strictEqual(byId(b.id).order, 2);
  });

  test('moving into a different collection updates collectionId and renumbers both source and destination', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    const existingInCollection = await store.addItem({ type: 'file', uri: 'file:///c.txt', collectionId: collection.id });

    await store.moveItem(a.id, collection.id, 0);

    const data = store.getAll();
    const byId = (id: string) => data.items.find((i) => i.id === id)!;

    assert.strictEqual(byId(a.id).collectionId, collection.id);
    assert.strictEqual(byId(a.id).order, 0);
    assert.strictEqual(byId(existingInCollection.id).order, 1);

    const remainingRoot = data.items.filter((i) => i.collectionId === null);
    assert.strictEqual(remainingRoot.length, 1);
    assert.strictEqual(remainingRoot[0].id, b.id);
    assert.strictEqual(remainingRoot[0].order, 0);
  });

  test('moving into a collection with the same uri rejects without mutating either collection', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    const source = await store.addCollection('Source');
    const target = await store.addCollection('Target');
    const uri = 'file:///a.txt';
    const movingItem = await store.addItem({ type: 'file', uri, collectionId: source.id });
    await store.addItem({ type: 'file', uri, collectionId: target.id });
    const itemsBeforeMove = structuredClone(store.getAll().items);
    const updateCallsBeforeMove = memento.updateCallCount;

    await assert.rejects(
      () => store.moveItem(movingItem.id, target.id, 0),
      (error: unknown) => {
        assert.ok(error instanceof DuplicateBookmarkError);
        assert.strictEqual(error.uri, uri);
        assert.strictEqual(error.collectionId, target.id);
        return true;
      }
    );

    assert.deepStrictEqual(store.getAll().items, itemsBeforeMove);
    assert.strictEqual(memento.updateCallCount, updateCallsBeforeMove);
  });

  test('moveItem on an unknown id is a no-op', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.moveItem('does-not-exist', null, 0);
    assert.strictEqual(store.getAll().items.length, 1);
  });

  test('moveItem clamps an out-of-range index into the valid range', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    await store.moveItem(a.id, null, 999);

    const remaining = store.getAll().items.sort((x, y) => x.order - y.order);
    assert.deepStrictEqual(remaining.map((i) => i.id), [b.id, a.id]);
  });
});

suite('BookmarkStore - collections', () => {
  test('addCollection assigns sequential order among collections', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const first = await store.addCollection('Work');
    const second = await store.addCollection('Personal');
    assert.strictEqual(first.order, 0);
    assert.strictEqual(second.order, 1);
  });

  test('renameCollection updates the name without changing order', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    await store.renameCollection(collection.id, 'Work Stuff');
    const updated = store.getAll().collections.find((c) => c.id === collection.id)!;
    assert.strictEqual(updated.name, 'Work Stuff');
    assert.strictEqual(updated.order, 0);
  });

  test('renameCollection on an unknown id is a no-op', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.renameCollection('does-not-exist', 'X');
    assert.strictEqual(store.getAll().collections.length, 0);
  });

  test('deleteCollection ungroups its items instead of deleting them', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });

    await store.deleteCollection(collection.id);

    const data = store.getAll();
    assert.strictEqual(data.collections.length, 0);
    assert.strictEqual(data.items.length, 1, 'items must not be deleted');
    assert.strictEqual(data.items.find((i) => i.id === item.id)!.collectionId, null);
  });

  test('deleteCollection performs the mutation as a single workspaceState.update() call', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    const collection = await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    await store.addItem({ type: 'file', uri: 'file:///b.txt', collectionId: collection.id });
    await store.addItem({ type: 'file', uri: 'file:///c.txt', collectionId: collection.id });

    const callsBefore = memento.updateCallCount;
    await store.deleteCollection(collection.id);

    assert.strictEqual(
      memento.updateCallCount - callsBefore,
      1,
      'deleting a 3-item collection must be exactly one update() call, not one per item'
    );
  });

  test('deleteCollection fires onBookmarksChanged exactly once', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });

    let fireCount = 0;
    store.onBookmarksChanged(() => { fireCount++; });
    await store.deleteCollection(collection.id);
    assert.strictEqual(fireCount, 1);
  });

  test('deleteCollection renumbers ungrouped items contiguously with any pre-existing root items', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const rootItem = await store.addItem({ type: 'file', uri: 'file:///root.txt' });
    const collection = await store.addCollection('Work');
    const grouped = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });

    await store.deleteCollection(collection.id);

    const data = store.getAll();
    const byId = (id: string) => data.items.find((i) => i.id === id)!;
    const orders = [byId(rootItem.id).order, byId(grouped.id).order].sort((a, b) => a - b);
    assert.deepStrictEqual(orders, [0, 1]);
  });

  test('deleteCollection keeps the earliest orphan when legacy data contains duplicate uris', async () => {
    const duplicateUri = 'file:///duplicate.txt';
    const collectionId = 'legacy-collection';
    const data: BookmarkData = {
      version: 1,
      items: [
        { id: 'root', type: 'file', uri: 'file:///root.txt', collectionId: null, order: 0 },
        { id: 'later', type: 'folder', uri: duplicateUri, collectionId, order: 1 },
        { id: 'earliest', type: 'file', uri: duplicateUri, collectionId, order: 0 }
      ],
      collections: [{ id: collectionId, name: 'Legacy', order: 0 }]
    };
    const store = new BookmarkStore(new FakeMemento({ 'bookmarks.data': data }));

    await store.deleteCollection(collectionId);

    const duplicateRootItems = store.getAll().items.filter(
      (item) => item.collectionId === null && item.uri === duplicateUri
    );
    assert.strictEqual(duplicateRootItems.length, 1);
    assert.strictEqual(duplicateRootItems[0].id, 'earliest');
    assert.strictEqual(duplicateRootItems[0].order, 1);
    assert.ok(store.getAll().items.some((item) => item.id === 'root' && item.collectionId === null));
  });

  test('deleteCollection keeps an existing root item instead of a colliding orphan', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const duplicateUri = 'file:///same.txt';
    const rootItem = await store.addItem({ type: 'file', uri: duplicateUri });
    const rootItemBeforeDelete = structuredClone(rootItem);
    const collection = await store.addCollection('Work');
    await store.addItem({
      type: 'folder',
      uri: duplicateUri,
      collectionId: collection.id
    });
    await store.addItem({
      type: 'file',
      uri: 'file:///unique.txt',
      collectionId: collection.id
    });

    await store.deleteCollection(collection.id);

    const rootItems = store.getAll().items
      .filter((item) => item.collectionId === null)
      .sort((a, b) => a.order - b.order);
    assert.strictEqual(rootItems.length, 2);
    assert.deepStrictEqual(
      rootItems.map((item) => item.uri),
      [duplicateUri, 'file:///unique.txt']
    );
    assert.deepStrictEqual(rootItems[0], rootItemBeforeDelete);
  });

  test('deleteCollection preserves item order established by moveItem when ungrouping', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const a = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const b = await store.addItem({ type: 'file', uri: 'file:///b.txt', collectionId: collection.id });
    const c = await store.addItem({ type: 'file', uri: 'file:///c.txt', collectionId: collection.id });

    await store.moveItem(c.id, collection.id, 0);
    await store.deleteCollection(collection.id);

    const rootItems = store.getAll().items
      .filter((i) => i.collectionId === null)
      .sort((x, y) => x.order - y.order);
    assert.deepStrictEqual(rootItems.map((i) => i.id), [c.id, a.id, b.id]);
  });

  test('deleteCollection on an unknown id is a no-op', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.deleteCollection('does-not-exist');
    assert.strictEqual(store.getAll().collections.length, 0);
  });
});

suite('BookmarkStore - schema migration', () => {
  const v1Stored = {
    version: 1,
    items: [{ id: 'i1', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 }],
    collections: [{ id: 'c1', name: 'Work', order: 0 }]
  };

  test('loads v1 workspaceState data as v2, with descriptions left undefined', () => {
    const store = new BookmarkStore(new FakeMemento({ 'bookmarks.data': v1Stored }));
    const data = store.getAll();

    assert.strictEqual(data.version, 2);
    assert.strictEqual(data.items.length, 1);
    assert.strictEqual(data.items[0].id, 'i1');
    assert.strictEqual(data.items[0].description, undefined);
    assert.strictEqual(data.collections[0].description, undefined);
  });

  test('logs one line when it migrates stored data', () => {
    const output = new FakeOutput();
    new BookmarkStore(new FakeMemento({ 'bookmarks.data': v1Stored }), output);
    assert.strictEqual(output.lines.length, 1);
    assert.ok(output.lines[0].includes('1'), 'the log line should name the version it migrated from');
  });

  test('does not write to workspaceState during migration — the next mutation persists v2', async () => {
    const memento = new FakeMemento({ 'bookmarks.data': v1Stored });
    const store = new BookmarkStore(memento);
    assert.strictEqual(memento.updateCallCount, 0, 'loading must not write');

    await store.addItem({ type: 'file', uri: 'file:///b.txt' });

    const persisted = memento.get<{ version: number }>('bookmarks.data')!;
    assert.strictEqual(persisted.version, 2);
    assert.strictEqual(memento.updateCallCount, 1);
  });

  test('falls back to an empty state when stored data is from a newer schema version', () => {
    const output = new FakeOutput();
    const store = new BookmarkStore(
      new FakeMemento({ 'bookmarks.data': { version: 99, items: [], collections: [] } }),
      output
    );
    assert.deepStrictEqual(store.getAll(), { version: 2, items: [], collections: [] });
    assert.strictEqual(output.lines.length, 1);
  });
});

suite('BookmarkStore - descriptions', () => {
  test('setItemDescription sets a trimmed description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });

    await store.setItemDescription(item.id, '  the entrypoint  ');

    assert.strictEqual(store.getAll().items[0].description, 'the entrypoint');
  });

  test('setItemDescription with an empty string clears the description entirely', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'note');

    await store.setItemDescription(item.id, '');

    const stored = store.getAll().items[0];
    assert.strictEqual(stored.description, undefined);
    assert.strictEqual('description' in stored, false, 'the key must be deleted, not set to ""');
  });

  test('setItemDescription with whitespace only also clears it', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'note');

    await store.setItemDescription(item.id, '   ');

    assert.strictEqual(store.getAll().items[0].description, undefined);
  });

  test('setItemDescription fires onBookmarksChanged exactly once per real change', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    let fireCount = 0;
    store.onBookmarksChanged(() => { fireCount++; });

    await store.setItemDescription(item.id, 'note');

    assert.strictEqual(fireCount, 1);
  });

  test('setItemDescription is a no-op when the value is unchanged', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'note');
    const callsBefore = memento.updateCallCount;
    let fireCount = 0;
    store.onBookmarksChanged(() => { fireCount++; });

    await store.setItemDescription(item.id, 'note');

    assert.strictEqual(memento.updateCallCount, callsBefore);
    assert.strictEqual(fireCount, 0);
  });

  test('setItemDescription on an unknown id is a no-op', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    const callsBefore = memento.updateCallCount;
    await store.setItemDescription('does-not-exist', 'note');
    assert.strictEqual(memento.updateCallCount, callsBefore);
  });

  test('setCollectionDescription sets and clears a collection description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');

    await store.setCollectionDescription(collection.id, 'work-related bookmarks');
    assert.strictEqual(store.getAll().collections[0].description, 'work-related bookmarks');

    await store.setCollectionDescription(collection.id, '');
    assert.strictEqual(store.getAll().collections[0].description, undefined);
  });

  test('setCollectionDescription on an unknown id is a no-op', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.setCollectionDescription('does-not-exist', 'note');
    assert.strictEqual(store.getAll().collections.length, 0);
  });

  test('a description survives moveItem across collections', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'note');

    await store.moveItem(item.id, collection.id, 0);

    assert.strictEqual(store.getAll().items[0].description, 'note');
  });

  test('a description survives deleteCollection ungrouping', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    await store.setItemDescription(item.id, 'note');

    await store.deleteCollection(collection.id);

    assert.strictEqual(store.getAll().items[0].description, 'note');
    assert.strictEqual(store.getAll().items[0].collectionId, null);
  });
});
