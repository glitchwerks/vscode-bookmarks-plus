import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  decorationUriKey,
  buildDecoratedUriKeys,
  BookmarkDecorationProvider
} from '../../bookmarkDecorationProvider';
import { BookmarkItem } from '../../types';
import { BookmarkStore } from '../../bookmarkStore';
import { FakeMemento, FakeMirror, FakeOutput } from './fixtures';

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

const NO_CANCELLATION = new vscode.CancellationTokenSource().token;

suite('decorationUriKey', () => {
  test('keys a file: URI by its fsPath', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    assert.strictEqual(decorationUriKey(uri, 'linux'), uri.fsPath);
  });

  test('keys a non-file-scheme URI by its full toString(), not fsPath', () => {
    const uri = vscode.Uri.parse('untitled:Untitled-1', true);
    assert.strictEqual(decorationUriKey(uri, 'linux'), uri.toString());
  });

  // C2 regression (docs/superpowers/plans/2026-08-25-explorer-decoration-for-bookmarked-files.md
  // §3): an externally-authored mirror entry can differ from the Explorer's own Uri in Windows
  // drive-letter case or URI escaping. These three literals are genuinely different textual
  // representations of the same Windows path — different case (C vs c) *and* different escaping
  // (a literal colon vs a percent-encoded one) — not the same uppercase-drive URI constructed
  // twice under different syntax.
  test('C2 regression: differing drive-letter case and URI escaping normalize to the same key on win32', () => {
    const uppercaseNoEscape = vscode.Uri.parse('file:///C:/tmp/a.txt');
    const lowercaseEscaped = vscode.Uri.parse('file:///c%3A/tmp/a.txt');
    const explorerStyle = vscode.Uri.file('c:/tmp/a.txt');

    const keyA = decorationUriKey(uppercaseNoEscape, 'win32');
    const keyB = decorationUriKey(lowercaseEscaped, 'win32');
    const keyC = decorationUriKey(explorerStyle, 'win32');

    assert.strictEqual(keyA, keyB);
    assert.strictEqual(keyB, keyC);
  });

  test('does not lower-case the fsPath when the platform is not win32', () => {
    const uri = vscode.Uri.parse('file:///Tmp/UPPER.txt');
    assert.strictEqual(decorationUriKey(uri, 'linux'), uri.fsPath);
  });
});

suite('buildDecoratedUriKeys', () => {
  test('an empty set of item groups (empty workspace and global stores) yields an empty key set', () => {
    const keys = buildDecoratedUriKeys([[], []]);
    assert.strictEqual(keys.size, 0);
  });

  test('returns the union of keys across multiple item groups (workspace + global stores, per D2)', () => {
    const workspaceUri = vscode.Uri.file('/workspace/a.txt');
    const globalUri = vscode.Uri.file('/home/user/b.txt');
    const workspaceItems = [item({ id: 'w1', uri: workspaceUri.toString() })];
    const globalItems = [item({ id: 'g1', uri: globalUri.toString() })];

    const keys = buildDecoratedUriKeys([workspaceItems, globalItems]);

    assert.strictEqual(keys.size, 2);
    assert.ok(keys.has(decorationUriKey(workspaceUri)));
    assert.ok(keys.has(decorationUriKey(globalUri)));
  });

  test('skips a malformed or relative stored uri without throwing, while still keying the other valid entries', () => {
    const validUri = vscode.Uri.file('/workspace/a.txt');
    const items = [
      item({ id: 'valid', uri: validUri.toString() }),
      item({ id: 'malformed', uri: 'not a valid uri with spaces' }),
      item({ id: 'relative', uri: 'src/relative/path.ts' })
    ];

    let keys: Set<string> | undefined;
    assert.doesNotThrow(() => {
      keys = buildDecoratedUriKeys([items]);
    });

    assert.strictEqual(keys!.size, 1, 'only the one valid item should produce a key');
    assert.ok(keys!.has(decorationUriKey(validUri)));
  });
});

