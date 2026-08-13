import path from 'node:path';

export const DISABLED_PREFIX = 'disabled:';
export const MULTI_ROOT_REASON_SLUG = 'multi-root';
export const NO_FOLDER_REASON_SLUG = 'no-folder';

export interface Config {
  workspacePath: string;
  mirrorPath: string;
  verifyDelayMs: number;
}

export type WorkspaceState =
  | { kind: 'ok'; config: Config }
  | { kind: 'disabled'; reason: string };

/**
 * Treats an empty-string tier value the same as an absent (`undefined`)
 * tier value, so a tier explicitly set to `""` falls through to the next
 * lower-precedence tier instead of resolving to the process's own cwd.
 */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function resolveConfig(
  argv: string[],
  env: Record<string, string | undefined>,
): Config {
  const workspace =
    nonEmpty(argv[2]) ??
    nonEmpty(env.BOOKMARKS_PLUS_WORKSPACE) ??
    nonEmpty(env.CLAUDE_PROJECT_DIR) ??
    nonEmpty(env.BOOKMARKS_MCP_WORKSPACE);

  if (workspace === undefined) {
    throw new Error(
      'A workspace path is required via argv[2], BOOKMARKS_PLUS_WORKSPACE, CLAUDE_PROJECT_DIR, or BOOKMARKS_MCP_WORKSPACE.',
    );
  }

  if (workspace.startsWith(DISABLED_PREFIX)) {
    throw new Error('A disabled-sentinel value reached resolveConfig directly.');
  }

  const workspacePath = path.resolve(workspace);
  const verifyDelayValue = env.BOOKMARKS_MCP_VERIFY_DELAY_MS;
  const verifyDelayMs = verifyDelayValue === undefined ? 400 : Number(verifyDelayValue);

  if (Number.isNaN(verifyDelayMs)) {
    throw new Error('BOOKMARKS_MCP_VERIFY_DELAY_MS must be numeric.');
  }

  return {
    workspacePath,
    mirrorPath: path.join(workspacePath, '.vscode', 'bookmarks.json'),
    verifyDelayMs,
  };
}

export function resolveWorkspaceState(
  argv: string[],
  env: Record<string, string | undefined>,
): WorkspaceState {
  if (nonEmpty(argv[2]) !== undefined) {
    return { kind: 'ok', config: resolveConfig(argv, env) };
  }

  const extensionWorkspace = env.BOOKMARKS_PLUS_WORKSPACE;
  if (extensionWorkspace?.startsWith(DISABLED_PREFIX)) {
    const slug = extensionWorkspace.slice(DISABLED_PREFIX.length);

    if (slug === MULTI_ROOT_REASON_SLUG) {
      return {
        kind: 'disabled',
        reason: 'Multi-root workspaces are not yet supported by the Bookmarks Plus mirror.',
      };
    }

    if (slug === NO_FOLDER_REASON_SLUG) {
      return {
        kind: 'disabled',
        reason: 'No workspace folder is open in this VS Code window.',
      };
    }

    return {
      kind: 'disabled',
      reason:
        'The Bookmarks Plus mirror is unavailable because this VS Code window reported an unrecognized disabled state.',
    };
  }

  return { kind: 'ok', config: resolveConfig(argv, env) };
}
