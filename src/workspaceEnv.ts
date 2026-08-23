import * as vscode from 'vscode';

/**
 * These literals are duplicated (not imported) from `mcp-server/src/config.ts:L3-L5` — the
 * extension and the MCP server are separate packages and do not share a build boundary (plan
 * D-D). Agreement between the two copies is enforced by a cross-package drift test rather than a
 * shared import.
 */
export const DISABLED_PREFIX = 'disabled:';
export const MULTI_ROOT_SLUG = 'multi-root';
export const NO_FOLDER_SLUG = 'no-folder';

export const WORKSPACE_ENV_VAR = 'BOOKMARKS_PLUS_WORKSPACE';

/**
 * Pure resolution of the `BOOKMARKS_PLUS_WORKSPACE` terminal env var value from the current set of
 * workspace folders.
 *
 * Mirrors `resolveMirrorLocation`'s branch order (`src/bookmarkMirror.ts:L25-L34`) so the two
 * functions cannot disagree about what counts as "multi-root" vs "single" vs "none" — this is a
 * structurally parallel, independently-implemented function, not a wrapper around the mirror
 * location logic, and deliberately does not parse `MirrorLocation.reason` (an English sentence,
 * not a slug).
 */
export function resolveWorkspaceEnvValue(
  folders: readonly { uri: vscode.Uri }[] | undefined
): string {
  if (!folders || folders.length === 0) {
    return `${DISABLED_PREFIX}${NO_FOLDER_SLUG}`;
  }

  if (folders.length > 1) {
    return `${DISABLED_PREFIX}${MULTI_ROOT_SLUG}`;
  }

  return folders[0].uri.fsPath;
}
