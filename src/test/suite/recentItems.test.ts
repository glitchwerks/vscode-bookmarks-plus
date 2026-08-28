import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  extractTabUri,
  loadRecentItems,
  normalizeMaxItems,
  PREVIEW_PROMOTION_THRESHOLD,
  RECENT_STORAGE_KEY,
  RecentItem,
  recordOpen,
  saveRecentItems
} from '../../recentItems';
import { FakeMemento } from './fixtures';

/**
 * Tests for issue #95 ("suggested bookmarks from recently opened items"), plan
 * docs/superpowers/plans/2026-08-25-suggested-bookmarks-from-recent-items.md, tasks T1/T2/T3.
 *
 * `src/recentItems.ts` does not exist yet — every test in this file is expected to fail to
 * compile until it is added. C1 (plan §3): this module and its `RECENT_STORAGE_KEY` are new,
 * separate from `BookmarkData` / `bookmarks.data` on purpose — a per-user browsing history must
 * never be folded into the versioned, mirrored bookmark schema.
 */

suite('recentItems - recordOpen (T1/T2)', () => {
  test('a new non-preview URI is recorded as a promoted entry', () => {
    const list = recordOpen([], { uri: 'file:///a.txt', isPreview: false }, 10, 100);
    const entry = list.find((i) => i.uri === 'file:///a.txt');
    assert.ok(entry, 'expected the new uri to be recorded');
    assert.strictEqual(entry!.promoted, true, 'a non-preview open must promote immediately');
    assert.strictEqual(entry!.firstSeen, 100);
  });

  test('recording the same URI twice does not create a duplicate entry', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 200);

    const matches = list.filter((i) => i.uri === 'file:///a.txt');
    assert.strictEqual(matches.length, 1, 'a URI must appear at most once in the list');
  });

  test('re-recording an already-promoted URI leaves its firstSeen unchanged (D6: no reorder on re-open)', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 999);

    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(
      entry.firstSeen,
      100,
      'clicking a suggestion re-opens it and re-fires the tracked event, but must not shift its ' +
        'sort position — firstSeen is what the D6 sort keys off, so it must survive a re-open'
    );
    assert.strictEqual(entry.promoted, true);
  });

  test('a cap of 0 yields an empty list for non-preview opens', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 0, 100);
    assert.deepStrictEqual(list, []);
  });

  test('promoted entries beyond the cap are evicted, oldest first-seen first', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 2, 100);
    list = recordOpen(list, { uri: 'file:///b.txt', isPreview: false }, 2, 200);
    list = recordOpen(list, { uri: 'file:///c.txt', isPreview: false }, 2, 300);

    const uris = list.map((i) => i.uri).sort();
    assert.deepStrictEqual(
      uris,
      ['file:///b.txt', 'file:///c.txt'].sort(),
      'the oldest-first-seen promoted entry (a) must be evicted once the cap is exceeded'
    );
  });

  test('sub-threshold preview entries are never evicted to make room for a promoted entry (D2 cap interaction)', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///promoted.txt', isPreview: false }, 1, 100);
    list = recordOpen(list, { uri: 'file:///preview-only.txt', isPreview: true }, 1, 200);

    const promotedEntry = list.find((i) => i.uri === 'file:///promoted.txt');
    const previewEntry = list.find((i) => i.uri === 'file:///preview-only.txt');

    assert.ok(promotedEntry, 'a promoted entry must not be evicted to make room for an unrelated preview open');
    assert.strictEqual(promotedEntry!.promoted, true);
    assert.ok(previewEntry, 'a sub-threshold preview entry must still be recorded even at the promoted cap');
    assert.strictEqual(previewEntry!.promoted, false);
  });

  test('a raw fractional cap must not retain more promoted entries than its floor (CodeRabbit: maxItems config normalization — recordOpen/enforceCap must floor its own cap defensively, not assume every caller has already normalized it)', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 3.7, 100);
    list = recordOpen(list, { uri: 'file:///b.txt', isPreview: false }, 3.7, 200);
    list = recordOpen(list, { uri: 'file:///c.txt', isPreview: false }, 3.7, 300);
    list = recordOpen(list, { uri: 'file:///d.txt', isPreview: false }, 3.7, 400);

    assert.strictEqual(
      list.filter((i) => i.promoted).length,
      3,
      'a raw fractional cap of 3.7 must retain at most 3 promoted entries — passing 3.7 straight ' +
        "into enforceCap's overflow arithmetic (4 - 3.7 = 0.3) lets Array#slice's end-index " +
        'truncation (slice(0, 0.3) evicts nothing) retain all 4, one more than the cap allows'
    );
  });
});

