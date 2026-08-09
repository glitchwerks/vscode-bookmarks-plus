import path from 'node:path';

export interface Config {
  workspacePath: string;
  mirrorPath: string;
  verifyDelayMs: number;
}

export function resolveConfig(
  argv: string[],
  env: Record<string, string | undefined>,
): Config {
  const workspace = argv[2] ?? env.BOOKMARKS_MCP_WORKSPACE;

  if (workspace === undefined) {
    throw new Error('A workspace path is required.');
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
