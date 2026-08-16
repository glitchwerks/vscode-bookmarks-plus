import * as assert from 'assert';
import { BookmarkStore, DuplicateBookmarkError } from '../../bookmarkStore';
import { BookmarkData } from '../../types';
import { hashContent } from '../../bookmarkMirror';
import { FakeMemento, FakeMirror, FakeOutput, sleep } from './fixtures';

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

suite('BookmarkStore - mirror writes', () => {
  function storeWith(mirror: FakeMirror, memento = new FakeMemento(), output = new FakeOutput()) {
    return new BookmarkStore(memento, output, { mirror, writeDelayMs: 5 });
  }

  test('a mutation writes the mirror file with the current data', async () => {
    const mirror = new FakeMirror();
    const store = storeWith(mirror);

    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();

    assert.strictEqual(mirror.writeCount, 1);
    const written = JSON.parse(mirror.content!);
    assert.strictEqual(written.version, 2);
    assert.strictEqual(written.items.length, 1);
    assert.strictEqual(written.items[0].uri, 'file:///a.txt');
  });

  test('a burst of mutations coalesces into a single mirror write', async () => {
    const mirror = new FakeMirror();
    const store = storeWith(mirror);

    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    await store.addItem({ type: 'file', uri: 'file:///c.txt' });
    await store.flushMirrorWrites();

    assert.strictEqual(mirror.writeCount, 1, 'three rapid mutations must produce one file write');
    assert.strictEqual(JSON.parse(mirror.content!).items.length, 3);
  });

  test('the mirror hash is recorded only after the write succeeds', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });

    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    assert.strictEqual(
      memento.get('bookmarks.mirrorHash'),
      undefined,
      'the hash must not be recorded while the write is only scheduled'
    );

    await store.flushMirrorWrites();
    assert.strictEqual(memento.get('bookmarks.mirrorHash'), hashContent(mirror.content!));
  });

  test('a failed mirror write records the dirty state and logs one line', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const output = new FakeOutput();
    const store = new BookmarkStore(memento, output, { mirror, writeDelayMs: 5 });

    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();
    assert.ok(memento.get('bookmarks.mirrorHash'));
    const linesBeforeFailure = output.lines.length;

    mirror.failNextWrite = true;
    await store.addItem({ type: 'file', uri: 'file:///b.txt' });
    await store.flushMirrorWrites();

    assert.strictEqual(memento.get('bookmarks.mirrorDirty'), true);
    assert.strictEqual(
      output.lines.length,
      linesBeforeFailure + 1,
      'the failed write must log exactly one additional line'
    );
  });

  test('a store with no mirror performs no extra workspaceState writes', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);

    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();

    assert.strictEqual(memento.updateCallCount, 1, 'exactly one update() for the bookmark data, nothing else');
    assert.deepStrictEqual(memento.keys(), ['bookmarks.data']);
  });

  test('dispose cancels a pending mirror write', async () => {
    const mirror = new FakeMirror();
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput(), { mirror, writeDelayMs: 5 });

    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    store.dispose();
    await sleep(30);

    assert.strictEqual(mirror.writeCount, 0);
  });
});

