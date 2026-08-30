import * as assert from 'assert';
import {
  loadRecentlyViewed,
  RECENTLY_VIEWED_MAX_ITEMS,
  RECENTLY_VIEWED_STORAGE_KEY,
  recordView,
  saveRecentlyViewed
} from '../../recentlyViewed';
import { RECENT_STORAGE_KEY } from '../../recentItems';
import { FakeMemento } from './fixtures';

/**
 * Tests for issue #108 ("recent items and editor context menu"), §1: a plain MRU
 * (most-recently-viewed) list of up to `RECENTLY_VIEWED_MAX_ITEMS` uris.
 *
 * `src/recentlyViewed.ts` does not exist yet — every test in this file is expected to fail to
 * compile until it is added. This module is deliberately simpler than `recentItems.ts` — no
 * preview-promotion threshold, no `firstSeen`/`previewCount`/`promoted` fields, no configurable
 * cap — and deliberately its own module/storage key, independent of `recentItems.ts`, for the
 * same reason `recentItems.ts` itself is independent of `BookmarkData` (a per-user browsing
 * history must not be folded into another concern).
 */

suite('recentlyViewed - RECENTLY_VIEWED_STORAGE_KEY / RECENTLY_VIEWED_MAX_ITEMS constants', () => {
  test('the storage key is distinct from recentItems.ts\'s RECENT_STORAGE_KEY', () => {
    assert.notStrictEqual(
      RECENTLY_VIEWED_STORAGE_KEY,
      RECENT_STORAGE_KEY,
      'recentlyViewed.ts must use its own workspaceState key, independent of the #95 suggestions storage key'
    );
    assert.ok(RECENTLY_VIEWED_STORAGE_KEY.length > 0);
  });

  test('the fixed cap is 10', () => {
    assert.strictEqual(RECENTLY_VIEWED_MAX_ITEMS, 10);
  });
});

suite('recentlyViewed - recordView', () => {
  test('a new uri is prepended to the front of an empty list', () => {
    const list = recordView([], 'file:///a.txt', 10);
    assert.deepStrictEqual(list, ['file:///a.txt']);
  });

  test('a new uri is prepended to the front of a non-empty list', () => {
    const list = recordView(['file:///a.txt', 'file:///b.txt'], 'file:///c.txt', 10);
    assert.deepStrictEqual(list, ['file:///c.txt', 'file:///a.txt', 'file:///b.txt']);
  });

  test('re-viewing an already-present uri moves it to the front instead of duplicating it', () => {
    const list = recordView(['file:///a.txt', 'file:///b.txt', 'file:///c.txt'], 'file:///b.txt', 10);
    assert.deepStrictEqual(
      list,
      ['file:///b.txt', 'file:///a.txt', 'file:///c.txt'],
      're-viewing an existing uri must move it to front, not duplicate it'
    );
  });

  test('re-viewing the uri already at the front leaves the list unchanged in content and length', () => {
    const list = recordView(['file:///a.txt', 'file:///b.txt'], 'file:///a.txt', 10);
    assert.deepStrictEqual(list, ['file:///a.txt', 'file:///b.txt']);
  });

  test('there is no preview concept — every view (regardless of source) moves the uri to front', () => {
    // recordView takes only (list, uri, cap) — no isPreview flag exists on this contract at all,
    // unlike recordOpen's { uri, isPreview } entry shape.
    let list: string[] = [];
    list = recordView(list, 'file:///a.txt', 10);
    list = recordView(list, 'file:///a.txt', 10);
    assert.deepStrictEqual(list, ['file:///a.txt'], 'no duplication regardless of how many times the same uri is viewed');
  });

  test('the list is truncated to cap after each update, dropping the oldest (tail) entries', () => {
    let list: string[] = [];
    list = recordView(list, 'file:///a.txt', 2);
    list = recordView(list, 'file:///b.txt', 2);
    list = recordView(list, 'file:///c.txt', 2);

    assert.deepStrictEqual(
      list,
      ['file:///c.txt', 'file:///b.txt'],
      'the oldest entry (a) must be evicted from the tail once the cap of 2 is exceeded'
    );
  });

  test('the most-recent cap survives a long sequence of distinct views', () => {
    let list: string[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
      list = recordView(list, `file:///${name}.txt`, RECENTLY_VIEWED_MAX_ITEMS);
    }

    assert.strictEqual(list.length, RECENTLY_VIEWED_MAX_ITEMS);
    assert.deepStrictEqual(
      list,
      ['l', 'k', 'j', 'i', 'h', 'g', 'f', 'e', 'd', 'c'].map((name) => `file:///${name}.txt`),
      'the 10 most-recently-viewed uris survive, most-recent-first; the two oldest (a, b) are evicted'
    );
  });

  test('re-viewing an existing uri that would otherwise be evicted keeps it alive by moving it to front', () => {
    let list: string[] = [];
    list = recordView(list, 'file:///a.txt', 3);
    list = recordView(list, 'file:///b.txt', 3);
    list = recordView(list, 'file:///c.txt', 3);
    // Re-view "a" — without the move-to-front behavior, the next new uri would evict it anyway,
    // but this proves re-viewing itself repositions rather than being a silent no-op.
    list = recordView(list, 'file:///a.txt', 3);

    assert.deepStrictEqual(list, ['file:///a.txt', 'file:///c.txt', 'file:///b.txt']);
  });

  test('a cap of 0 yields an empty list', () => {
    const list = recordView(['file:///a.txt'], 'file:///b.txt', 0);
    assert.deepStrictEqual(list, []);
  });

  test('a negative cap yields an empty list', () => {
    const list = recordView(['file:///a.txt'], 'file:///b.txt', -1);
    assert.deepStrictEqual(list, []);
  });
});