suite('BookmarkDecorationProvider', () => {
  function keysFor(...items: BookmarkItem[]): Set<string> {
    return buildDecoratedUriKeys([items]);
  }

  test('returns the star badge and "Bookmarked" tooltip for a bookmarked uri, with no color set', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    const provider = new BookmarkDecorationProvider(keysFor(item({ uri: uri.toString() })));

    const decoration = provider.provideFileDecoration(uri, NO_CANCELLATION);

    assert.ok(decoration, 'expected a decoration for a bookmarked uri');
    const resolved = decoration as vscode.FileDecoration;
    assert.strictEqual(resolved.badge, '★');
    assert.strictEqual(resolved.tooltip, 'Bookmarked');
    assert.strictEqual(resolved.color, undefined, 'D1 decided against a color property (see plan §5 D1)');
  });

  test('returns undefined for a uri that is not bookmarked', () => {
    const bookmarked = vscode.Uri.file('/workspace/a.txt');
    const other = vscode.Uri.file('/workspace/b.txt');
    const provider = new BookmarkDecorationProvider(keysFor(item({ uri: bookmarked.toString() })));

    const decoration = provider.provideFileDecoration(other, NO_CANCELLATION);

    assert.strictEqual(decoration, undefined);
  });

  // C1 (plan §3): `propagate` must never be set, or a single bookmarked file would badge its
  // whole ancestor chain up to the workspace root.
  test('propagate is never set on a returned decoration (C1)', () => {
    const uri = vscode.Uri.file('/workspace/folder');
    const provider = new BookmarkDecorationProvider(keysFor(item({ type: 'folder', uri: uri.toString() })));

    const decoration = provider.provideFileDecoration(uri, NO_CANCELLATION);

    assert.ok(decoration);
    const resolved = decoration as vscode.FileDecoration;
    assert.strictEqual(resolved.propagate, undefined, 'propagate must be omitted entirely, not just falsy');
  });

  // C3 (plan §3): provideFileDecoration must do zero I/O — a Set/Map membership check only.
  test('provideFileDecoration returns synchronously, never a Promise/thenable (C3, R4)', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    const provider = new BookmarkDecorationProvider(keysFor(item({ uri: uri.toString() })));

    const result = provider.provideFileDecoration(uri, NO_CANCELLATION);

    const isThenable = result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function';
    assert.strictEqual(isThenable, false, 'provideFileDecoration must not return a Promise/thenable');
  });
});