suite('recentItems - preview promotion threshold (D2, resolved)', () => {
  test('the promotion threshold is 3', () => {
    assert.strictEqual(PREVIEW_PROMOTION_THRESHOLD, 3);
  });

  test('a single preview open does not promote the entry', () => {
    const list = recordOpen([], { uri: 'file:///a.txt', isPreview: true }, 10, 100);
    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(entry.promoted, false);
    assert.strictEqual(entry.previewCount, 1);
  });

  test('a second preview open still does not promote the entry', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 200);

    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(entry.promoted, false);
    assert.strictEqual(entry.previewCount, 2);
  });

  test('a third preview open promotes the entry', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 200);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 300);

    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(entry.promoted, true, 'the third preview open must cross the threshold and promote');
  });

  test('a non-preview open promotes the entry immediately, regardless of previewCount', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 200);
    // Only 2 previews so far — a preview-only path would not promote yet.
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 300);

    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(entry.promoted, true, 'a non-preview open must promote independent of previewCount');
  });

  test('firstSeen on a promoted entry is the timestamp of the promoting open, not the first preview open', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 200);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 300);

    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(
      entry.firstSeen,
      300,
      "a file previewed three times over a span must sort as 'just seen', not as if it had been " +
        'sitting in the list since the first preview'
    );
  });

  test('firstSeen on a non-preview promotion is the timestamp of that promoting open too', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 500);

    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(entry.firstSeen, 500);
  });

  test('further preview opens after promotion do not un-promote the entry', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 100);
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: true }, 10, 200);

    const entry = list.find((i) => i.uri === 'file:///a.txt')!;
    assert.strictEqual(entry.promoted, true, 'once promoted, a subsequent preview open must not revert promotion');
    assert.strictEqual(entry.firstSeen, 100, 'promotion timestamp must not shift on a later preview open');
  });
});

suite('recentItems - loadRecentItems / saveRecentItems persistence (T2)', () => {
  test('the storage key is bookmarks.recentlyOpened (C1/D4)', () => {
    assert.strictEqual(RECENT_STORAGE_KEY, 'bookmarks.recentlyOpened');
  });

  test('loadRecentItems returns an empty list when nothing is persisted yet', () => {
    const memento = new FakeMemento();
    assert.deepStrictEqual(loadRecentItems(memento), []);
  });

  test('saveRecentItems persists under the bookmarks.recentlyOpened key', async () => {
    const memento = new FakeMemento();
    const list: RecentItem[] = [{ uri: 'file:///a.txt', firstSeen: 1, previewCount: 0, promoted: true }];

    await saveRecentItems(memento, list);

    const raw = memento.get<unknown>(RECENT_STORAGE_KEY);
    assert.ok(Array.isArray(raw), 'expected an array to be stored under RECENT_STORAGE_KEY');
    assert.strictEqual((raw as unknown[]).length, 1);
  });

  test('saveRecentItems then loadRecentItems round-trips the list', async () => {
    const memento = new FakeMemento();
    const list: RecentItem[] = [
      { uri: 'file:///a.txt', firstSeen: 1, previewCount: 0, promoted: true },
      { uri: 'file:///b.txt', firstSeen: 2, previewCount: 1, promoted: false }
    ];

    await saveRecentItems(memento, list);
    const loaded = loadRecentItems(memento);

    assert.deepStrictEqual(
      [...loaded].sort((a, b) => a.uri.localeCompare(b.uri)),
      [...list].sort((a, b) => a.uri.localeCompare(b.uri))
    );
  });

  test(
    'loadRecentItems discards malformed persisted state and returns an empty list, mirroring the ' +
      'discard-on-invalid posture of isValidBookmarkData (src/types.ts:35-41)',
    () => {
      const memento = new FakeMemento({ [RECENT_STORAGE_KEY]: 'not-an-array' });
      assert.deepStrictEqual(loadRecentItems(memento), []);
    }
  );

  test('loadRecentItems discards an array whose entries have the wrong shape', () => {
    const memento = new FakeMemento({
      [RECENT_STORAGE_KEY]: [{ uri: 123, firstSeen: 'not-a-number' }]
    });
    assert.deepStrictEqual(loadRecentItems(memento), []);
  });
});

