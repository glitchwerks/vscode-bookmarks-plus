import * as vscode from 'vscode';
import { BookmarkItem } from './types';
import { BookmarkStore } from './bookmarkStore';

/**
 * Canonicalizes a Uri into a stable map key for decoration lookups.
 *
 * `file:` URIs are keyed by `fsPath`, lower-cased only on `win32` (C2, plan §3) — this
 * normalizes Windows drive-letter case and percent-escaping differences between an
 * Explorer-constructed Uri and an externally-authored stored uri string. Non-`file` schemes
 * are keyed by `toString()` since they have no filesystem-path notion.
 */
export function decorationUriKey(uri: vscode.Uri, platform: NodeJS.Platform = process.platform): string {
  if (uri.scheme !== 'file') {
    return uri.toString();
  }
  return platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
}

/**
 * Parses each stored `item.uri` into a `[key, uri]` pair, skipping (never throwing on) a
 * malformed or relative entry — C2, since mirror-authored data is only shallow-validated as a
 * non-empty string. Shared by `buildDecoratedUriKeys` (keys only) and the change-event wiring
 * below (T2), which additionally needs the parsed `Uri` to populate a fired batch.
 */
function* decoratedEntries(itemGroups: readonly BookmarkItem[][]): Generator<[string, vscode.Uri]> {
  for (const items of itemGroups) {
    for (const item of items) {
      try {
        const uri = vscode.Uri.parse(item.uri, true);
        yield [decorationUriKey(uri), uri];
      } catch {
        // Skip this item only; C2 requires the rest of the batch to keep processing.
      }
    }
  }
}

/**
 * Builds the union of decoration keys across one or more stores' item lists (D2: workspace
 * ∪ global). A malformed or relative stored `uri` is skipped for that entry only — never
 * throws — per C2, since mirror-authored data is only shallow-validated as a non-empty string.
 */
export function buildDecoratedUriKeys(itemGroups: readonly BookmarkItem[][]): Set<string> {
  const keys = new Set<string>();
  for (const [key] of decoratedEntries(itemGroups)) {
    keys.add(key);
  }
  return keys;
}

/**
 * Decorates bookmarked files/folders in the Explorer with a `★` badge (T1 of issue #96;
 * D1 = badge + tooltip only, no `color`). `propagate` is never set (C1), and lookups are a
 * synchronous Set membership check only (C3) — no I/O, no promises.
 */
export class BookmarkDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  /** Never fires `undefined` (C4) — always the union-diff batch computed by `wire()`. */
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> =
    this._onDidChangeFileDecorations.event;

  /** Uri, keyed by `decorationUriKey`, for every currently-decorated item across wired stores. */
  private uriByKey = new Map<string, vscode.Uri>();

  /** T3 (plan §6): whether decorations are currently shown. Defaults to enabled. */
  private enabled = true;

  constructor(private decoratedUriKeys: Set<string>) {}

  provideFileDecoration(uri: vscode.Uri, _token: vscode.CancellationToken): vscode.FileDecoration | undefined {
    if (!this.enabled || !this.decoratedUriKeys.has(decorationUriKey(uri))) {
      return undefined;
    }
    return {
      badge: '★',
      tooltip: 'Bookmarked'
    };
  }

  /**
   * T3 (plan §6): toggles whether decorations are shown, without touching the underlying
   * decorated-key index. A no-op (no state change, no event) if `enabled` already matches the
   * current state. Otherwise updates the state and fires `onDidChangeFileDecorations` exactly
   * once with every currently-indexed uri (from `uriByKey`, populated by `wire()`/`resync()`),
   * so the Explorer immediately reflects the toggle in either direction.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this._onDidChangeFileDecorations.fire(Array.from(this.uriByKey.values()));
  }

  /**
   * Subscribes to each store's `onBookmarksChanged` (the persist fire site,
   * `src/bookmarkStore.ts:L96-L97`, and the mirror-reload fire site, `:L391-L393`) and keeps the
   * decorated-key set current (C4, plan §6 T2).
   *
   * Establishes a silent baseline snapshot of the wired stores' current items first — this is
   * what lets a later removal fire with the *removed* uri even though that uri is no longer in
   * any store's data by the time the event handler runs. From then on, every subsequent fire
   * recomputes the union across all wired stores, diffs it against the previous snapshot, and —
   * only when something actually changed (C4 rejects re-signalling an unrelated echo, and the
   * `undefined` "everything changed" shape, in favor of the git-decoration-provider union-diff
   * pattern) — fires exactly one `onDidChangeFileDecorations` event with the union of added and
   * removed uris.
   */
  wire(stores: BookmarkStore[]): vscode.Disposable {
    this.resync(stores);
    const subscriptions = stores.map((store) => store.onBookmarksChanged(() => this.resyncAndNotify(stores)));
    return vscode.Disposable.from(...subscriptions);
  }

  private resync(stores: BookmarkStore[]): void {
    const { keys, uriByKey } = this.computeCurrentState(stores);
    this.decoratedUriKeys = keys;
    this.uriByKey = uriByKey;
  }

  private resyncAndNotify(stores: BookmarkStore[]): void {
    const previousKeys = this.decoratedUriKeys;
    const previousUriByKey = this.uriByKey;
    const { keys: nextKeys, uriByKey: nextUriByKey } = this.computeCurrentState(stores);

    const changed: vscode.Uri[] = [];
    for (const key of nextKeys) {
      if (!previousKeys.has(key)) {
        changed.push(nextUriByKey.get(key)!);
      }
    }
    for (const key of previousKeys) {
      if (!nextKeys.has(key)) {
        changed.push(previousUriByKey.get(key)!);
      }
    }

    this.decoratedUriKeys = nextKeys;
    this.uriByKey = nextUriByKey;

    if (changed.length > 0) {
      this._onDidChangeFileDecorations.fire(changed);
    }
  }

  private computeCurrentState(stores: BookmarkStore[]): {
    keys: Set<string>;
    uriByKey: Map<string, vscode.Uri>;
  } {
    const uriByKey = new Map<string, vscode.Uri>();
    const itemGroups = stores.map((store) => store.getAll().items);
    for (const [key, uri] of decoratedEntries(itemGroups)) {
      uriByKey.set(key, uri);
    }
    return { keys: new Set(uriByKey.keys()), uriByKey };
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
