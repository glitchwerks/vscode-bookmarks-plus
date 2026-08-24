import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate } from '../../extension';
import { DISABLED_PREFIX, NO_FOLDER_SLUG, WORKSPACE_ENV_VAR } from '../../workspaceEnv';
import { createFakeExtensionContext, FakeExtensionContext } from './fixtures';

// Same known-collision pattern as extension.globalStore.test.ts:L21-L28 — the Extension Test Host
// activates this extension for real before any test code runs, so calling the exported `activate()`
// again (here, with a fake context) always throws once it reaches command registration. That throw
// happens after the behavior under test (the env-collection write, wired in near the top of
// `activate()` per plan D-B) has already run, so it is swallowed here and any other error is
// re-thrown as a genuine failure.
function assertKnownActivationCollision(error: unknown): void {
  assert.match(
    String(error),
    /command '.*' already exists/,
    'expected only the known "command already exists" collision from the Extension Test Host ' +
      'having already activated this extension for real — any other error is a genuine failure'
  );
}

function disposeAll(context: FakeExtensionContext): void {
  context.subscriptions.forEach((d) => d.dispose());
  context.subscriptions.length = 0;
}

suite('Extension - workspace env var wiring (T4)', () => {
  test('activate() writes BOOKMARKS_PLUS_WORKSPACE onto context.environmentVariableCollection', () => {
    const context = createFakeExtensionContext();
    try {
      try {
        activate(context as unknown as vscode.ExtensionContext);
      } catch (error) {
        assertKnownActivationCollision(error);
      }

      const calls = context.environmentVariableCollection.calls;
      assert.strictEqual(
        calls.length,
        1,
        'activate() must call replace() on context.environmentVariableCollection exactly once — ' +
          'the fake collection\'s call log recorded ' +
          calls.length +
          ' call(s)'
      );

      const call = calls[0];
      assert.strictEqual(call.variable, WORKSPACE_ENV_VAR);

      // The test host launches with no workspace folder open (src/test/runTest.ts:L8 passes no
      // `launchArgs`), so `vscode.workspace.workspaceFolders` is `undefined` here. The expected
      // value below is therefore the genuine, correct no-folder branch output — not a bug and not
      // a placeholder. Do not "fix" this to a real path if it starts failing; if it fails, either
      // the test host gained a launch folder or the no-folder resolution logic changed, and either
      // one is the actual thing to investigate.
      assert.strictEqual(call.value, `${DISABLED_PREFIX}${NO_FOLDER_SLUG}`);

      // End-to-end confirmation that activate() actually invokes applyWorkspaceEnv — not a re-test
      // of applyWorkspaceEnv's own ordering/no-options guarantees, which T3 already covers at the
      // unit level in workspaceEnv.test.ts.
      assert.strictEqual(
        call.persistentAtCall,
        false,
        'persistent must already be false at the moment replace() was called'
      );
      assert.strictEqual(call.optionsPassed, false, 'replace() must be called with no options argument');
    } finally {
      disposeAll(context);
    }
  });
});
