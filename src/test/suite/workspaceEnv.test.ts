import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  resolveWorkspaceEnvValue,
  applyWorkspaceEnv,
  DISABLED_PREFIX,
  MULTI_ROOT_SLUG,
  NO_FOLDER_SLUG,
  WORKSPACE_ENV_VAR
} from '../../workspaceEnv';
import { FakeEnvironmentVariableCollection } from './fixtures';

/**
 * Builds a `{ uri }`-shaped fixture — `resolveWorkspaceEnvValue` only reads `uri` off each folder
 * (per the plan's signature, `readonly { uri: vscode.Uri }[]`), so a full `vscode.WorkspaceFolder`
 * (with `name`/`index`) is unnecessary ceremony here, unlike `workspaceFolders.test.ts`'s `folder()`
 * helper which exercises the real `isInsideWorkspace(uri, WorkspaceFolder[])` signature.
 */
function folder(uri: vscode.Uri): { uri: vscode.Uri } {
  return { uri };
}

suite('workspaceEnv.resolveWorkspaceEnvValue', () => {
  // --- 1. Single folder → that folder's OS-native fsPath -----------------------------------------
  // Asserted against `Uri.file(...).fsPath`, never a hand-written path string, so this is stable on
  // both win32 (local) and ubuntu-latest (CI: .github/workflows/ci.yml:15).
  test('a single folder resolves to that folder\'s fsPath', () => {
    const root = vscode.Uri.file('/workspace/project');
    assert.strictEqual(resolveWorkspaceEnvValue([folder(root)]), root.fsPath);
  });

  test('a single nested folder resolves to its fsPath, not the uri path form', () => {
    const root = vscode.Uri.file('/workspace/nested/deep/project');
    assert.strictEqual(resolveWorkspaceEnvValue([folder(root)]), root.fsPath);
  });

  // --- 2. Two or more folders → disabled:multi-root -----------------------------------------------
  test('two folders resolve to the multi-root disabled sentinel', () => {
    const folders = [folder(vscode.Uri.file('/workspace/repo-a')), folder(vscode.Uri.file('/workspace/repo-b'))];
    assert.strictEqual(resolveWorkspaceEnvValue(folders), `${DISABLED_PREFIX}${MULTI_ROOT_SLUG}`);
  });

  test('three folders also resolve to the multi-root disabled sentinel', () => {
    const folders = [
      folder(vscode.Uri.file('/workspace/repo-a')),
      folder(vscode.Uri.file('/workspace/repo-b')),
      folder(vscode.Uri.file('/workspace/repo-c'))
    ];
    assert.strictEqual(resolveWorkspaceEnvValue(folders), `${DISABLED_PREFIX}${MULTI_ROOT_SLUG}`);
  });

  // --- 3/4. No folder open → disabled:no-folder -----------------------------------------------
  test('folders undefined (no workspace open) resolves to the no-folder disabled sentinel', () => {
    assert.strictEqual(resolveWorkspaceEnvValue(undefined), `${DISABLED_PREFIX}${NO_FOLDER_SLUG}`);
  });

  test('an empty folder list resolves to the no-folder disabled sentinel', () => {
    assert.strictEqual(resolveWorkspaceEnvValue([]), `${DISABLED_PREFIX}${NO_FOLDER_SLUG}`);
  });

  // --- 5. Exported constants: existence, shape, and exact disabled-value composition -------------
  // T7's cross-package drift test needs these exact names as a stable regex target — get them right
  // here so a later rename is caught as drift, not silently accepted.
  suite('exported constants', () => {
    test('WORKSPACE_ENV_VAR is the literal terminal-env variable name', () => {
      assert.strictEqual(WORKSPACE_ENV_VAR, 'BOOKMARKS_PLUS_WORKSPACE');
    });

    test('DISABLED_PREFIX, MULTI_ROOT_SLUG, and NO_FOLDER_SLUG are non-empty strings', () => {
      assert.strictEqual(typeof DISABLED_PREFIX, 'string');
      assert.strictEqual(typeof MULTI_ROOT_SLUG, 'string');
      assert.strictEqual(typeof NO_FOLDER_SLUG, 'string');
      assert.notStrictEqual(DISABLED_PREFIX.length, 0);
      assert.notStrictEqual(MULTI_ROOT_SLUG.length, 0);
      assert.notStrictEqual(NO_FOLDER_SLUG.length, 0);
    });

    test('the multi-root disabled value is composed exactly from DISABLED_PREFIX + MULTI_ROOT_SLUG', () => {
      const folders = [folder(vscode.Uri.file('/workspace/repo-a')), folder(vscode.Uri.file('/workspace/repo-b'))];
      assert.strictEqual(resolveWorkspaceEnvValue(folders), `${DISABLED_PREFIX}${MULTI_ROOT_SLUG}`);
    });

    test('the no-folder disabled value is composed exactly from DISABLED_PREFIX + NO_FOLDER_SLUG', () => {
      assert.strictEqual(resolveWorkspaceEnvValue(undefined), `${DISABLED_PREFIX}${NO_FOLDER_SLUG}`);
    });

    test('the two disabled sentinels are distinct', () => {
      assert.notStrictEqual(`${DISABLED_PREFIX}${MULTI_ROOT_SLUG}`, `${DISABLED_PREFIX}${NO_FOLDER_SLUG}`);
    });
  });
});

