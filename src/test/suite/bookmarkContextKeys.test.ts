import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  BOOKMARKED_RESOURCE_CONTEXT_KEY,
  buildBookmarkedResourceKeys,
  BookmarkContextKeyDeps,
  BookmarkContextKeyManager
} from '../../bookmarkContextKeys';
// Namespace import (not a named import) so the not-yet-implemented #120 exports
// (WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY / GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY) and the
// not-yet-implemented BookmarkContextKeyManager scoped surface (wireScoped /
// getWorkspaceBookmarkedResourceKeys / getGlobalBookmarkedResourceKeys) can be resolved dynamically
// below without a compile-time failure on the missing exports/members — a compile error is not a
// valid "red" for this suite (mirrors the existing convention in extension.test.ts's
// `registerSuggestionsMaxItemsLiveReload` suite). The assertions inside `requireScopedContextKeys()`
// and `requireScopedSurface()` are the intended failure mode until #120 adds these.
import * as bookmarkContextKeysModule from '../../bookmarkContextKeys';
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
//
// #119 amendment: that parity requirement is superseded for the win32 case. `decorationUriKey`'s
// win32 branch fully lower-cases `fsPath` — a normalization that only needs to hold between two
// values *we* control (the decoration map's own keys). This context array's other comparison side
// is VS Code's own live `resourcePath` when-clause value, which the `in` operator compares by
// strict string equality and which VS Code never lower-cases beyond `Uri.fsPath`'s own built-in
// drive-letter normalization. So `buildBookmarkedResourceKeys` must key `file:` URIs by plain,
// unmodified `uri.fsPath` — never platform-gated — even though that now diverges from
// `decorationUriKey` on win32. See the `#119` tests below, which pin the corrected contract.

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

  // #119 regression: package.json's `when` clauses compare this array's entries against VS Code's
  // own live `resourcePath` context value with strict string equality (`resourcePath in
  // bookmarksPlus.bookmarkedResourceUris`) — and `resourcePath` is never lower-cased by VS Code
  // beyond the drive-letter normalization `Uri.fsPath` itself already does. `decorationUriKey`'s
  // win32 branch, by contrast, lower-cases the *entire* fsPath — a normalization that makes sense
  // for the #109 star-badge map (where both sides of the comparison are ours to normalize) but not
  // here, where the other side of the `in` comparison is VS Code's own unmodified value. Keying
  // this array via `decorationUriKey` therefore breaks the Windows "Remove Bookmark" menu item for
  // any bookmark whose path has an uppercase letter past the drive letter. The fix: key `file:`
  // URIs by plain `uri.fsPath`, unconditionally — never platform-gated, never lower-cased — so this
  // stub (forcing the win32 branch open on this suite's actual `ubuntu-latest` CI host) must have
  // no effect on the result once fixed.
  test('#119: keys a file: URI by its exact fsPath casing, not decorationUriKey\'s win32 full lower-casing', () => {
    const uri = vscode.Uri.file('/workspace/MyFile.txt');
    const expectedKey = uri.fsPath;
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, enumerable: true });
    let keys: string[];
    try {
      keys = buildBookmarkedResourceKeys([[item({ uri: uri.toString() })]]);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        enumerable: true
      });
    }

    assert.deepStrictEqual(
      keys,
      [expectedKey],
      'the key must preserve fsPath casing exactly, even when process.platform is win32'
    );
  });

  test('#119: a non-file-scheme uri still falls back to its full toString(), independent of the file-scheme keying change', () => {
    const uri = vscode.Uri.parse('untitled:Untitled-1', true);
    const keys = buildBookmarkedResourceKeys([[item({ uri: uri.toString() })]]);
    assert.deepStrictEqual(keys, [uri.toString()]);
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

// Issue #120 regression: `wire()`/`getBookmarkedResourceKeys()` above (unchanged by this suite —
// see the #114 suite immediately above) publish the *union* of every wired store's bookmarked
// resources into a single context key. package.json's `when` clauses gate both
// `bookmarks.addFile` (workspace-scope add) and `bookmarks.addFileGlobal` (global-scope add) off
// that one merged key, so a file bookmarked in workspace scope only makes the merged key contain
// it, which incorrectly suppresses "Add Bookmark (Global)" too (and symmetrically for a
// global-only bookmark suppressing plain "Add Bookmark").
//
// Fix contract pinned here: `BookmarkContextKeyManager` must additionally expose a scoped surface
// that computes and publishes two independent context-key sets — one from the workspace store
// only, one from the global store only:
//   - `WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY` = 'bookmarksPlus.workspaceBookmarkedResourceUris'
//   - `GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY'   = 'bookmarksPlus.globalBookmarkedResourceUris'
//   - `wireScoped({ workspace, global })` wires both stores, publishing each scope's key
//     independently (mirroring `ScopedStores` in commands.ts, not `wire()`'s BookmarkStore[]).
//   - `getWorkspaceBookmarkedResourceKeys()` / `getGlobalBookmarkedResourceKeys()` expose each
//     scope's currently-published set.
// This is additive to the existing `wire()` / `getBookmarkedResourceKeys()` surface, not a
// replacement — those keep their #114 union behavior and their existing tests are left unchanged
// above. See `extension.test.ts`'s "menus — per-scope bookmark context keys (issue #120)" suite for
// the corresponding package.json `when`-clause assertions, which must agree with these exact key
// name strings.
suite('BookmarkContextKeyManager — per-scope context keys (#120)', () => {
  const WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY = 'bookmarksPlus.workspaceBookmarkedResourceUris';
  const GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY = 'bookmarksPlus.globalBookmarkedResourceUris';

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

  /** Structural shape of the not-yet-implemented #120 scoped surface, accessed dynamically (see the
   * namespace-import comment at the top of this file) so referencing it doesn't fail `tsc` before
   * #120 lands. */
  interface ScopedContextKeySurface {
    wireScoped?: (stores: { workspace: BookmarkStore; global: BookmarkStore }) => void;
    getWorkspaceBookmarkedResourceKeys?: () => string[];
    getGlobalBookmarkedResourceKeys?: () => string[];
  }

  interface ScopedContextKeyModuleExports {
    WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY?: string;
    GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY?: string;
  }

  /** Asserts bookmarkContextKeys.ts exports the two pinned #120 context-key constants with the
   * exact expected string values, and returns them. This is the intended clean "red" for this
   * suite until #120 adds the exports. */
  function requireScopedContextKeyConstants(): { workspaceKey: string; globalKey: string } {
    const exported = bookmarkContextKeysModule as unknown as ScopedContextKeyModuleExports;
    assert.strictEqual(
      exported.WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY,
      WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY,
      'expected bookmarkContextKeys.ts to export WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY = ' +
        `"${WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY}" (issue #120)`
    );
    assert.strictEqual(
      exported.GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY,
      GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY,
      'expected bookmarkContextKeys.ts to export GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY = ' +
        `"${GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY}" (issue #120)`
    );
    return {
      workspaceKey: exported.WORKSPACE_BOOKMARKED_RESOURCE_CONTEXT_KEY as string,
      globalKey: exported.GLOBAL_BOOKMARKED_RESOURCE_CONTEXT_KEY as string
    };
  }

  /** Asserts `manager` exposes the #120 scoped surface (wireScoped + both scoped getters) and
   * returns it narrowed to non-optional members. This is the intended clean "red" for this suite
   * until #120 adds these members to `BookmarkContextKeyManager`. */
  function requireScopedSurface(manager: BookmarkContextKeyManager): Required<ScopedContextKeySurface> {
    const scoped = manager as unknown as ScopedContextKeySurface;
    assert.strictEqual(
      typeof scoped.wireScoped,
      'function',
      'expected BookmarkContextKeyManager to expose wireScoped({ workspace, global }) (issue #120)'
    );
    assert.strictEqual(
      typeof scoped.getWorkspaceBookmarkedResourceKeys,
      'function',
      'expected BookmarkContextKeyManager to expose getWorkspaceBookmarkedResourceKeys() (issue #120)'
    );
    assert.strictEqual(
      typeof scoped.getGlobalBookmarkedResourceKeys,
      'function',
      'expected BookmarkContextKeyManager to expose getGlobalBookmarkedResourceKeys() (issue #120)'
    );
    return scoped as Required<ScopedContextKeySurface>;
  }

  test('bookmarkContextKeys.ts exports the two pinned per-scope context-key names', () => {
    requireScopedContextKeyConstants();
  });

  test('wiring both scopes publishes each scope\'s own keys — not a merged union', async () => {
    const { workspaceKey, globalKey } = requireScopedContextKeyConstants();
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const workspaceUri = vscode.Uri.file('/workspace/a.txt');
    const globalUri = vscode.Uri.file('/home/user/b.txt');
    await workspaceStore.addItem({ type: 'file', uri: workspaceUri.toString() });
    await globalStore.addItem({ type: 'file', uri: globalUri.toString() });
    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    const scoped = requireScopedSurface(manager);

    scoped.wireScoped({ workspace: workspaceStore, global: globalStore });

    assert.deepStrictEqual(
      scoped.getWorkspaceBookmarkedResourceKeys(),
      [decorationUriKey(workspaceUri)],
      'the workspace-scope getter must reflect only the workspace store\'s bookmarks'
    );
    assert.deepStrictEqual(
      scoped.getGlobalBookmarkedResourceKeys(),
      [decorationUriKey(globalUri)],
      'the global-scope getter must reflect only the global store\'s bookmarks'
    );

    const workspaceCall = calls.find((call) => call.key === workspaceKey);
    assert.ok(workspaceCall, `expected a setContext call publishing "${workspaceKey}"`);
    assert.deepStrictEqual(
      workspaceCall!.value,
      [decorationUriKey(workspaceUri)],
      `the published value for "${workspaceKey}" must contain only the workspace store's bookmarks`
    );

    const globalCall = calls.find((call) => call.key === globalKey);
    assert.ok(globalCall, `expected a setContext call publishing "${globalKey}"`);
    assert.deepStrictEqual(
      globalCall!.value,
      [decorationUriKey(globalUri)],
      `the published value for "${globalKey}" must contain only the global store's bookmarks`
    );
  });

  test('a file bookmarked in the workspace store only is absent from the global-scope key (must remain eligible for global-add)', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/only-workspace.txt');
    await workspaceStore.addItem({ type: 'file', uri: uri.toString() });
    const { deps } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    const scoped = requireScopedSurface(manager);

    scoped.wireScoped({ workspace: workspaceStore, global: globalStore });

    assert.deepStrictEqual(
      scoped.getWorkspaceBookmarkedResourceKeys(),
      [decorationUriKey(uri)],
      'the workspace-scope key must contain the workspace-only bookmark'
    );
    assert.ok(
      !scoped.getGlobalBookmarkedResourceKeys().includes(decorationUriKey(uri)),
      'a workspace-only bookmark must NOT appear in the global-scope key — otherwise ' +
        '"Add Bookmark (Global)" would be incorrectly suppressed for this resource (issue #120)'
    );
  });

  test('a file bookmarked in the global store only is absent from the workspace-scope key (must remain eligible for workspace-add)', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/home/user/only-global.txt');
    await globalStore.addItem({ type: 'file', uri: uri.toString() });
    const { deps } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    const scoped = requireScopedSurface(manager);

    scoped.wireScoped({ workspace: workspaceStore, global: globalStore });

    assert.deepStrictEqual(
      scoped.getGlobalBookmarkedResourceKeys(),
      [decorationUriKey(uri)],
      'the global-scope key must contain the global-only bookmark'
    );
    assert.ok(
      !scoped.getWorkspaceBookmarkedResourceKeys().includes(decorationUriKey(uri)),
      'a global-only bookmark must NOT appear in the workspace-scope key — otherwise plain ' +
        '"Add Bookmark" would be incorrectly suppressed for this resource (issue #120)'
    );
  });

  test('a file bookmarked in both scopes appears in both per-scope keys', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/in-both.txt');
    await workspaceStore.addItem({ type: 'file', uri: uri.toString() });
    await globalStore.addItem({ type: 'file', uri: uri.toString() });
    const { deps } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    const scoped = requireScopedSurface(manager);

    scoped.wireScoped({ workspace: workspaceStore, global: globalStore });

    assert.deepStrictEqual(
      scoped.getWorkspaceBookmarkedResourceKeys(),
      [decorationUriKey(uri)],
      'a resource bookmarked in both scopes must still appear in the workspace-scope key'
    );
    assert.deepStrictEqual(
      scoped.getGlobalBookmarkedResourceKeys(),
      [decorationUriKey(uri)],
      'a resource bookmarked in both scopes must still appear in the global-scope key'
    );
  });

  test('adding a global bookmark republishes only the global-scope key; the workspace-scope key/publish is unaffected', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const workspaceUri = vscode.Uri.file('/workspace/a.txt');
    await workspaceStore.addItem({ type: 'file', uri: workspaceUri.toString() });
    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    const scoped = requireScopedSurface(manager);
    scoped.wireScoped({ workspace: workspaceStore, global: globalStore });
    const { workspaceKey } = requireScopedContextKeyConstants();
    const workspacePublishesBefore = calls.filter((call) => call.key === workspaceKey).length;

    const globalUri = vscode.Uri.file('/home/user/b.txt');
    await globalStore.addItem({ type: 'file', uri: globalUri.toString() });

    assert.deepStrictEqual(
      scoped.getWorkspaceBookmarkedResourceKeys(),
      [decorationUriKey(workspaceUri)],
      'adding a global bookmark must not change the workspace-scope key\'s contents'
    );
    assert.deepStrictEqual(
      scoped.getGlobalBookmarkedResourceKeys(),
      [decorationUriKey(globalUri)],
      'the global-scope key must now reflect the newly added global bookmark'
    );
    const workspacePublishesAfter = calls.filter((call) => call.key === workspaceKey).length;
    assert.strictEqual(
      workspacePublishesAfter,
      workspacePublishesBefore,
      'adding a global bookmark must not trigger a redundant re-publish of the workspace-scope key'
    );
  });

  test('removing a workspace bookmark republishes only the workspace-scope key; the global-scope key/publish is unaffected', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento());
    const globalStore = new BookmarkStore(new FakeMemento());
    const workspaceUri = vscode.Uri.file('/workspace/a.txt');
    const workspaceItem = await workspaceStore.addItem({ type: 'file', uri: workspaceUri.toString() });
    const globalUri = vscode.Uri.file('/home/user/b.txt');
    await globalStore.addItem({ type: 'file', uri: globalUri.toString() });
    const { deps, calls } = makeDeps();
    const manager = new BookmarkContextKeyManager(deps);
    const scoped = requireScopedSurface(manager);
    scoped.wireScoped({ workspace: workspaceStore, global: globalStore });
    const { globalKey } = requireScopedContextKeyConstants();
    const globalPublishesBefore = calls.filter((call) => call.key === globalKey).length;

    await workspaceStore.removeItem(workspaceItem.id);

    assert.deepStrictEqual(
      scoped.getWorkspaceBookmarkedResourceKeys(),
      [],
      'removing the workspace bookmark must clear the workspace-scope key'
    );
    assert.deepStrictEqual(
      scoped.getGlobalBookmarkedResourceKeys(),
      [decorationUriKey(globalUri)],
      'removing a workspace bookmark must not change the global-scope key\'s contents'
    );
    const globalPublishesAfter = calls.filter((call) => call.key === globalKey).length;
    assert.strictEqual(
      globalPublishesAfter,
      globalPublishesBefore,
      'removing a workspace bookmark must not trigger a redundant re-publish of the global-scope key'
    );
  });
});