suite('recentItems - extractTabUri (T3 tab adapter)', () => {
  test('extracts the uri from a TabInputText tab with a file-scheme uri', () => {
    const uri = vscode.Uri.file('/workspace/a.txt');
    assert.strictEqual(extractTabUri(new vscode.TabInputText(uri))?.toString(), uri.toString());
  });

  test('extracts the uri from a TabInputCustom tab with a file-scheme uri', () => {
    const uri = vscode.Uri.file('/workspace/custom-doc');
    assert.strictEqual(
      extractTabUri(new vscode.TabInputCustom(uri, 'someCustomEditor'))?.toString(),
      uri.toString()
    );
  });

  test('extracts the uri from a TabInputNotebook tab with a file-scheme uri', () => {
    const uri = vscode.Uri.file('/workspace/notebook.ipynb');
    assert.strictEqual(
      extractTabUri(new vscode.TabInputNotebook(uri, 'jupyter-notebook'))?.toString(),
      uri.toString()
    );
  });

  test('returns undefined for a TabInputTextDiff tab (no single uri, D1: skipped entirely in v1)', () => {
    const original = vscode.Uri.file('/workspace/original.txt');
    const modified = vscode.Uri.file('/workspace/modified.txt');
    assert.strictEqual(extractTabUri(new vscode.TabInputTextDiff(original, modified)), undefined);
  });

  test('returns undefined for a non-file-scheme uri (e.g. untitled:) even on an otherwise-valid TabInputText (C6)', () => {
    const uri = vscode.Uri.parse('untitled:Untitled-1');
    assert.strictEqual(extractTabUri(new vscode.TabInputText(uri)), undefined);
  });

  test('returns undefined for a non-file-scheme uri on TabInputCustom (C6)', () => {
    const uri = vscode.Uri.parse('output:some-channel');
    assert.strictEqual(extractTabUri(new vscode.TabInputCustom(uri, 'someCustomEditor')), undefined);
  });

  test('returns undefined for null, undefined, and a plain object that merely has a "uri" property', () => {
    assert.strictEqual(extractTabUri(null), undefined);
    assert.strictEqual(extractTabUri(undefined), undefined);
    // Duck-typing must not be enough — C2 requires runtime instanceof narrowing against the real
    // vscode.TabInput* classes, since Tab.input bottoms out in `unknown` with no discriminator.
    assert.strictEqual(extractTabUri({ uri: vscode.Uri.file('/workspace/a.txt') }), undefined);
  });
});