suite('workspaceEnv.applyWorkspaceEnv', () => {
  function folderList(...uris: vscode.Uri[]): { uri: vscode.Uri }[] {
    return uris.map((uri) => ({ uri }));
  }

  // --- 1. replace() called exactly once, with WORKSPACE_ENV_VAR and the T2-resolved value --------
  test('calls replace exactly once, with WORKSPACE_ENV_VAR and the resolved value', () => {
    const collection = new FakeEnvironmentVariableCollection();
    const folders = folderList(vscode.Uri.file('/workspace/project'));

    applyWorkspaceEnv(collection, folders);

    assert.strictEqual(collection.calls.length, 1);
    assert.strictEqual(collection.calls[0].variable, WORKSPACE_ENV_VAR);
    assert.strictEqual(collection.calls[0].value, resolveWorkspaceEnvValue(folders));
  });

  // --- 2. No options argument passed to replace() -------------------------------------------------
  // Passing any options object silently defaults `applyAtProcessCreation` to false (plan § 2.4), so
  // the fixture's recorded `optionsPassed` flag must be false, not merely "options was undefined".
  test('calls replace with no options argument', () => {
    const collection = new FakeEnvironmentVariableCollection();

    applyWorkspaceEnv(collection, folderList(vscode.Uri.file('/workspace/project')));

    assert.strictEqual(collection.calls[0].optionsPassed, false);
  });

  // --- 3. persistent === false at the moment replace() was called, not merely after ---------------
  // Uses the fixture's per-call snapshot rather than a post-hoc read of the live collection, because
  // a post-hoc read would pass even if `persistent` were flipped to false *after* replace() ran —
  // exactly the ordering bug the plan warns about (persistent collections return a cached value).
  test('persistent is already false at the moment replace() is called', () => {
    const collection = new FakeEnvironmentVariableCollection();

    applyWorkspaceEnv(collection, folderList(vscode.Uri.file('/workspace/project')));

    assert.strictEqual(collection.calls[0].persistentAtCall, false);
  });

  // --- 4. description is set ------------------------------------------------------------------
  test('sets a non-empty description on the collection', () => {
    const collection = new FakeEnvironmentVariableCollection();

    applyWorkspaceEnv(collection, folderList(vscode.Uri.file('/workspace/project')));

    assert.notStrictEqual(collection.description, '');
  });

  // --- 5. Calling twice with different folder sets leaves the second value in place ---------------
  // VS Code allows only a single mutator per variable per extension (index.d.ts:L12914-L12916), so
  // the second call's value must be what's observable afterward, not the first.
  test('calling it twice with different folder sets leaves the second value in place', () => {
    const collection = new FakeEnvironmentVariableCollection();
    const first = folderList(vscode.Uri.file('/workspace/repo-a'));
    const second = folderList(
      vscode.Uri.file('/workspace/repo-b'),
      vscode.Uri.file('/workspace/repo-c')
    );

    applyWorkspaceEnv(collection, first);
    applyWorkspaceEnv(collection, second);

    const lastCall = collection.calls[collection.calls.length - 1];
    assert.strictEqual(lastCall.variable, WORKSPACE_ENV_VAR);
    assert.strictEqual(lastCall.value, resolveWorkspaceEnvValue(second));
    assert.notStrictEqual(lastCall.value, resolveWorkspaceEnvValue(first));
  });
});
