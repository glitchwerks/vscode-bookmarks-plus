import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveConfig, resolveWorkspaceState, DISABLED_PREFIX } from '../src/config.js';

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

// ---------------------------------------------------------------------------
// 4-tier precedence (issue #57, spec § 3):
//   1. argv[2]                      explicit override
//   2. env.BOOKMARKS_PLUS_WORKSPACE NEW — extension-injected
//   3. env.CLAUDE_PROJECT_DIR       NEW — Claude Code's own project root
//   4. env.BOOKMARKS_MCP_WORKSPACE  legacy override, demoted (D1)
//   else -> throw
// ---------------------------------------------------------------------------

test('resolveConfig uses BOOKMARKS_PLUS_WORKSPACE when no positional argument is supplied', () => {
  const config = resolveConfig(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: 'from-plus-workspace',
  });

  assert.equal(config.workspacePath, path.resolve('from-plus-workspace'));
});

test('resolveConfig prefers the positional workspace argument over BOOKMARKS_PLUS_WORKSPACE when both are present', () => {
  const config = resolveConfig(argvWith('from-argv-workspace'), {
    BOOKMARKS_PLUS_WORKSPACE: 'from-plus-workspace',
  });

  assert.equal(config.workspacePath, path.resolve('from-argv-workspace'));
});

test('resolveConfig prefers BOOKMARKS_PLUS_WORKSPACE over CLAUDE_PROJECT_DIR (D5 guard -- the extension-owned signal outranks the Claude Code project-root proxy)', () => {
  const config = resolveConfig(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: 'from-plus-workspace',
    CLAUDE_PROJECT_DIR: 'from-claude-project-dir',
  });

  assert.equal(config.workspacePath, path.resolve('from-plus-workspace'));
});

test('resolveConfig prefers CLAUDE_PROJECT_DIR over BOOKMARKS_MCP_WORKSPACE (D1 guard -- a shell-inherited legacy override must not silently pin every session)', () => {
  // Regression test for the shell-inheritance hole D1 names: a user who
  // once exported BOOKMARKS_MCP_WORKSPACE in a shell profile (or left it
  // over from a pre-#57 single-workspace setup) must not have it silently
  // override the session's own CLAUDE_PROJECT_DIR. If a future reorder puts
  // the legacy env var back above CLAUDE_PROJECT_DIR, this test catches it.
  const config = resolveConfig(argvWith(), {
    CLAUDE_PROJECT_DIR: 'from-claude-project-dir',
    BOOKMARKS_MCP_WORKSPACE: 'from-legacy-env-workspace',
  });

  assert.equal(config.workspacePath, path.resolve('from-claude-project-dir'));
});

test('resolveConfig falls through to the next-lower tier when a higher-precedence tier is an empty string, rather than resolving to the server process\'s own cwd (CodeRabbit regression: config.ts:33 -- the "??" tier chain only skips undefined, not "")', () => {
  // BOOKMARKS_PLUS_WORKSPACE="" (or an equivalent empty-string tier) must be
  // treated the same as an absent tier and skipped in favor of the next
  // lower-precedence tier. The bug: `??` only guards against `undefined`, so
  // an empty string passes the guard, path.resolve('') then returns
  // process.cwd(), and the mirror path silently becomes
  // "<server cwd>/.vscode/bookmarks.json" instead of falling through to
  // CLAUDE_PROJECT_DIR here.
  const config = resolveConfig(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: '',
    CLAUDE_PROJECT_DIR: 'from-claude-project-dir',
  });

  assert.equal(config.workspacePath, path.resolve('from-claude-project-dir'));
});

test('resolveConfig resolves a relative BOOKMARKS_PLUS_WORKSPACE path to an absolute workspacePath', () => {
  const config = resolveConfig(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: 'relative/from-plus-workspace',
  });

  assert.ok(path.isAbsolute(config.workspacePath));
  assert.equal(config.workspacePath, path.resolve('relative/from-plus-workspace'));
});

test('resolveConfig resolves a relative CLAUDE_PROJECT_DIR path to an absolute workspacePath', () => {
  const config = resolveConfig(argvWith(), {
    CLAUDE_PROJECT_DIR: 'relative/from-claude-project-dir',
  });

  assert.ok(path.isAbsolute(config.workspacePath));
  assert.equal(config.workspacePath, path.resolve('relative/from-claude-project-dir'));
});

test('resolveConfig still throws a distinguishable error when all four sources -- argv[2], BOOKMARKS_PLUS_WORKSPACE, CLAUDE_PROJECT_DIR, and BOOKMARKS_MCP_WORKSPACE -- are absent', () => {
  // This is a NEW case, not an edit of the pre-#57 "both absent" case above
  // (:36-41 in the original two-tier design, left untouched per the spec).
  // It restates the same invariant across all four tiers of the new chain,
  // and additionally pins Task 2 step 2 (spec § 8 Phase 1): the error text
  // must name all the new sources, not just the original two.
  assert.throws(
    () =>
      resolveConfig(argvWith(), {
        BOOKMARKS_PLUS_WORKSPACE: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        BOOKMARKS_MCP_WORKSPACE: undefined,
      }),
    (error: unknown) => {
      if (!(error instanceof Error) || !/workspace/i.test(error.message)) {
        return false;
      }
      // Env var names are stable identifiers, not wording the implementer
      // is free to paraphrase -- unlike the argv positional, which has no
      // fixed name to check for.
      return (
        error.message.includes('BOOKMARKS_PLUS_WORKSPACE') &&
        error.message.includes('CLAUDE_PROJECT_DIR') &&
        error.message.includes('BOOKMARKS_MCP_WORKSPACE')
      );
    },
  );
});

