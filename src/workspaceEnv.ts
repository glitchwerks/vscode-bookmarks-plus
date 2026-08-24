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

/**
 * The subset of `vscode.EnvironmentVariableCollection` that `applyWorkspaceEnv` needs. A minimal
 * local port interface, not the full `EnvironmentVariableCollection`, so that
 * `FakeEnvironmentVariableCollection` (`src/test/suite/fixtures.ts`) satisfies it structurally —
 * no `as` cast needed. `description`'s type mirrors the real member's exactly
 * (`node_modules/@types/vscode/index.d.ts:L12910`).
 */
export interface EnvironmentVariableCollectionPort {
  persistent: boolean;
  description: string | vscode.MarkdownString | undefined;
  replace(variable: string, value: string): void;
}

/**
 * Writes the resolved `BOOKMARKS_PLUS_WORKSPACE` value onto an environment variable collection so
 * it is applied to every terminal process VS Code spawns.
 *
 * Order matters: `persistent` is a caching flag — "this API will return the cached version if it
 * exists" when `persistent` is true (`index.d.ts:L12897-L12904`). Setting it to `false` before
 * `replace()` runs is what makes `replace()`'s effect observable at all instead of being served a
 * stale cached collection (plan § 2.2).
 */
export function applyWorkspaceEnv(
  collection: EnvironmentVariableCollectionPort,
  folders: readonly { uri: vscode.Uri }[] | undefined
): void {
  collection.persistent = false;
  collection.description = 'Bookmarks Plus: workspace path for the MCP server';

  // No options argument: `replace(variable, value, options?)` defaults to
  // `{ applyAtProcessCreation: true }` only when `options` is omitted entirely
  // (`index.d.ts:L12920-L12922`). `EnvironmentVariableMutatorOptions.applyAtProcessCreation`
  // itself "Defaults to false" (`index.d.ts:L12859-L12863`), so passing *any* options object —
  // even one only meant to opt into shell-integration application — would silently turn OFF
  // process-creation application, which is exactly the mechanism a spawned terminal subprocess
  // relies on to see this variable (plan § 2.4).
  collection.replace(WORKSPACE_ENV_VAR, resolveWorkspaceEnvValue(folders));
}