suite('BookmarkStore - syncWithMirror (activation reconcile)', () => {
  function fileContent(items: unknown[], version = 2, collections: unknown[] = []): string {
    return `${JSON.stringify({ version, items, collections }, null, 2)}\n`;
  }

  test('seeds a missing mirror file from workspaceState', async () => {
    const mirror = new FakeMirror(undefined);
    const memento = new FakeMemento({
      'bookmarks.data': {
        version: 2,
        items: [{ id: 'i1', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 }],
        collections: []
      }
    });
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });

    await store.syncWithMirror();

    assert.strictEqual(mirror.writeCount, 1);
    assert.strictEqual(JSON.parse(mirror.content!).items[0].id, 'i1');
    assert.strictEqual(memento.get('bookmarks.mirrorHash'), hashContent(mirror.content!));
  });

  test('does nothing when the file matches the recorded hash', async () => {
    const content = fileContent([{ id: 'i1', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 }]);
    const mirror = new FakeMirror(content);
    const memento = new FakeMemento({
      'bookmarks.data': { version: 2, items: [], collections: [] },
      'bookmarks.mirrorHash': hashContent(content)
    });
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });
    let fired = false;
    store.onBookmarksChanged(() => { fired = true; });

    await store.syncWithMirror();

    assert.deepStrictEqual(store.getAll().items, [], 'workspaceState wins when the file has not changed');
    assert.strictEqual(mirror.writeCount, 0);
    assert.strictEqual(fired, false);
  });

  test('adopts the file when its hash differs from the recorded hash', async () => {
    const stale = fileContent([]);
    const current = fileContent([{ id: 'external', type: 'file', uri: 'file:///new.txt', collectionId: null, order: 0 }]);
    const mirror = new FakeMirror(current);
    const memento = new FakeMemento({
      'bookmarks.data': { version: 2, items: [], collections: [] },
      'bookmarks.mirrorHash': hashContent(stale)
    });
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });
    let fireCount = 0;
    store.onBookmarksChanged(() => { fireCount++; });

    await store.syncWithMirror();

    assert.deepStrictEqual(store.getAll().items.map((i) => i.id), ['external']);
    assert.strictEqual(fireCount, 1, 'adoption fires the domain event exactly once');
    assert.strictEqual(
      (memento.get('bookmarks.data') as { items: unknown[] }).items.length,
      1,
      'adoption must write the adopted data back to workspaceState'
    );
    assert.strictEqual(memento.get('bookmarks.mirrorHash'), hashContent(current));
  });

  test('adopts a v1 mirror file, migrating it to v2', async () => {
    const v1 = fileContent([{ id: 'i1', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 }], 1);
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput(), {
      mirror: new FakeMirror(v1),
      writeDelayMs: 5
    });

    await store.syncWithMirror();

    assert.strictEqual(store.getAll().version, 2);
    assert.deepStrictEqual(store.getAll().items.map((i) => i.id), ['i1']);
    assert.strictEqual(store.getAll().items[0].description, undefined);
  });

  test('keeps the last known good state when the file is not valid JSON', async () => {
    const memento = new FakeMemento({
      'bookmarks.data': {
        version: 2,
        items: [{ id: 'kept', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 }],
        collections: []
      }
    });
    const mirror = new FakeMirror('{ this is not json');
    const output = new FakeOutput();
    const store = new BookmarkStore(memento, output, { mirror, writeDelayMs: 5 });

    await store.syncWithMirror();

    assert.deepStrictEqual(store.getAll().items.map((i) => i.id), ['kept']);
    assert.strictEqual(mirror.content, '{ this is not json', 'a broken hand-edit is left alone, not clobbered');
    assert.ok(output.lines.length >= 1);
  });

  test('keeps the last known good state when the file has a malformed item', async () => {
    const memento = new FakeMemento({
      'bookmarks.data': {
        version: 2,
        items: [{ id: 'kept', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 }],
        collections: []
      }
    });
    const store = new BookmarkStore(memento, new FakeOutput(), {
      mirror: new FakeMirror(fileContent([{ nope: true }])),
      writeDelayMs: 5
    });

    await store.syncWithMirror();

    assert.deepStrictEqual(store.getAll().items.map((i) => i.id), ['kept']);
  });

  test('never adopts a file written by a newer schema version', async () => {
    const future = fileContent([], 99);
    const memento = new FakeMemento({
      'bookmarks.data': {
        version: 2,
        items: [{ id: 'kept', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 }],
        collections: []
      }
    });
    const mirror = new FakeMirror(future);
    const output = new FakeOutput();
    const store = new BookmarkStore(memento, output, { mirror, writeDelayMs: 5 });

    await store.syncWithMirror();

    assert.deepStrictEqual(store.getAll().items.map((i) => i.id), ['kept']);
    assert.strictEqual(mirror.content, future, 'a newer-version file must not be overwritten at activation');
    assert.ok(output.lines.length >= 1);
  });

  test('a read failure is logged and leaves the store untouched', async () => {
    const mirror = new FakeMirror(fileContent([]));
    mirror.failNextRead = true;
    const output = new FakeOutput();
    const store = new BookmarkStore(new FakeMemento(), output, { mirror, writeDelayMs: 5 });
    const linesBefore = output.lines.length;

    await store.syncWithMirror();

    assert.strictEqual(output.lines.length, linesBefore + 1);
    assert.strictEqual(mirror.writeCount, 0);
  });

  test('retries a dirty mirror from workspaceState without adopting stale content', async () => {
    const staleContent = fileContent([
      { id: 'stale', type: 'file', uri: 'file:///stale.txt', collectionId: null, order: 0 }
    ]);
    const mirror = new FakeMirror(staleContent);
    const memento = new FakeMemento({
      'bookmarks.data': { version: 2, items: [], collections: [] },
      'bookmarks.mirrorHash': hashContent(staleContent)
    });
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });

    mirror.failNextWrite = true;
    const added = await store.addItem({ type: 'file', uri: 'file:///new.txt' });
    await store.flushMirrorWrites();
    await store.syncWithMirror();

    assert.deepStrictEqual(store.getAll().items.map((item) => item.id), [added.id]);
    assert.deepStrictEqual(JSON.parse(mirror.content!).items.map((item: { id: string }) => item.id), [added.id]);
    assert.strictEqual(memento.get('bookmarks.mirrorDirty'), undefined);
  });

  test('is a no-op when no mirror is attached', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    await store.syncWithMirror();
    assert.strictEqual(memento.updateCallCount, 0);
  });
});

