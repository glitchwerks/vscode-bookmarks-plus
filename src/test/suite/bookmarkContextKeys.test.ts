import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  BOOKMARKED_RESOURCE_CONTEXT_KEY,
  buildBookmarkedResourceKeys,
  BookmarkContextKeyDeps,
  BookmarkContextKeyManager
} from '../../bookmarkContextKeys';
import { decorationUriKey } from '../../bookmarkDecorationProvider';
import { BookmarkData, BookmarkItem } from '../../types';
import { BookmarkStore } from '../../bookmarkStore';
import { FakeMemento, FakeMirror, FakeOutput } from './fixtures';

// #114: the Explorer/editor-title context menu needs a `when`-clause-visible signal for "is this
// resource already bookmarked" (VS Code's documented `resourceUri in <contextKey>` pattern, since
// arbitrary per-resource lookups aren't supported in `when` clauses directly). This module is the
// not-yet-existing home for that signal: `src/bookmarkContextKeys.ts`, exporting
// `BOOKMARKED_RESOURCE_CONTEXT_KEY` (the context key name registered in package.json's `when`
// clauses), the pure `buildBookmarkedResourceKeys` computation, and `BookmarkContextKeyManager`,
// which wires one or more `BookmarkStore`s to keep that context key's value current via an injected
// `setContext` dependency (mirroring the existing `AddToWorkspaceDeps` DI pattern in commands.ts).
//
// Key format: `buildBookmarkedResourceKeys` is contractually required to key resources exactly as
// `decorationUriKey` (from the already-shipped `bookmarkDecorationProvider.ts`, #109) does — so a
// resource that shows the star badge in the Explorer is exactly the set of resources this module
// reports as bookmarked. Reusing that existing, already-tested normalization (fsPath on a `file:`
// scheme, full `toString()` otherwise, win32 drive-letter/escaping normalization) keeps the two
// #109/#114 features consistent without re-deriving the same edge cases twice.

function item(overrides: Partial<BookmarkItem> = {}): BookmarkItem {
  return {
    id: 'item-1',
    type: 'file',
    uri: 'file:///a.txt',
    collectionId: null,
    order: 0,
    ...overrides
  };
}

suite('buildBookmarkedResourceKeys (#114)', () => {
  test('an empty set of item groups (empty workspace and global stores) yields an empty array', () => {
    const keys = buildBookmarkedResourceKeys([[], []]);
    assert.deepStrictEqual(keys, []);
  });

  test('keys resources using the same normalization as the decoration provider (uri identity parity)', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    const keys = buildBookmarkedResourceKeys([[item({ uri: uri.toString() })]]);
    assert.deepStrictEqual(keys, [decorationUriKey(uri)]);
  });

  test('returns the union of keys across multiple item groups (workspace + global stores)', () => {
    const workspaceUri = vscode.Uri.file('/workspace/a.txt');
    const globalUri = vscode.Uri.file('/home/user/b.txt');
    const workspaceItems = [item({ id: 'w1', uri: workspaceUri.toString() })];
    const globalItems = [item({ id: 'g1', uri: globalUri.toString() })];

    const keys = buildBookmarkedResourceKeys([workspaceItems, globalItems]);

    assert.deepStrictEqual(
      [...keys].sort(),
      [decorationUriKey(workspaceUri), decorationUriKey(globalUri)].sort()
    );
  });

  test('skips a malformed or relative stored uri without throwing, while still keying the other valid entries', () => {
    const validUri = vscode.Uri.file('/workspace/a.txt');
    const items = [
      item({ id: 'valid', uri: validUri.toString() }),
      item({ id: 'malformed', uri: 'not a valid uri with spaces' }),
      item({ id: 'relative', uri: 'src/relative/path.ts' })
    ];

    let keys: string[] | undefined;
    assert.doesNotThrow(() => {
      keys = buildBookmarkedResourceKeys([items]);
    });

    assert.deepStrictEqual(keys, [decorationUriKey(validUri)]);
  });

  test('folder bookmarks are included, not just files (folders keep their existing Add/Remove parity)', () => {
    const uri = vscode.Uri.file('/workspace/dir');
    const keys = buildBookmarkedResourceKeys([[item({ type: 'folder', uri: uri.toString() })]]);
    assert.deepStrictEqual(keys, [decorationUriKey(uri)]);
  });

  test('deduplicates a uri that appears in more than one group (e.g. bookmarked in both workspace and global scope)', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    const keys = buildBookmarkedResourceKeys([
      [item({ id: 'w', uri: uri.toString() })],
      [item({ id: 'g', uri: uri.toString() })]
    ]);
    assert.deepStrictEqual(keys, [decorationUriKey(uri)]);
  });
});

