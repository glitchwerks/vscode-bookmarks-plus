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

export function resolveConfig(
  argv: string[],
  env: Record<string, string | undefined>,
): Config {
  const workspace =
    argv[2] ??
    env.BOOKMARKS_PLUS_WORKSPACE ??
    env.CLAUDE_PROJECT_DIR ??
    env.BOOKMARKS_MCP_WORKSPACE;

  if (workspace === undefined) {
    throw new Error(
      'A workspace path is required via argv[2], BOOKMARKS_PLUS_WORKSPACE, CLAUDE_PROJECT_DIR, or BOOKMARKS_MCP_WORKSPACE.',
    );
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
  if (argv[2] !== undefined) {
    return { kind: 'ok', config: resolveConfig(argv, env) };
  }

  const extensionWorkspace = env.BOOKMARKS_PLUS_WORKSPACE;
  if (extensionWorkspace?.startsWith(DISABLED_PREFIX)) {
    const slug = extensionWorkspace.slice(DISABLED_PREFIX.length);

    if (slug === MULTI_ROOT_REASON_SLUG) {
      return {
        kind: 'disabled',
        reason: 'multi-root workspaces are not supported by the bookmarks mirror yet',
      };
    }

    if (slug === NO_FOLDER_REASON_SLUG) {
      return { kind: 'disabled', reason: 'no workspace folder is open' };
    }

    return {
      kind: 'disabled',
      reason: 'The Bookmarks Plus mirror is unavailable in this VS Code window.',
    };
  }

  return { kind: 'ok', config: resolveConfig(argv, env) };
}