suite('BookmarkStore - reloadFromMirror (external change)', () => {
  function fileContent(items: unknown[], collections: unknown[] = []): string {
    return `${JSON.stringify({ version: 2, items, collections }, null, 2)}\n`;
  }

  test('ignores an event whose file content is our own last write', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();

    let fired = false;
    store.onBookmarksChanged(() => { fired = true; });
    await store.reloadFromMirror();

    assert.strictEqual(fired, false, 'our own write must not trigger a reload');
    assert.strictEqual(mirror.writeCount, 1, 'and must not trigger another write');
  });

  test('adopts an external edit and fires the change event once', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();

    mirror.content = fileContent([
      { id: 'external', type: 'file', uri: 'file:///b.txt', collectionId: null, order: 0, description: 'added by MCP' }
    ]);

    let fireCount = 0;
    store.onBookmarksChanged(() => { fireCount++; });
    await store.reloadFromMirror();

    assert.deepStrictEqual(store.getAll().items.map((i) => i.id), ['external']);
    assert.strictEqual(store.getAll().items[0].description, 'added by MCP');
    assert.strictEqual(fireCount, 1);
    assert.strictEqual(memento.get('bookmarks.mirrorHash'), hashContent(mirror.content!));

    await store.reloadFromMirror();
    assert.strictEqual(fireCount, 1, 'the recorded hash must suppress an unchanged watcher echo');
  });

  test('keeps current data when the file is deleted, and logs', async () => {
    const mirror = new FakeMirror();
    const output = new FakeOutput();
    const store = new BookmarkStore(new FakeMemento(), output, { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();

    mirror.content = undefined;
    const linesBefore = output.lines.length;
    await store.reloadFromMirror();

    assert.strictEqual(store.getAll().items.length, 1, 'a deleted mirror file must never wipe the bookmarks');
    assert.strictEqual(output.lines.length, linesBefore + 1);
  });

  test('keeps the last known good state when an external write is malformed', async () => {
    const mirror = new FakeMirror();
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput(), { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();

    mirror.content = '{ broken';
    await store.reloadFromMirror();

    assert.strictEqual(store.getAll().items.length, 1);
  });

  test('repairs and rewrites data that violates the store invariants', async () => {
    const mirror = new FakeMirror();
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput(), { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.flushMirrorWrites();
    const writesBefore = mirror.writeCount;

    // Externally written: a dangling collectionId and a non-contiguous order.
    mirror.content = fileContent([
      { id: 'x', type: 'file', uri: 'file:///b.txt', collectionId: 'ghost', order: 7 }
    ]);
    await store.reloadFromMirror();
    await store.flushMirrorWrites();

    assert.strictEqual(store.getAll().items[0].collectionId, null);
    assert.strictEqual(store.getAll().items[0].order, 0);
    assert.strictEqual(mirror.writeCount, writesBefore + 1, 'repaired data is written back so the file converges');
    assert.strictEqual(JSON.parse(mirror.content!).items[0].order, 0);
  });

  test('is a no-op when no mirror is attached', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);
    await store.reloadFromMirror();
    assert.strictEqual(memento.updateCallCount, 0);
  });
});

// Characterization test for T2 (#55): a store built with no `mirror` option is already safe to
// reuse unmodified for the (mirror-less) global store, because `syncWithMirror()` and
// `reloadFromMirror()` both guard on the absence of a mirror. This locks in that existing
// behavior so a future change can't regress it; it is expected to pass today, not to be red.
suite('BookmarkStore - no-mirror store: mirror methods are always inert (T2 characterization)', () => {
  test('syncWithMirror and reloadFromMirror never throw and never write mirror bookkeeping keys', async () => {
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento);

    await assert.doesNotReject(() => store.syncWithMirror());
    await assert.doesNotReject(() => store.reloadFromMirror());

    assert.strictEqual(memento.get('bookmarks.mirrorHash'), undefined);
    assert.strictEqual(memento.get('bookmarks.mirrorDirty'), undefined);
    assert.ok(
      !memento.keys().includes('bookmarks.mirrorHash') && !memento.keys().includes('bookmarks.mirrorDirty'),
      'a store with no mirror option must never write mirror bookkeeping keys — this is what makes ' +
        'it safe to reuse BookmarkStore unmodified for the mirror-less global store in T2'
    );
  });
});
