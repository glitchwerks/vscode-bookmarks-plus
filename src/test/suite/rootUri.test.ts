import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  canonicalizeRootUri,
  findCanonicalRootCollisions,
  findDeepestRoot,
  isUriInsideRoot,
  rebaseUri
} from '../../rootUri';

suite('rootUri', () => {
  test('canonicalizes identity without folding path case', () => {
    const upper = vscode.Uri.parse('VSCODE-REMOTE://WSL+Ubuntu/Work/Repo/%7efile/');
    const lower = vscode.Uri.parse('vscode-remote://wsl+ubuntu/Work/Repo/~file');
    assert.strictEqual(canonicalizeRootUri(upper), canonicalizeRootUri(lower));
    assert.notStrictEqual(
      canonicalizeRootUri(vscode.Uri.parse('file:///Work/Repo')),
      canonicalizeRootUri(vscode.Uri.parse('file:///work/repo'))
    );
  });

  test('rejects query and fragment root identities', () => {
    assert.throws(() => canonicalizeRootUri(vscode.Uri.parse('file:///repo?x=1')));
    assert.throws(() => canonicalizeRootUri(vscode.Uri.parse('file:///repo#part')));
  });

  test('uses complete path components and the deepest root', () => {
    const parent = { id: 'parent', label: 'Parent', uri: vscode.Uri.parse('file:///work') };
    const child = { id: 'child', label: 'Child', uri: vscode.Uri.parse('file:///work/repo') };
    const item = vscode.Uri.parse('file:///work/repo/src/a.ts');
    assert.strictEqual(isUriInsideRoot(item, child.uri), true);
    assert.strictEqual(isUriInsideRoot(vscode.Uri.parse('file:///work/repository/a.ts'), child.uri), false);
    assert.strictEqual(findDeepestRoot(item, [parent, child])?.id, 'child');
    assert.strictEqual(findDeepestRoot(item, [child, parent])?.id, 'child');
  });

  test('reports canonical collisions instead of using array order', () => {
    const collisions = findCanonicalRootCollisions([
      { id: 'a', label: 'A', uri: vscode.Uri.parse('file:///work/repo') },
      { id: 'b', label: 'B', uri: vscode.Uri.parse('FILE:///work/repo/') }
    ]);
    assert.deepStrictEqual([...collisions.values()].map((group) => group.map((root) => root.id)), [['a', 'b']]);
  });

  test('rebases only structurally contained compatible URIs', () => {
    const oldRoot = vscode.Uri.parse('file:///old/repo');
    const newRoot = vscode.Uri.parse('file:///new/repo');
    assert.strictEqual(
      rebaseUri(vscode.Uri.parse('file:///old/repo/src/a.ts'), oldRoot, newRoot).uri?.toString(),
      'file:///new/repo/src/a.ts'
    );
    assert.strictEqual(
      rebaseUri(vscode.Uri.parse('file:///old/repository/a.ts'), oldRoot, newRoot).kind,
      'outside-old-root'
    );
    assert.strictEqual(
      rebaseUri(vscode.Uri.parse('vscode-remote://host/old/repo/a.ts'), oldRoot, newRoot).kind,
      'incompatible-uri'
    );
  });
});