// ---------------------------------------------------------------------------
// resolveWorkspaceState (spec § 4B.8) -- the sentinel-aware wrapper around
// resolveConfig. It must not change resolveConfig's own signature, return
// type, or throwing behavior (all covered above); it only adds detection of
// the `disabled:<reason-slug>` sentinel (§ 4B.7) that the extension's
// BOOKMARKS_PLUS_WORKSPACE tier can carry instead of a real path.
// ---------------------------------------------------------------------------

test('DISABLED_PREFIX is the reserved "disabled:" sentinel prefix', () => {
  assert.equal(DISABLED_PREFIX, 'disabled:');
});

test('resolveWorkspaceState returns an ok state carrying the same Config resolveConfig would produce for a normal (non-sentinel) value', () => {
  const argv = argvWith();
  const env = { BOOKMARKS_PLUS_WORKSPACE: 'normal-workspace' };

  const state = resolveWorkspaceState(argv, env);

  assert.equal(state.kind, 'ok');
  if (state.kind === 'ok') {
    assert.deepEqual(state.config, resolveConfig(argv, env));
  }
});

test('resolveWorkspaceState returns a disabled state with a reason mentioning multi-root when BOOKMARKS_PLUS_WORKSPACE is disabled:multi-root', () => {
  const state = resolveWorkspaceState(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: `${DISABLED_PREFIX}multi-root`,
  });

  assert.equal(state.kind, 'disabled');
  if (state.kind === 'disabled') {
    assert.match(state.reason, /multi-root/i);
  }
});

test('resolveWorkspaceState returns a disabled state with a reason mentioning no folder being open when BOOKMARKS_PLUS_WORKSPACE is disabled:no-folder', () => {
  const state = resolveWorkspaceState(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: `${DISABLED_PREFIX}no-folder`,
  });

  assert.equal(state.kind, 'disabled');
  if (state.kind === 'disabled') {
    assert.match(state.reason, /no folder|folder.*open/i);
  }
});

test('resolveWorkspaceState treats an unrecognized disabled:<slug> as a disabled state with a generic reason, not as a literal workspace path (forward compatibility for #58)', () => {
  // Critical: a future extension version may add a new disabled reason slug
  // without this server shipping first. If an unknown slug were mistakenly
  // resolved as a path instead, `kind` would come back 'ok' with
  // `config.workspacePath` set to the nonsensical resolved form of the
  // sentinel string itself -- exactly the failure this test guards against.
  const state = resolveWorkspaceState(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: `${DISABLED_PREFIX}something-future`,
  });

  assert.equal(state.kind, 'disabled');
  if (state.kind === 'disabled') {
    assert.equal(typeof state.reason, 'string');
    assert.ok(state.reason.length > 0, 'an unknown slug must still carry a legible generic reason');
  }
});

test('resolveWorkspaceState treats an empty-string argv[2] the same as an absent positional argument, so the BOOKMARKS_PLUS_WORKSPACE sentinel branch still runs (CodeRabbit regression: config.ts:61 -- "argv[2] !== undefined" treats "" as present, bypassing the disabled-sentinel check entirely)', () => {
  // A "" positional argument is falsy-but-defined: `argv[2] !== undefined`
  // is true for "", so the current guard skips straight into
  // resolveConfig(argv, env) instead of checking BOOKMARKS_PLUS_WORKSPACE
  // for the disabled: sentinel first. resolveConfig then falls through its
  // own nonEmpty(argv[2]) check (config.test.ts:143's regression already
  // covers that "" is treated as absent *there*) to
  // BOOKMARKS_PLUS_WORKSPACE, and resolves the literal sentinel string
  // "disabled:multi-root" as if it were a real workspace path -- producing a
  // bogus 'ok' state instead of the 'disabled' state the extension intended.
  const state = resolveWorkspaceState(argvWith(''), {
    BOOKMARKS_PLUS_WORKSPACE: `${DISABLED_PREFIX}multi-root`,
  });

  assert.equal(state.kind, 'disabled');
  if (state.kind === 'disabled') {
    assert.match(state.reason, /multi-root/i);
  }
});

test('resolveWorkspaceState treats a disabled sentinel on BOOKMARKS_PLUS_WORKSPACE as disabled even when a real, valid CLAUDE_PROJECT_DIR is also present -- the isolation invariant: a disabled sentinel must win over any lower-precedence tier fallback', () => {
  // No existing test combines sentinel recognition with tier precedence:
  // nothing asserts that a disabled:<slug> sentinel on the higher-precedence
  // BOOKMARKS_PLUS_WORKSPACE tier is not silently bypassed in favor of a
  // real, resolvable path sitting on a lower-precedence tier.
  const state = resolveWorkspaceState(argvWith(), {
    BOOKMARKS_PLUS_WORKSPACE: `${DISABLED_PREFIX}no-folder`,
    CLAUDE_PROJECT_DIR: 'a-real-lower-tier-workspace',
  });

  assert.equal(state.kind, 'disabled');
});
