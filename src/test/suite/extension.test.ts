import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { handleWorkspaceFoldersChanged } from '../../extension';
import { FakeMemento, FakeMirror, FakeOutput } from './fixtures';

suite('Extension activation', () => {
  test('extension is present and activates', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test('activation registers every bookmarks.* command', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'bookmarks.addFile',
      'bookmarks.addFolder',
      'bookmarks.remove',
      'bookmarks.reveal',
      'bookmarks.newCollection',
      'bookmarks.renameCollection',
      'bookmarks.deleteCollection',
      'bookmarks.moveToCollection',
      'bookmarks.setDescription',
      'bookmarks.toggleGroupByRepo',
      'bookmarks.refresh',
      'bookmarks.addFileGlobal',
      'bookmarks.addFolderGlobal',
      'bookmarks.newGlobalCollection',
      'bookmarks.addToWorkspace'
    ];

    for (const command of expected) {
      assert.ok(commands.includes(command), `expected command "${command}" to be registered`);
    }
  });
});

suite('Extension - workspace-folder mirror changes', () => {
  test('disables mirror writes and logs when the workspace becomes multi-root', async () => {
    const mirror = new FakeMirror();
    const output = new FakeOutput();
    const store = new BookmarkStore(new FakeMemento(), output, { mirror, writeDelayMs: 5 });
    let disposed = false;
    const resources = { dispose: () => { disposed = true; } };
    let refreshCallCount = 0;
    const refresh = () => { refreshCallCount++; };

    await store.addItem({ type: 'file', uri: 'file:///before.txt' });
    await store.flushMirrorWrites();
    const writesBefore = mirror.writeCount;

    handleWorkspaceFoldersChanged(
      store,
      output,
      [
        { uri: vscode.Uri.file('/workspace/one') },
        { uri: vscode.Uri.file('/workspace/two') }
      ],
      resources,
      refresh
    );
    await store.addItem({ type: 'file', uri: 'file:///after.txt' });
    await store.flushMirrorWrites();

    assert.strictEqual(mirror.writeCount, writesBefore);
    assert.strictEqual(disposed, true);
    assert.ok(output.lines.some((line) => line.includes('multi-root workspaces are not supported')));
    assert.strictEqual(refreshCallCount, 1, 'expected refresh() to be called exactly once');
  });

  test('still calls refresh when the folder change leaves the mirror enabled', async () => {
    const mirror = new FakeMirror();
    const output = new FakeOutput();
    const store = new BookmarkStore(new FakeMemento(), output, { mirror, writeDelayMs: 5 });
    let disposed = false;
    const resources = { dispose: () => { disposed = true; } };
    let refreshCallCount = 0;
    const refresh = () => { refreshCallCount++; };

    await store.addItem({ type: 'file', uri: 'file:///before.txt' });
    await store.flushMirrorWrites();
    const writesBefore = mirror.writeCount;

    const result = handleWorkspaceFoldersChanged(
      store,
      output,
      [{ uri: vscode.Uri.file('/workspace/single') }],
      resources,
      refresh
    );

    assert.strictEqual(result, false, 'a single-root workspace keeps the mirror enabled');
    assert.strictEqual(disposed, false, 'mirror resources must not be disposed when still enabled');
    await store.addItem({ type: 'file', uri: 'file:///after.txt' });
    await store.flushMirrorWrites();
    assert.ok(mirror.writeCount > writesBefore, 'mirror writes must continue after a still-enabled folder change');
    assert.strictEqual(refreshCallCount, 1, 'expected refresh() to be called exactly once even when the mirror stays enabled');
  });

  test('does not throw when refresh is omitted', async () => {
    const mirror = new FakeMirror();
    const output = new FakeOutput();
    const store = new BookmarkStore(new FakeMemento(), output, { mirror, writeDelayMs: 5 });
    const resources = { dispose: () => { /* no-op */ } };

    assert.doesNotThrow(() => {
      handleWorkspaceFoldersChanged(
        store,
        output,
        [
          { uri: vscode.Uri.file('/workspace/one') },
          { uri: vscode.Uri.file('/workspace/two') }
        ],
        resources
      );
    });

    assert.doesNotThrow(() => {
      handleWorkspaceFoldersChanged(store, output, [{ uri: vscode.Uri.file('/workspace/single') }], resources);
    });
  });
});