suite('recentlyViewed - loadRecentlyViewed / saveRecentlyViewed persistence', () => {
  test('loadRecentlyViewed returns an empty list when nothing is persisted yet', () => {
    const memento = new FakeMemento();
    assert.deepStrictEqual(loadRecentlyViewed(memento), []);
  });

  test('saveRecentlyViewed persists under RECENTLY_VIEWED_STORAGE_KEY', async () => {
    const memento = new FakeMemento();
    await saveRecentlyViewed(memento, ['file:///a.txt', 'file:///b.txt']);

    const raw = memento.get<unknown>(RECENTLY_VIEWED_STORAGE_KEY);
    assert.ok(Array.isArray(raw), 'expected an array to be stored under RECENTLY_VIEWED_STORAGE_KEY');
    assert.strictEqual((raw as unknown[]).length, 2);
  });

  test('saveRecentlyViewed then loadRecentlyViewed round-trips the list, preserving order', async () => {
    const memento = new FakeMemento();
    const list = ['file:///c.txt', 'file:///a.txt', 'file:///b.txt'];

    await saveRecentlyViewed(memento, list);
    const loaded = loadRecentlyViewed(memento);

    assert.deepStrictEqual(loaded, list, 'MRU order must survive a save/load round-trip unchanged');
  });

  test('loadRecentlyViewed discards a non-array persisted value and returns an empty list', () => {
    const memento = new FakeMemento({ [RECENTLY_VIEWED_STORAGE_KEY]: 'not-an-array' });
    assert.deepStrictEqual(loadRecentlyViewed(memento), []);
  });

  test('loadRecentlyViewed discards an array whose entries are all non-string', () => {
    const memento = new FakeMemento({ [RECENTLY_VIEWED_STORAGE_KEY]: [1, 2, 3] });
    assert.deepStrictEqual(loadRecentlyViewed(memento), []);
  });

  test('loadRecentlyViewed discards an array whose entries are all empty strings', () => {
    const memento = new FakeMemento({ [RECENTLY_VIEWED_STORAGE_KEY]: ['', ''] });
    assert.deepStrictEqual(loadRecentlyViewed(memento), []);
  });

  test('loadRecentlyViewed discards a plain object (not an array) persisted value', () => {
    const memento = new FakeMemento({ [RECENTLY_VIEWED_STORAGE_KEY]: { uri: 'file:///a.txt' } });
    assert.deepStrictEqual(loadRecentlyViewed(memento), []);
  });
});
