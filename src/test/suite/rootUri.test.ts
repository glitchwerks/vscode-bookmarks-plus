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

  test('normalizes only file drive-letter case across serialization and containment', () => {
    const root = vscode.Uri.from({ scheme: 'file', path: '/C:/Work/Repo' });
    const restored = vscode.Uri.parse(root.toString());
    assert.strictEqual(canonicalizeRootUri(root), canonicalizeRootUri(restored));
    assert.strictEqual(canonicalizeRootUri(root), 'file:///c:/Work/Repo');
    assert.strictEqual(isUriInsideRoot(vscode.Uri.parse('file:///c:/Work/Repo/a.ts'), root), true);
    assert.strictEqual(isUriInsideRoot(vscode.Uri.parse('file:///c:/work/Repo/a.ts'), root), false);
    assert.notStrictEqual(canonicalizeRootUri(root), canonicalizeRootUri(vscode.Uri.parse('file:///c:/work/Repo')));
    assert.notStrictEqual(
      canonicalizeRootUri(vscode.Uri.parse('vscode-remote://host/C:/Work/Repo')),
      canonicalizeRootUri(vscode.Uri.parse('vscode-remote://host/c:/Work/Repo'))
    );
  });

  test('rejects relative, query, and fragment root identities', () => {
    const relative = { scheme: '', authority: '', path: 'repo', query: '', fragment: '' } as vscode.Uri;
    assert.throws(() => canonicalizeRootUri(relative));
    assert.throws(() => canonicalizeRootUri(vscode.Uri.parse('file:///repo?x=1')));
    assert.throws(() => canonicalizeRootUri(vscode.Uri.parse('file:///repo#part')));
  });

  test('normalizes only non-root trailing separators and preserves encoded separators', () => {
    assert.strictEqual(
      canonicalizeRootUri(vscode.Uri.parse('file:///work//repo/')),
      'file:///work//repo'
    );
    assert.strictEqual(canonicalizeRootUri(vscode.Uri.parse('file:///')), 'file:///');
    assert.notStrictEqual(
      canonicalizeRootUri(vscode.Uri.from({ scheme: 'file', authority: '', path: '/work/%2Frepo' })),
      canonicalizeRootUri(vscode.Uri.parse('file:///work//repo'))
    );
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

  test('preserves interior empty path components during containment', () => {
    const doubledRoot = vscode.Uri.parse('file:///work//repo');
    const collapsedRoot = vscode.Uri.parse('file:///work/repo');
    const item = vscode.Uri.parse('file:///work//repo/src/a.ts');
    assert.strictEqual(isUriInsideRoot(item, doubledRoot), true);
    assert.strictEqual(isUriInsideRoot(item, collapsedRoot), false);
  });

  test('reports canonical collisions instead of using array order', () => {
    const collisions = findCanonicalRootCollisions([
      { id: 'a', label: 'A', uri: vscode.Uri.parse('file:///work/repo') },
      { id: 'b', label: 'B', uri: vscode.Uri.parse('FILE:///work/repo/') }
    ]);
    assert.deepStrictEqual([...collisions.values()].map((group) => group.map((root) => root.id)), [['a', 'b']]);
  });

  test('does not select an ambiguous canonical collision in either root order', () => {
    const first = { id: 'first', label: 'First', uri: vscode.Uri.parse('file:///work/repo') };
    const second = { id: 'second', label: 'Second', uri: vscode.Uri.parse('FILE:///work/repo/') };
    const item = vscode.Uri.parse('file:///work/repo/src/a.ts');
    assert.strictEqual(findDeepestRoot(item, [first, second]), undefined);
    assert.strictEqual(findDeepestRoot(item, [second, first]), undefined);
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

  test('rebases repeated-slash paths and preserves source query and fragment', () => {
    const oldRoot = vscode.Uri.parse('file:///old//repo');
    const newRoot = vscode.Uri.parse('file:///new//repo');
    const source = vscode.Uri.parse('file:///old//repo/src/a.ts?view=1#L3');
    const result = rebaseUri(source, oldRoot, newRoot).uri;
    assert.strictEqual(result?.path, '/new//repo/src/a.ts');
    assert.strictEqual(result?.query, source.query);
    assert.strictEqual(result?.fragment, source.fragment);
  });

  for (const [name, other, encoded] of [
    ['%61', 'a', '%2561'], ['%7e', '~', '%257e'], ['%2F', '%2f', '%252F'],
    ['a b', 'ab', 'a%20b'], ['a#b', 'ab', 'a%23b'], ['a?b', 'ab', 'a%3Fb']
  ]) {
    test(`preserves literal ${name} names through file, parse, identity, containment and rebase`, () => {
      const root = vscode.Uri.file('/work/' + name);
      const roundTrip = vscode.Uri.parse(root.toString());
      const canonical = canonicalizeRootUri(root);
      assert.strictEqual(canonical, 'file:///work/' + encoded);
      assert.strictEqual(canonicalizeRootUri(roundTrip), canonical);
      assert.strictEqual(canonicalizeRootUri(vscode.Uri.parse(canonical)), canonical);
      assert.notStrictEqual(canonical, canonicalizeRootUri(vscode.Uri.file('/work/' + other)));
      assert.strictEqual(isUriInsideRoot(vscode.Uri.file('/work/' + other + '/private'), root), false);
      assert.strictEqual(isUriInsideRoot(vscode.Uri.file('/work/' + name + '/file'), roundTrip), true);
      const source = vscode.Uri.parse(vscode.Uri.file('/old/' + name + '.ts').toString());
      const rebased = rebaseUri(source, vscode.Uri.file('/old'), vscode.Uri.file('/new')).uri!;
      assert.strictEqual(rebased.path, '/new/' + name + '.ts');
      assert.strictEqual(vscode.Uri.parse(rebased.toString()).path, rebased.path);
    });
  }

  test('a literal encoded-separator filename never becomes a structural separator', () => {
    const literal = vscode.Uri.parse('file:///work/%252Fchild');
    assert.strictEqual(isUriInsideRoot(vscode.Uri.parse('file:///work//child/private'), literal), false);
    assert.strictEqual(canonicalizeRootUri(literal), 'file:///work/%252Fchild');
    assert.strictEqual(rebaseUri(vscode.Uri.file('/old/%2F/child'), vscode.Uri.file('/old'), vscode.Uri.file('/new')).uri!.path,
      '/new/%2F/child');
  });
});