// T2 (plan §6, C4): change-event wiring. The provider must subscribe to a BookmarkStore's
// `onBookmarksChanged`, recompute its decorated-key set, and fire `onDidChangeFileDecorations`
// exactly once per change, batched as the union of added+removed uris — never `undefined` (C4
// explicitly rejects "just fire undefined" as the landed pattern, modelling
// `GitDecorationProvider.onDidRunGitStatus`). `wire(stores)` and `onDidChangeFileDecorations` do
// not exist on `BookmarkDecorationProvider` yet (T1 only shipped the synchronous lookup surface),
// so these tests are expected to fail to compile until T2 adds them.
suite('BookmarkDecorationProvider - change-event wiring (T2, C4)', () => {
  /** `onDidChangeFileDecorations`'s payload is `undefined | Uri | Uri[]` per the vscode.d.ts shape
   * the plan cites (§2.2) — flatten it to a plain array regardless of which shape the
   * implementation chooses for a single-uri batch. */
  function flattenUris(event: vscode.Uri | vscode.Uri[] | undefined): vscode.Uri[] {
    if (event === undefined) {
      return [];
    }
    return Array.isArray(event) ? event : [event];
  }

  test('persist fire site: adding a bookmark through the store fires onDidChangeFileDecorations exactly once, including the added uri', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const provider = new BookmarkDecorationProvider(new Set());
    provider.wire([store]);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    const uri = vscode.Uri.file('/workspace/a.txt');
    await store.addItem({ type: 'file', uri: uri.toString() });

    assert.strictEqual(
      fired.length,
      1,
      'expected exactly one batched invalidation event for one persisted change'
    );
    assert.notStrictEqual(
      fired[0],
      undefined,
      'C4: must fire a targeted uri/uri[] batch, not undefined'
    );
    const changedKeys = flattenUris(fired[0]).map((u) => decorationUriKey(u));
    assert.ok(
      changedKeys.includes(decorationUriKey(uri)),
      'fired event must include the newly-bookmarked uri'
    );

    const decoration = provider.provideFileDecoration(uri, NO_CANCELLATION);
    assert.ok(
      decoration,
      'the provider must have recomputed its decorated-key set from the persisted change'
    );
  });

  test('persist fire site: two sequential mutations each fire their own single batched event, not a combined or missing one', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const provider = new BookmarkDecorationProvider(new Set());
    provider.wire([store]);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    const uriA = vscode.Uri.file('/workspace/a.txt');
    const uriB = vscode.Uri.file('/workspace/b.txt');
    await store.addItem({ type: 'file', uri: uriA.toString() });
    await store.addItem({ type: 'file', uri: uriB.toString() });

    assert.strictEqual(fired.length, 2, 'expected one event per persisted mutation');
    const secondChangedKeys = flattenUris(fired[1]).map((u) => decorationUriKey(u));
    assert.ok(
      secondChangedKeys.includes(decorationUriKey(uriB)),
      'the second event must include the second added uri'
    );
    assert.ok(
      !secondChangedKeys.includes(decorationUriKey(uriA)),
      'C4: each event is the diff for that change only (added ∪ removed since the last recompute) — ' +
        're-signalling every previously-decorated uri on every change is not the union-diff pattern the plan requires'
    );
  });

  test('persist fire site: removing a bookmark fires onDidChangeFileDecorations exactly once with the removed uri (C4 union includes removals)', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uri = vscode.Uri.file('/workspace/a.txt');
    const added = await store.addItem({ type: 'file', uri: uri.toString() });

    const provider = new BookmarkDecorationProvider(buildDecoratedUriKeys([store.getAll().items]));
    provider.wire([store]);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    await store.removeItem(added.id);

    assert.strictEqual(
      fired.length,
      1,
      'expected exactly one batched invalidation event for one persisted removal'
    );
    assert.notStrictEqual(
      fired[0],
      undefined,
      'C4: must fire a targeted uri/uri[] batch, not undefined'
    );
    const changedKeys = flattenUris(fired[0]).map((u) => decorationUriKey(u));
    assert.ok(
      changedKeys.includes(decorationUriKey(uri)),
      'a removed bookmark must be signalled so its stale badge clears from the Explorer'
    );

    const decoration = provider.provideFileDecoration(uri, NO_CANCELLATION);
    assert.strictEqual(
      decoration,
      undefined,
      'the provider must have actually recomputed its decorated-key set, not merely fired an event'
    );
  });

  test('mirror-reload fire site: adopting an externally-added bookmark fires onDidChangeFileDecorations exactly once, including the added uri', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });

    // Establish the mirror hash via a normal, internally-originated write first — matching the
    // existing "BookmarkStore - reloadFromMirror" fixture pattern in bookmarkStore.test.ts.
    await store.addItem({ type: 'file', uri: 'file:///workspace/a.txt' });
    await store.flushMirrorWrites();

    const provider = new BookmarkDecorationProvider(buildDecoratedUriKeys([store.getAll().items]));
    provider.wire([store]);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    const externalUri = vscode.Uri.file('/workspace/b.txt');
    mirror.content = `${JSON.stringify(
      {
        version: 2,
        items: [
          {
            id: 'external',
            type: 'file',
            uri: externalUri.toString(),
            collectionId: null,
            order: 0
          }
        ],
        collections: []
      },
      null,
      2
    )}\n`;

    await store.reloadFromMirror();

    assert.strictEqual(
      fired.length,
      1,
      'expected exactly one batched invalidation event for one mirror-adopted change'
    );
    assert.notStrictEqual(
      fired[0],
      undefined,
      'C4: must fire a targeted uri/uri[] batch, not undefined'
    );
    const changedKeys = flattenUris(fired[0]).map((u) => decorationUriKey(u));
    assert.ok(
      changedKeys.includes(decorationUriKey(externalUri)),
      'fired event must include the externally-bookmarked uri'
    );

    const decoration = provider.provideFileDecoration(externalUri, NO_CANCELLATION);
    assert.ok(
      decoration,
      'the provider must have recomputed its decorated-key set from the adopted mirror content'
    );
  });

  test('mirror-reload fire site: a watcher echo of our own last write does not fire an invalidation event', async () => {
    const mirror = new FakeMirror();
    const memento = new FakeMemento();
    const store = new BookmarkStore(memento, new FakeOutput(), { mirror, writeDelayMs: 5 });
    await store.addItem({ type: 'file', uri: 'file:///workspace/a.txt' });
    await store.flushMirrorWrites();

    const provider = new BookmarkDecorationProvider(buildDecoratedUriKeys([store.getAll().items]));
    provider.wire([store]);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    // No external edit — content is unchanged, so this models the watcher firing on our own write.
    await store.reloadFromMirror();

    assert.strictEqual(
      fired.length,
      0,
      'an unchanged mirror echo must not produce a decoration invalidation'
    );
  });
});

