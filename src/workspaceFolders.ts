import * as vscode from 'vscode';

/**
 * Splits a URI path into non-empty segments, lowercased for case-insensitive comparison.
 * Filtering empty segments absorbs leading/trailing slashes (e.g. a workspace folder uri
 * with a trailing slash) so segment-array comparison works uniformly.
 */
function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0).map((segment) => segment.toLowerCase());
}

/**
 * True when `folderSegments` is a prefix of `uriSegments` — i.e. `uri` is the folder itself or a
 * descendant of it, compared on path-segment boundaries (not raw string prefix).
 */
function isSegmentPrefix(folderSegments: string[], uriSegments: string[]): boolean {
  if (folderSegments.length > uriSegments.length) {
    return false;
  }
  return folderSegments.every((segment, index) => segment === uriSegments[index]);
}

/**
 * Pure predicate for whether `uri` lies inside one of `folders` — the workspace folder itself
 * or any descendant, matching `vscode.workspace.getWorkspaceFolder`'s documented semantics
 * (index.d.ts:13887-13895). Takes the folder list as a parameter rather than reading
 * `vscode.workspace` directly so it stays a pure function of its arguments and is unit-testable
 * without a live workspace; call sites pass `vscode.workspace.workspaceFolders`.
 *
 * Comparison is case-insensitive unconditionally (not gated on `process.platform`), since the
 * same (uri, folders) pair must yield the same answer on every host OS, including in CI.
 */
export function isInsideWorkspace(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[] | undefined
): boolean {
  if (!folders || folders.length === 0) {
    return false;
  }

  const uriSegments = pathSegments(uri.path);

  return folders.some((folder) => {
    const folderUri = folder.uri;
    if (uri.scheme !== folderUri.scheme || uri.authority !== folderUri.authority) {
      return false;
    }
    return isSegmentPrefix(pathSegments(folderUri.path), uriSegments);
  });
}

/**
 * #115: the path of `uri` relative to whichever workspace folder contains it, joined with `/`
 * (POSIX-style, unconditionally — never `path.sep`, so the label is identical on Windows and
 * POSIX hosts). Returns `undefined` — the "no root to be relative to" case — when `uri` is not
 * inside any of `folders` (including when `folders` is `undefined` or empty), matching
 * `isInsideWorkspace`'s own case-insensitive, segment-boundary comparison so the two stay
 * consistent. Case is preserved in the returned path (unlike `isInsideWorkspace`'s internal
 * comparison, which lowercases only for matching).
 */
export function getWorkspaceRelativePath(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[] | undefined
): string | undefined {
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const uriSegments = uri.path.split('/').filter((segment) => segment.length > 0);
  const uriSegmentsLower = uriSegments.map((segment) => segment.toLowerCase());

  for (const folder of folders) {
    const folderUri = folder.uri;
    if (uri.scheme !== folderUri.scheme || uri.authority !== folderUri.authority) {
      continue;
    }
    const folderSegments = pathSegments(folderUri.path);
    if (isSegmentPrefix(folderSegments, uriSegmentsLower)) {
      return uriSegments.slice(folderSegments.length).join('/');
    }
  }

  return undefined;
}
