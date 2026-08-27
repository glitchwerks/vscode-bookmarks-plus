import * as vscode from 'vscode';
import { BookmarkItem } from './types';

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
 * Builds the union of decoration keys across one or more stores' item lists (D2: workspace
 * ∪ global). A malformed or relative stored `uri` is skipped for that entry only — never
 * throws — per C2, since mirror-authored data is only shallow-validated as a non-empty string.
 */
export function buildDecoratedUriKeys(itemGroups: readonly BookmarkItem[][]): Set<string> {
  const keys = new Set<string>();
  for (const items of itemGroups) {
    for (const item of items) {
      try {
        const uri = vscode.Uri.parse(item.uri, true);
        keys.add(decorationUriKey(uri));
      } catch {
        // Skip this item only; C2 requires the rest of the batch to keep processing.
      }
    }
  }
  return keys;
}

/**
 * Decorates bookmarked files/folders in the Explorer with a `★` badge (T1 of issue #96;
 * D1 = badge + tooltip only, no `color`). `propagate` is never set (C1), and lookups are a
 * synchronous Set membership check only (C3) — no I/O, no promises.
 */
export class BookmarkDecorationProvider implements vscode.FileDecorationProvider {
  constructor(private readonly decoratedUriKeys: Set<string>) {}

  provideFileDecoration(uri: vscode.Uri, _token: vscode.CancellationToken): vscode.FileDecoration | undefined {
    if (!this.decoratedUriKeys.has(decorationUriKey(uri))) {
      return undefined;
    }
    return {
      badge: '★',
      tooltip: 'Bookmarked'
    };
  }
}