// T3 (plan §6): enabled-state behavior. `setEnabled(enabled: boolean): void` does not exist on
// `BookmarkDecorationProvider` yet, so these tests are expected to fail to compile until T3 adds
// it. Per the plan: no-op when the value is unchanged; when changed, update the state and fire
// `onDidChangeFileDecorations` exactly once with every currently indexed uri, so the Explorer
// updates immediately in either direction.
suite('BookmarkDecorationProvider - enabled state (T3)', () => {
  function keysFor(...items: BookmarkItem[]): Set<string> {
    return buildDecoratedUriKeys([items]);
  }

  /** Mirrors the T2 suite's flattening helper — see its comment above for the payload shape. */
  function flattenUris(event: vscode.Uri | vscode.Uri[] | undefined): vscode.Uri[] {
    if (event === undefined) {
      return [];
    }
    return Array.isArray(event) ? event : [event];
  }

  test('default-enabled: provideFileDecoration returns the badge for a bookmarked uri without any setEnabled call', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    const provider = new BookmarkDecorationProvider(keysFor(item({ uri: uri.toString() })));

    const decoration = provider.provideFileDecoration(uri, NO_CANCELLATION);

    assert.ok(decoration, 'a freshly constructed provider must be enabled by default');
    assert.strictEqual((decoration as vscode.FileDecoration).badge, '★');
  });

  test('disabled: provideFileDecoration returns undefined for a bookmarked uri after setEnabled(false)', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    const provider = new BookmarkDecorationProvider(keysFor(item({ uri: uri.toString() })));

    provider.setEnabled(false);
    const decoration = provider.provideFileDecoration(uri, NO_CANCELLATION);

    assert.strictEqual(
      decoration,
      undefined,
      'the decoration must be suppressed for a bookmarked uri while disabled'
    );
  });

  test('enabled -> disabled: setEnabled(false) fires onDidChangeFileDecorations exactly once with every currently indexed uri', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uriA = vscode.Uri.file('/workspace/a.txt');
    const uriB = vscode.Uri.file('/workspace/b.txt');
    await store.addItem({ type: 'file', uri: uriA.toString() });
    await store.addItem({ type: 'file', uri: uriB.toString() });

    const provider = new BookmarkDecorationProvider(new Set());
    provider.wire([store]);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    provider.setEnabled(false);

    assert.strictEqual(
      fired.length,
      1,
      'expected exactly one invalidation event for the enabled -> disabled transition'
    );
    assert.notStrictEqual(fired[0], undefined, 'must fire a targeted uri/uri[] batch, not undefined');
    const changedKeys = flattenUris(fired[0]).map((u) => decorationUriKey(u));
    assert.ok(
      changedKeys.includes(decorationUriKey(uriA)),
      'the batch must include every currently indexed uri, including uriA'
    );
    assert.ok(
      changedKeys.includes(decorationUriKey(uriB)),
      'the batch must include every currently indexed uri, including uriB'
    );

    const decoration = provider.provideFileDecoration(uriA, NO_CANCELLATION);
    assert.strictEqual(
      decoration,
      undefined,
      'the provider must actually be disabled after the transition, not merely have fired an event'
    );
  });

  test('disabled -> enabled: setEnabled(true) fires onDidChangeFileDecorations exactly once with every currently indexed uri', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uriA = vscode.Uri.file('/workspace/a.txt');
    const uriB = vscode.Uri.file('/workspace/b.txt');
    await store.addItem({ type: 'file', uri: uriA.toString() });
    await store.addItem({ type: 'file', uri: uriB.toString() });

    const provider = new BookmarkDecorationProvider(new Set());
    provider.wire([store]);
    provider.setEnabled(false);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    provider.setEnabled(true);

    assert.strictEqual(
      fired.length,
      1,
      'expected exactly one invalidation event for the disabled -> enabled transition'
    );
    assert.notStrictEqual(fired[0], undefined, 'must fire a targeted uri/uri[] batch, not undefined');
    const changedKeys = flattenUris(fired[0]).map((u) => decorationUriKey(u));
    assert.ok(
      changedKeys.includes(decorationUriKey(uriA)),
      'the batch must include every currently indexed uri, including uriA'
    );
    assert.ok(
      changedKeys.includes(decorationUriKey(uriB)),
      'the batch must include every currently indexed uri, including uriB'
    );

    const decoration = provider.provideFileDecoration(uriA, NO_CANCELLATION);
    assert.ok(
      decoration,
      'the provider must actually be re-enabled after the transition, not merely have fired an event'
    );
  });

  test('setEnabled(true) when already enabled (the default) is a no-op and does not fire onDidChangeFileDecorations', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    await store.addItem({ type: 'file', uri: vscode.Uri.file('/workspace/a.txt').toString() });

    const provider = new BookmarkDecorationProvider(new Set());
    provider.wire([store]);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    provider.setEnabled(true);

    assert.strictEqual(
      fired.length,
      0,
      'setEnabled(true) must be a no-op when the provider is already enabled'
    );
  });

  test('setEnabled(false) when already disabled is a no-op and does not fire onDidChangeFileDecorations', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    await store.addItem({ type: 'file', uri: vscode.Uri.file('/workspace/a.txt').toString() });

    const provider = new BookmarkDecorationProvider(new Set());
    provider.wire([store]);
    provider.setEnabled(false);

    const fired: (vscode.Uri | vscode.Uri[] | undefined)[] = [];
    provider.onDidChangeFileDecorations((event) => fired.push(event));

    provider.setEnabled(false);

    assert.strictEqual(
      fired.length,
      0,
      'setEnabled(false) must be a no-op when the provider is already disabled'
    );
  });
});