// --- CodeRabbit finding (PR #103, package.json review): maxItems config normalization ----------
//
// `extension.ts` reads `bookmarksPlus.suggestions.maxItems` straight from
// `vscode.workspace.getConfiguration()` and passes it directly to `recordOpen` (via
// `registerRecentItemsTracker`'s `deps.maxItems`) and to the tree provider's `SuggestionsSource`.
// Because the setting is user-editable JSON, it can be negative or fractional:
//   - A negative cap makes `enforceCap`'s `overflow = promotedByAge.length - cap` computation
//     always positive and larger than the list, so `slice(0, overflow)` evicts every promoted
//     entry — not what "invalid input" should mean.
//   - A fractional cap (e.g. 3.7) makes `overflow` fractional too (e.g. `4 - 3.7 = 0.3`), and
//     `Array.prototype.slice`'s end index truncates via `ToIntegerOrInfinity` (floors positive
//     values), so `slice(0, 0.3)` evicts *zero* entries where an integer cap of 3 should have
//     evicted one — retaining more promoted entries than the configured cap.
//
// `normalizeMaxItems` is the fix: a small pure helper, exported alongside `recordOpen` since it
// exists to produce the value `recordOpen`'s `cap` parameter already assumes it receives (see the
// `@param cap` docstring on `recordOpen` above). `src/extension.ts`'s config-read site is expected
// to call it once and pass the result to both `registerRecentItemsTracker`'s `deps.maxItems` and
// the tree provider's `SuggestionsSource.maxItems`.
//
// Floor-value choice (documented per the test-implementer briefing): negative input clamps to 0,
// not to some other floor. 0 is not an arbitrary choice — D3 (plan §4) already defines `maxItems:
// 0` as the section's off-switch ("0 disables the section entirely"), so clamping a negative,
// nonsensical cap to 0 reuses an existing, already-tested semantic instead of inventing a new one.
//
// Signature assumption: `normalizeMaxItems(value: number): number`. Non-number shapes (NaN, a
// string, `undefined`) are deliberately out of scope here — `package.json` already declares
// `bookmarksPlus.suggestions.maxItems` with `type: "number"` (see the extension.test.ts manifest
// test), so VS Code's settings UI/schema is the primary defense against a non-numeric value; this
// helper's contract is scoped to "a number that may be negative or fractional," matching the
// CodeRabbit finding's own wording ("a negative value" / "a fractional value").
suite('recentItems - normalizeMaxItems (CodeRabbit: maxItems config normalization)', () => {
  test("a negative value clamps to 0 (D3's existing \"disabled\" floor, not a new floor value)", () => {
    assert.strictEqual(normalizeMaxItems(-1), 0);
  });

  test('a large negative value also clamps to 0', () => {
    assert.strictEqual(normalizeMaxItems(-100), 0);
  });

  test('a negative fractional value clamps to 0, not to a floored negative like -1', () => {
    assert.strictEqual(normalizeMaxItems(-0.5), 0);
  });

  test('a fractional value is floored to an integer', () => {
    assert.strictEqual(normalizeMaxItems(3.7), 3);
  });

  test('a fractional value just below an integer boundary floors down, not up', () => {
    assert.strictEqual(normalizeMaxItems(2.999), 2);
  });

  test('zero is already normalized and is returned unchanged', () => {
    assert.strictEqual(normalizeMaxItems(0), 0);
  });

  test('a valid positive integer passes through unchanged', () => {
    assert.strictEqual(normalizeMaxItems(10), 10);
  });

  test('composed with recordOpen: a negative configured cap, once normalized, evicts every promoted entry — the D3 off-switch semantics — rather than the raw-negative slice bug', () => {
    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, 10, 100);
    list = recordOpen(list, { uri: 'file:///b.txt', isPreview: false }, 10, 200);

    const normalizedCap = normalizeMaxItems(-5);
    list = recordOpen(list, { uri: 'file:///c.txt', isPreview: false }, normalizedCap, 300);

    assert.deepStrictEqual(
      list.filter((i) => i.promoted),
      [],
      'a negative maxItems, normalized to 0, must evict every promoted entry (matching the existing cap-0 behavior)'
    );
  });

  test('composed with recordOpen: a fractional configured cap, once normalized, retains exactly the floored integer count', () => {
    const normalizedCap = normalizeMaxItems(3.7); // expected 3

    let list: RecentItem[] = [];
    list = recordOpen(list, { uri: 'file:///a.txt', isPreview: false }, normalizedCap, 100);
    list = recordOpen(list, { uri: 'file:///b.txt', isPreview: false }, normalizedCap, 200);
    list = recordOpen(list, { uri: 'file:///c.txt', isPreview: false }, normalizedCap, 300);
    list = recordOpen(list, { uri: 'file:///d.txt', isPreview: false }, normalizedCap, 400);

    assert.strictEqual(
      list.filter((i) => i.promoted).length,
      3,
      'a maxItems of 3.7, normalized to 3, must retain at most 3 promoted entries, not 4'
    );
  });
});
