import * as assert from 'assert';
import * as vscode from 'vscode';
import { isInsideWorkspace } from '../../workspaceFolders';

/**
 * Builds a `vscode.WorkspaceFolder`-shaped fixture. `index` defaults to the position implied by
 * call order in a test's own folder list, but callers only ever pass one or two folders here, so
 * a fixed `0` is fine — `index` is not part of `isInsideWorkspace`'s documented contract.
 */
function folder(uri: vscode.Uri, name = 'workspace-folder', index = 0): vscode.WorkspaceFolder {
  return { uri, name, index };
}

suite('workspaceFolders.isInsideWorkspace', () => {
  // --- 1. A uri that IS a workspace folder counts as inside -------------------------------------
  // Per index.d.ts:13887-13895 (getWorkspaceFolder doc comment): "returns the *input* when the
  // given uri is a workspace folder itself."
  test('a uri equal to a workspace folder\'s own uri is inside', () => {
    const root = vscode.Uri.file('/workspace/project');
    assert.strictEqual(isInsideWorkspace(vscode.Uri.file('/workspace/project'), [folder(root)]), true);
  });

  // --- 2. A genuine descendant is inside ---------------------------------------------------------
  test('a uri nested several segments below a workspace folder is inside', () => {
    const root = vscode.Uri.file('/workspace/project');
    const descendant = vscode.Uri.file('/workspace/project/src/nested/deep/file.ts');
    assert.strictEqual(isInsideWorkspace(descendant, [folder(root)]), true);
  });

  // --- 3. Path-segment boundary, not string prefix -----------------------------------------------
  test('a sibling that shares a string prefix but not a full path segment is outside', () => {
    const root = vscode.Uri.file('/a/foo');
    const sibling = vscode.Uri.file('/a/foobar');
    assert.strictEqual(isInsideWorkspace(sibling, [folder(root)]), false);
  });

  test('a path nested under such a sibling is also outside', () => {
    const root = vscode.Uri.file('/a/foo');
    const nestedUnderSibling = vscode.Uri.file('/a/foobar/baz.ts');
    assert.strictEqual(isInsideWorkspace(nestedUnderSibling, [folder(root)]), false);
  });

  // --- 4/5. No workspace open --------------------------------------------------------------------
  test('folders undefined (no workspace open) is outside', () => {
    assert.strictEqual(isInsideWorkspace(vscode.Uri.file('/workspace/project/file.ts'), undefined), false);
  });

  test('an empty folder list is outside', () => {
    assert.strictEqual(isInsideWorkspace(vscode.Uri.file('/workspace/project/file.ts'), []), false);
  });

  // --- 6. Multi-root: any matching folder counts, not just the first ----------------------------
  test('multi-root: a uri outside every folder is outside', () => {
    const folders = [
      folder(vscode.Uri.file('/workspace/repo-a'), 'repo-a', 0),
      folder(vscode.Uri.file('/workspace/repo-b'), 'repo-b', 1)
    ];
    assert.strictEqual(isInsideWorkspace(vscode.Uri.file('/elsewhere/file.ts'), folders), false);
  });

  test('multi-root: a match in the first folder is inside', () => {
    const folders = [
      folder(vscode.Uri.file('/workspace/repo-a'), 'repo-a', 0),
      folder(vscode.Uri.file('/workspace/repo-b'), 'repo-b', 1)
    ];
    assert.strictEqual(isInsideWorkspace(vscode.Uri.file('/workspace/repo-a/file.ts'), folders), true);
  });

  test('multi-root: a match in the second (not first) folder is inside', () => {
    const folders = [
      folder(vscode.Uri.file('/workspace/repo-a'), 'repo-a', 0),
      folder(vscode.Uri.file('/workspace/repo-b'), 'repo-b', 1)
    ];
    assert.strictEqual(isInsideWorkspace(vscode.Uri.file('/workspace/repo-b/src/file.ts'), folders), true);
  });

  // --- 7. Windows drive-letter / path case-insensitivity -----------------------------------------
  // Uri.from() is used (rather than Uri.file()) so the raw `scheme`/`path` components are under
  // the test's direct control and are not silently normalized by Uri.file()'s own platform-specific
  // path handling — this is the only way to deterministically reproduce the "c:" vs "C:" case
  // difference the plan (docs/superpowers/plans/2026-08-15-global-bookmarks-and-add-to-workspace.md
  // §D8) calls out, independent of whatever normalization Uri.file() may or may not already do.
  //
  // isInsideWorkspace is a pure function of its (uri, folders) arguments (plan §T8: "pure, no
  // vscode.workspace access") — the same pair must yield the same answer regardless of the host
  // OS running the test. CI runs these tests on ubuntu-latest (.github/workflows/ci.yml:15,32)
  // while local development here is on win32, so the Windows-flavored case-insensitivity below
  // must be keyed off the drive-letter path *shape* (a leading `/X:/...` segment), never off
  // `process.platform`— an implementation gated on `process.platform === 'win32'` would pass
  // locally and fail in CI.
  test('Windows: a descendant differing only in drive-letter casing is inside', () => {
    const root = vscode.Uri.from({ scheme: 'file', authority: '', path: '/c:/Users/dev/project' });
    const descendant = vscode.Uri.from({
      scheme: 'file',
      authority: '',
      path: '/C:/Users/dev/project/src/file.ts'
    });
    assert.strictEqual(isInsideWorkspace(descendant, [folder(root)]), true);
  });

  test('Windows: a descendant differing in a non-drive path segment\'s casing is inside', () => {
    const root = vscode.Uri.from({ scheme: 'file', authority: '', path: '/c:/Users/Dev/Project' });
    const descendant = vscode.Uri.from({
      scheme: 'file',
      authority: '',
      path: '/c:/users/dev/project/src/file.ts'
    });
    assert.strictEqual(isInsideWorkspace(descendant, [folder(root)]), true);
  });

  test('Windows: the workspace folder\'s own uri with different casing is inside', () => {
    const root = vscode.Uri.from({ scheme: 'file', authority: '', path: '/c:/Users/dev/project' });
    const sameFolderDifferentCase = vscode.Uri.from({
      scheme: 'file',
      authority: '',
      path: '/C:/USERS/DEV/PROJECT'
    });
    assert.strictEqual(isInsideWorkspace(sameFolderDifferentCase, [folder(root)]), true);
  });

  // --- 8. Non-file schemes: scheme and authority compared before path -----------------------------
  test('a matching path with a different scheme (file vs vscode-remote) is outside', () => {
    const root = vscode.Uri.from({ scheme: 'file', authority: '', path: '/workspace/project' });
    const differentScheme = vscode.Uri.from({
      scheme: 'vscode-remote',
      authority: '',
      path: '/workspace/project/file.ts'
    });
    assert.strictEqual(isInsideWorkspace(differentScheme, [folder(root)]), false);
  });

  test('a matching path with the same scheme but a different authority is outside', () => {
    const root = vscode.Uri.from({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/workspace/project' });
    const differentAuthority = vscode.Uri.from({
      scheme: 'vscode-remote',
      authority: 'wsl+Debian',
      path: '/workspace/project/file.ts'
    });
    assert.strictEqual(isInsideWorkspace(differentAuthority, [folder(root)]), false);
  });

  test('a matching path with the same scheme and authority is inside', () => {
    const root = vscode.Uri.from({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/workspace/project' });
    const sameAuthority = vscode.Uri.from({
      scheme: 'vscode-remote',
      authority: 'wsl+Ubuntu',
      path: '/workspace/project/file.ts'
    });
    assert.strictEqual(isInsideWorkspace(sameAuthority, [folder(root)]), true);
  });

  // --- Additional edge cases -----------------------------------------------------------------
  test('a workspace folder with a trailing slash still matches an exact-path descendant', () => {
    const root = vscode.Uri.from({ scheme: 'file', authority: '', path: '/workspace/project/' });
    const descendant = vscode.Uri.file('/workspace/project/file.ts');
    assert.strictEqual(isInsideWorkspace(descendant, [folder(root)]), true);
  });

  test('a completely unrelated single-folder workspace is outside', () => {
    const root = vscode.Uri.file('/workspace/project');
    assert.strictEqual(isInsideWorkspace(vscode.Uri.file('/other/place/file.ts'), [folder(root)]), false);
  });
});