suite('BookmarkContextKeyManager (#114)', () => {
  interface RecordedSetContextCall {
    key: string;
    value: string[];
  }

  function makeDeps(): { deps: BookmarkContextKeyDeps; calls: RecordedSetContextCall[] } {
    const calls: RecordedSetContextCall[] = [];
    const deps: BookmarkContextKeyDeps = {
      setContext: (key: string, value: string[]) => {
        calls.push({ key, value: [...value] });
      }
    };
    return { deps, calls };
  }

  test('starts empty before any store is wired', () => {
    const { deps } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);

    assert.deepStrictEqual(manager.getBookmarkedResourceKeys(), []);
  });

  test('wiring a store that already has persisted items reflects that bulk state immediately (store load)', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    const data: BookmarkData = {
      version: 2,
      items: [{ id: 'preexisting', type: 'file', uri: uri.toString(), collectionId: null, order: 0 }],
      collections: []
    };
    const store = new BookmarkStore(new FakeMemento({ 'bookmarks.data': data }));
    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);

    manager.wire([store]);

    assert.deepStrictEqual(manager.getBookmarkedResourceKeys(), [decorationUriKey(uri)]);
    assert.ok(calls.length >= 1, 'wiring a pre-populated store must publish the initial context value');
    const last = calls[calls.length - 1];
    assert.strictEqual(last.key, BOOKMARKED_RESOURCE_CONTEXT_KEY);
    assert.deepStrictEqual(last.value, [decorationUriKey(uri)]);
  });

  test('adding a bookmark through the store adds its key and republishes the full array', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    manager.wire([store]);
    const callsBefore = calls.length;

    const uri = vscode.Uri.file('/workspace/a.txt');
    await store.addItem({ type: 'file', uri: uri.toString() });

    assert.deepStrictEqual(manager.getBookmarkedResourceKeys(), [decorationUriKey(uri)]);
    assert.ok(calls.length > callsBefore, 'adding a bookmark must republish the context value');
    assert.deepStrictEqual(calls[calls.length - 1].value, [decorationUriKey(uri)]);
  });

  test('removing a bookmark through the store drops its key and republishes the array without it', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/a.txt');
    const added = await store.addItem({ type: 'file', uri: uri.toString() });
    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    manager.wire([store]);
    const callsBefore = calls.length;

    await store.removeItem(added.id);

    assert.deepStrictEqual(manager.getBookmarkedResourceKeys(), []);
    assert.ok(calls.length > callsBefore, 'removing a bookmark must republish the context value');
    assert.deepStrictEqual(calls[calls.length - 1].value, []);
  });

  test('wiring both the workspace and global stores unions their bookmarked resource keys', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const workspaceUri = vscode.Uri.file('/workspace/a.txt');
    const globalUri = vscode.Uri.file('/home/user/b.txt');
    await workspaceStore.addItem({ type: 'file', uri: workspaceUri.toString() });
    await globalStore.addItem({ type: 'file', uri: globalUri.toString() });
    const { deps } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);

    manager.wire([workspaceStore, globalStore]);

    assert.deepStrictEqual(
      [...manager.getBookmarkedResourceKeys()].sort(),
      [decorationUriKey(workspaceUri), decorationUriKey(globalUri)].sort()
    );
  });

  test('a change in the global store does not drop the workspace store\'s keys, and vice versa', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const workspaceUri = vscode.Uri.file('/workspace/a.txt');
    const workspaceItem = await workspaceStore.addItem({ type: 'file', uri: workspaceUri.toString() });
    const { deps } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    manager.wire([workspaceStore, globalStore]);

    const globalUri = vscode.Uri.file('/home/user/b.txt');
    await globalStore.addItem({ type: 'file', uri: globalUri.toString() });

    assert.deepStrictEqual(
      [...manager.getBookmarkedResourceKeys()].sort(),
      [decorationUriKey(workspaceUri), decorationUriKey(globalUri)].sort(),
      'adding a global bookmark must not clear the workspace store\'s previously-published keys'
    );

    await workspaceStore.removeItem(workspaceItem.id);

    assert.deepStrictEqual(
      manager.getBookmarkedResourceKeys(),
      [decorationUriKey(globalUri)],
      'removing the workspace bookmark must not touch the still-bookmarked global resource'
    );
  });

  test('a mirror-driven reload republishes the full, recomputed key set (bulk reload, not a diff)', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///workspace/a.txt' });
    await store.flushMirrorWrites();

    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    manager.wire([store]);
    const callsBefore = calls.length;

    const externalUri = vscode.Uri.file('/workspace/b.txt');
    mirror.content = `${JSON.stringify(
      {
        version: 2,
        items: [
          { id: 'external', type: 'file', uri: externalUri.toString(), collectionId: null, order: 0 }
        ],
        collections: []
      },
      null,
      2
    )}\n`;

    await store.reloadFromMirror();

    assert.deepStrictEqual(manager.getBookmarkedResourceKeys(), [decorationUriKey(externalUri)]);
    assert.ok(calls.length > callsBefore, 'a mirror-adopted change must republish the context value');
    assert.deepStrictEqual(
      calls[calls.length - 1].value,
      [decorationUriKey(externalUri)],
      'the republished value must be the full recomputed set — the original a.txt bookmark was ' +
        'replaced by the external reload, not merged with it'
    );
  });

  test('an unchanged mirror echo does not republish the context value', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///workspace/a.txt' });
    await store.flushMirrorWrites();

    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    manager.wire([store]);
    const callsBefore = calls.length;

    // No external edit — content is unchanged, so this models the watcher firing on our own write.
    await store.reloadFromMirror();

    assert.strictEqual(
      calls.length,
      callsBefore,
      'an unchanged mirror echo must not produce a redundant context-value publish'
    );
  });
});
