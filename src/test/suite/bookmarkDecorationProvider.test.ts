import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  decorationUriKey,
  buildDecoratedUriKeys,
  BookmarkDecorationProvider
} from '../../bookmarkDecorationProvider';
import { BookmarkItem } from '../../types';

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
