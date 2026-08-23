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

  test('bookmarks.addToWorkspace is hidden from the command palette like its sibling add-commands', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    const commandPalette: Array<{ command: string; when?: string }> =
      ext!.packageJSON.contributes.menus.commandPalette;

    // addFile / addFolder / addFileGlobal / addFolderGlobal are all invoked with a tree-node
    // argument and are deliberately hidden from the palette via a `when: "false"` entry.
    // addToWorkspace takes the same kind of argument and must be hidden the same way —
    // otherwise invoking it from the palette (no argument) throws.
    const entry = commandPalette.find((item) => item.command === 'bookmarks.addToWorkspace');
    assert.ok(
      entry,
      'expected a contributes.menus.commandPalette entry for bookmarks.addToWorkspace, matching its sibling add-commands'
    );
    assert.strictEqual(
      entry!.when,
      'false',
      'bookmarks.addToWorkspace must have when: "false" in contributes.menus.commandPalette to stay hidden from the palette'
    );
  });

  test('activationEvents includes onStartupFinished so early terminals still get the workspace env var', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    // Since VS Code 1.74, a contributed view activates its extension implicitly once the
    // Bookmarks view is revealed — but a terminal opened before that (e.g. immediately after
    // the window opens, before the user has looked at the Bookmarks view) would launch before
    // the extension has had a chance to set BOOKMARKS_PLUS_WORKSPACE in its environment
    // variable collection. "onStartupFinished" activates the extension shortly after VS Code
    // starts, without delaying startup, so early terminals get the variable too. Do not remove
    // this assertion as "redundant with implicit view activation" — it guards exactly the
    // early-terminal case implicit activation does not cover.
    const activationEvents: string[] = ext!.packageJSON.activationEvents;
    assert.ok(
      activationEvents.includes('onStartupFinished'),
      'expected package.json activationEvents to include "onStartupFinished" so terminals opened before the Bookmarks view is revealed still receive BOOKMARKS_PLUS_WORKSPACE'
    );
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
