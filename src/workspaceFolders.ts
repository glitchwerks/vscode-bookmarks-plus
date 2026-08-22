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
