import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';

/**
 * Builds a `process.argv`-shaped array, with the workspace path (if any)
 * occupying the conventional `argv[2]` positional slot.
 */
function argvWith(...positional: string[]): string[] {
  return ['node', 'bookmarks-plus-mcp', ...positional];
}

test('resolveConfig prefers the positional workspace argument over BOOKMARKS_MCP_WORKSPACE when both are present', () => {
  // Both inputs are relative on purpose: an absolute POSIX-style literal
  // (e.g. "/workspace/from-argv") resolves differently depending on whether
  // the implementation checks path.isAbsolute() first or always calls
  // path.resolve() — on Windows those two strategies disagree. A relative
  // input resolves identically under either strategy, so this assertion
  // is only about precedence, not path-resolution shape.
  const config = resolveConfig(argvWith('from-argv-workspace'), {
    BOOKMARKS_MCP_WORKSPACE: 'from-env-workspace',
  });

  assert.equal(config.workspacePath, path.resolve('from-argv-workspace'));
});

test('resolveConfig falls back to BOOKMARKS_MCP_WORKSPACE when no positional argument is supplied', () => {
  const config = resolveConfig(argvWith(), {
    BOOKMARKS_MCP_WORKSPACE: 'from-env-workspace',
  });

  assert.equal(config.workspacePath, path.resolve('from-env-workspace'));
});

test('resolveConfig throws a distinguishable error when neither the positional argument nor the env var is present', () => {
  assert.throws(
    () => resolveConfig(argvWith(), {}),
    (error: unknown) => error instanceof Error && /workspace/i.test(error.message),
  );
});

test('resolveConfig resolves a relative positional path to an absolute workspacePath', () => {
  const config = resolveConfig(argvWith('relative/workspace'), {});

  assert.ok(path.isAbsolute(config.workspacePath));
  assert.equal(config.workspacePath, path.resolve('relative/workspace'));
});

test('resolveConfig resolves a relative BOOKMARKS_MCP_WORKSPACE path to an absolute workspacePath', () => {
  const config = resolveConfig(argvWith(), {
    BOOKMARKS_MCP_WORKSPACE: 'relative/from-env',
  });

  assert.ok(path.isAbsolute(config.workspacePath));
  assert.equal(config.workspacePath, path.resolve('relative/from-env'));
});

test('resolveConfig derives mirrorPath from workspacePath at .vscode/bookmarks.json, matching the extension mirror location', () => {
  const config = resolveConfig(argvWith('workspace-root'), {});

  assert.equal(config.mirrorPath, path.join(config.workspacePath, '.vscode', 'bookmarks.json'));
});

test('resolveConfig defaults verifyDelayMs to 400 when BOOKMARKS_MCP_VERIFY_DELAY_MS is absent', () => {
  const config = resolveConfig(argvWith('workspace-root'), {});

  assert.equal(config.verifyDelayMs, 400);
});

test('resolveConfig parses verifyDelayMs from BOOKMARKS_MCP_VERIFY_DELAY_MS when present', () => {
  const config = resolveConfig(argvWith('workspace-root'), {
    BOOKMARKS_MCP_VERIFY_DELAY_MS: '1500',
  });

  assert.equal(config.verifyDelayMs, 1500);
});

test('resolveConfig accepts an explicit "0" for BOOKMARKS_MCP_VERIFY_DELAY_MS rather than treating it as missing', () => {
  const config = resolveConfig(argvWith('workspace-root'), {
    BOOKMARKS_MCP_VERIFY_DELAY_MS: '0',
  });

  assert.equal(config.verifyDelayMs, 0);
});

test('resolveConfig rejects a non-numeric BOOKMARKS_MCP_VERIFY_DELAY_MS instead of silently producing NaN', () => {
  assert.throws(() =>
    resolveConfig(argvWith('workspace-root'), {
      BOOKMARKS_MCP_VERIFY_DELAY_MS: 'abc',
    }),
  );
});
