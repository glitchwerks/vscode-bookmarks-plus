import * as vscode from 'vscode';
import { findDeepestRoot, toRootCandidates } from './rootUri';

/**
 * Pure predicate for whether `uri` lies inside one of `folders` — the workspace folder itself
 * or any descendant, matching `vscode.workspace.getWorkspaceFolder`'s documented semantics
 * (index.d.ts:13887-13895). Takes the folder list as a parameter rather than reading
 * `vscode.workspace` directly so it stays a pure function of its arguments and is unit-testable
 * without a live workspace; call sites pass `vscode.workspace.workspaceFolders`.
 *
 * Comparison delegates to the canonical root-URI primitives, which preserve path case while
 * comparing schemes and authorities case-insensitively.
 */
export function isInsideWorkspace(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[] | undefined
): boolean {
  return findDeepestRoot(uri, toRootCandidates(folders)) !== undefined;
}

/**
 * #115: the path of `uri` relative to whichever workspace folder contains it, joined with `/`
 * (POSIX-style, unconditionally — never `path.sep`, so the label is identical on Windows and
 * POSIX hosts). Returns `undefined` — the "no root to be relative to" case — when `uri` is not
 * inside any of `folders` (including when `folders` is `undefined` or empty), matching
 * `isInsideWorkspace`'s canonical structural comparison so the two stay consistent. Case is
 * preserved in the returned path and in root identity.
 */
export function getWorkspaceRelativePath(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[] | undefined
): string | undefined {
  const root = findDeepestRoot(uri, toRootCandidates(folders));
  if (!root) {
    return undefined;
  }

  const uriSegments = uri.path.split('/').filter(Boolean);
  const rootSegmentCount = root.uri.path.split('/').filter(Boolean).length;
  return uriSegments.slice(rootSegmentCount).join('/');
}
