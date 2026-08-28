import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { BookmarkDecorationProvider } from '../../bookmarkDecorationProvider';
import { handleWorkspaceFoldersChanged, registerBookmarkDecorationProvider } from '../../extension';
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

// T4 (plan §6, docs/superpowers/plans/2026-08-25-explorer-decoration-for-bookmarked-files.md):
// registration, configuration, and disposal of BookmarkDecorationProvider in src/extension.ts.
// `registerBookmarkDecorationProvider` does not exist yet, so this suite is expected to fail to
// compile until T4 adds it.
//
// Contract under test — `registerBookmarkDecorationProvider(stores, subscriptions, deps)`:
//   - `stores: BookmarkStore[]` — passed straight through to `BookmarkDecorationProvider.wire()`.
//   - `subscriptions: vscode.Disposable[]` — every disposable the helper creates (the provider
//     registration, the configuration-change listener, and the store-wiring subscription(s)) must
//     be pushed here, mirroring `context.subscriptions`.
//   - `deps.getConfiguration(): { get<T>(section: string, defaultValue: T): T }` — a
//     `vscode.workspace.getConfiguration()`-shaped seam.
//   - `deps.registerFileDecorationProvider(provider): vscode.Disposable` — a
//     `vscode.window.registerFileDecorationProvider`-shaped seam.
//   - `deps.onDidChangeConfiguration(listener): vscode.Disposable` — a
//     `vscode.workspace.onDidChangeConfiguration`-shaped seam.
//   - Returns the constructed `BookmarkDecorationProvider`.
//
// These fakes stand in for the read-only `vscode` module per the plan's explicit instruction not
// to monkey-patch it and not to rely on subscription-array counts/position.
suite('registerBookmarkDecorationProvider (T4, plan §6)', () => {
  const EXPLORER_DECORATION_ENABLED_KEY = 'bookmarksPlus.explorerDecoration.enabled';

  /** Records every `dispose()` call so tests can assert disposal identity directly, instead of
   * inspecting `context.subscriptions` by array position (the plan explicitly rules this out). */
  class FakeDisposable implements vscode.Disposable {
    disposeCallCount = 0;
    dispose(): void {
      this.disposeCallCount++;
    }
  }

  /** Fake of the `vscode.WorkspaceConfiguration` subset the helper reads from. Records every
   * `get()` call (section + supplied default) so a test can assert exactly which key was read and
   * with what fallback, rather than only inferring it indirectly from provider behavior that
   * happens to already default the same way. */
  class FakeConfiguration {
    calls: { section: string; defaultValue: unknown }[] = [];
    constructor(private readonly values: Record<string, unknown> = {}) {}

    get<T>(section: string, defaultValue: T): T {
      this.calls.push({ section, defaultValue });
      return Object.prototype.hasOwnProperty.call(this.values, section)
        ? (this.values[section] as T)
        : defaultValue;
    }

    set(section: string, value: unknown): void {
      this.values[section] = value;
    }
  }

  /** Fake of a `vscode.ConfigurationChangeEvent`. Records every section `affectsConfiguration` was
   * asked about, and always answers with the fixed `response` the test configured. */
  class FakeConfigurationChangeEvent implements vscode.ConfigurationChangeEvent {
    affectsConfigurationCalls: string[] = [];
    constructor(private readonly response: boolean) {}

    affectsConfiguration(section: string): boolean {
      this.affectsConfigurationCalls.push(section);
      return this.response;
    }
  }

  /** Fake of the `vscode.window.registerFileDecorationProvider` seam. */
  class FakeProviderRegistration {
    registeredProviders: vscode.FileDecorationProvider[] = [];
    disposables: FakeDisposable[] = [];

    register = (provider: vscode.FileDecorationProvider): vscode.Disposable => {
      this.registeredProviders.push(provider);
      const disposable = new FakeDisposable();
      this.disposables.push(disposable);
      return disposable;
    };
  }

  /** Fake of the `vscode.workspace.onDidChangeConfiguration` seam. Captures every registered
   * listener so a test can fire a `FakeConfigurationChangeEvent` at it directly. */
  class FakeConfigurationChangeRegistration {
    listeners: ((event: vscode.ConfigurationChangeEvent) => void)[] = [];
    disposables: FakeDisposable[] = [];

    onDidChangeConfiguration = (
      listener: (event: vscode.ConfigurationChangeEvent) => void
    ): vscode.Disposable => {
      this.listeners.push(listener);
      const disposable = new FakeDisposable();
      this.disposables.push(disposable);
      return disposable;
    };

    fire(event: vscode.ConfigurationChangeEvent): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  function createDeps(configValues: Record<string, unknown> = {}): {
    configuration: FakeConfiguration;
    providerRegistration: FakeProviderRegistration;
    configChangeRegistration: FakeConfigurationChangeRegistration;
    deps: {
      getConfiguration: () => FakeConfiguration;
      registerFileDecorationProvider: (provider: vscode.FileDecorationProvider) => vscode.Disposable;
      onDidChangeConfiguration: (
        listener: (event: vscode.ConfigurationChangeEvent) => void
      ) => vscode.Disposable;
    };
  } {
    const configuration = new FakeConfiguration(configValues);
    const providerRegistration = new FakeProviderRegistration();
    const configChangeRegistration = new FakeConfigurationChangeRegistration();
    return {
      configuration,
      providerRegistration,
      configChangeRegistration,
      deps: {
        getConfiguration: () => configuration,
        registerFileDecorationProvider: providerRegistration.register,
        onDidChangeConfiguration: configChangeRegistration.onDidChangeConfiguration
      }
    };
  }

  function decorationFor(
    provider: BookmarkDecorationProvider,
    uri: vscode.Uri
  ): vscode.FileDecoration | undefined {
    return provider.provideFileDecoration(uri, new vscode.CancellationTokenSource().token) as
      | vscode.FileDecoration
      | undefined;
  }

  test('reads bookmarksPlus.explorerDecoration.enabled with a fallback of true when unset', () => {
    const { configuration, deps } = createDeps();

    registerBookmarkDecorationProvider([], [], deps);

    const readCall = configuration.calls.find((call) => call.section === EXPLORER_DECORATION_ENABLED_KEY);
    assert.ok(readCall, 'expected the helper to read bookmarksPlus.explorerDecoration.enabled');
    assert.strictEqual(
      readCall!.defaultValue,
      true,
      'the fallback default passed to get() must be true when the setting is unset'
    );
  });

  test('registers the FileDecorationProvider exactly once, even when the initial config value is false', () => {
    const { deps, providerRegistration } = createDeps({ [EXPLORER_DECORATION_ENABLED_KEY]: false });

    const provider = registerBookmarkDecorationProvider([], [], deps);

    assert.strictEqual(
      providerRegistration.registeredProviders.length,
      1,
      'registration must happen exactly once regardless of the initial enabled value'
    );
    assert.strictEqual(
      providerRegistration.registeredProviders[0],
      provider,
      'the registered provider must be the same instance the helper returns'
    );
  });

  test('applies an initial enabled=false config value to the constructed provider before any change event', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uri = vscode.Uri.file('/workspace/a.txt');
    await store.addItem({ type: 'file', uri: uri.toString() });

    const { deps } = createDeps({ [EXPLORER_DECORATION_ENABLED_KEY]: false });
    const provider = registerBookmarkDecorationProvider([store], [], deps);

    assert.strictEqual(
      decorationFor(provider, uri),
      undefined,
      'the provider must start disabled when the config value is false at registration time'
    );
  });

  test('leaves the provider enabled when the config value is unset (fallback true) at registration time', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uri = vscode.Uri.file('/workspace/a.txt');
    await store.addItem({ type: 'file', uri: uri.toString() });

    const { deps } = createDeps();
    const provider = registerBookmarkDecorationProvider([store], [], deps);

    assert.ok(decorationFor(provider, uri), 'the provider must remain enabled by default');
  });

  test('seeds the constructed provider from the current contents of the given stores at registration time', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uri = vscode.Uri.file('/workspace/a.txt');
    await store.addItem({ type: 'file', uri: uri.toString() });

    const { deps } = createDeps();
    const provider = registerBookmarkDecorationProvider([store], [], deps);

    assert.ok(
      decorationFor(provider, uri),
      'expected the provider to already reflect bookmarks that existed in the store before registration'
    );
  });

  test('reacts to a configuration-change event affecting the watched key by re-reading and applying the fresh value', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uri = vscode.Uri.file('/workspace/a.txt');
    await store.addItem({ type: 'file', uri: uri.toString() });

    const { deps, configuration, configChangeRegistration } = createDeps();
    const provider = registerBookmarkDecorationProvider([store], [], deps);
    assert.ok(decorationFor(provider, uri), 'sanity check: the provider starts enabled');

    configuration.set(EXPLORER_DECORATION_ENABLED_KEY, false);
    const event = new FakeConfigurationChangeEvent(true);
    configChangeRegistration.fire(event);

    assert.ok(
      event.affectsConfigurationCalls.includes(EXPLORER_DECORATION_ENABLED_KEY),
      'expected the listener to call affectsConfiguration with bookmarksPlus.explorerDecoration.enabled'
    );
    assert.strictEqual(
      decorationFor(provider, uri),
      undefined,
      'setEnabled must have been called with the freshly re-read (false) config value'
    );
  });

  test('ignores a configuration-change event whose affectsConfiguration returns false for the watched key', async () => {
    const store = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const uri = vscode.Uri.file('/workspace/a.txt');
    await store.addItem({ type: 'file', uri: uri.toString() });

    const { deps, configuration, configChangeRegistration } = createDeps();
    const provider = registerBookmarkDecorationProvider([store], [], deps);

    // The setting value on disk changed, but this particular event does not report it as
    // affected — e.g. it fired for an unrelated configuration key.
    configuration.set(EXPLORER_DECORATION_ENABLED_KEY, false);
    const event = new FakeConfigurationChangeEvent(false);
    configChangeRegistration.fire(event);

    assert.ok(
      decorationFor(provider, uri),
      'setEnabled must not be called when affectsConfiguration returns false for the watched key'
    );
  });

  test('pushes the provider-registration disposable onto subscriptions, disposed exactly once on teardown', () => {
    const { deps, providerRegistration } = createDeps();
    const subscriptions: vscode.Disposable[] = [];

    registerBookmarkDecorationProvider([], subscriptions, deps);
    for (const subscription of subscriptions) {
      subscription.dispose();
    }

    assert.strictEqual(providerRegistration.disposables.length, 1);
    assert.strictEqual(
      providerRegistration.disposables[0].disposeCallCount,
      1,
      'disposing everything pushed onto subscriptions must dispose the provider-registration disposable exactly once'
    );
  });

  test('pushes the configuration-change listener disposable onto subscriptions, disposed exactly once on teardown', () => {
    const { deps, configChangeRegistration } = createDeps();
    const subscriptions: vscode.Disposable[] = [];

    registerBookmarkDecorationProvider([], subscriptions, deps);
    for (const subscription of subscriptions) {
      subscription.dispose();
    }

    assert.strictEqual(configChangeRegistration.disposables.length, 1);
    assert.strictEqual(
      configChangeRegistration.disposables[0].disposeCallCount,
      1,
      'disposing everything pushed onto subscriptions must dispose the configuration-listener disposable exactly once'
    );
  });

  test('pushes both store-event subscriptions onto subscriptions, so disposal stops further decoration invalidation', async () => {
    const workspaceStore = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const globalStore = new BookmarkStore(new FakeMemento(), new FakeOutput());
    const { deps } = createDeps();
    const subscriptions: vscode.Disposable[] = [];

    const provider = registerBookmarkDecorationProvider([workspaceStore, globalStore], subscriptions, deps);
    let fireCount = 0;
    provider.onDidChangeFileDecorations(() => {
      fireCount++;
    });

    await workspaceStore.addItem({ type: 'file', uri: vscode.Uri.file('/workspace/a.txt').toString() });
    assert.strictEqual(fireCount, 1, 'sanity check: the workspace store is wired before disposal');

    await globalStore.addItem({ type: 'file', uri: vscode.Uri.file('/global/b.txt').toString() });
    assert.strictEqual(fireCount, 2, 'sanity check: the global store is wired before disposal');

    for (const subscription of subscriptions) {
      subscription.dispose();
    }

    const uriC = vscode.Uri.file('/workspace/c.txt');
    await workspaceStore.addItem({ type: 'file', uri: uriC.toString() });
    await globalStore.addItem({ type: 'file', uri: vscode.Uri.file('/global/d.txt').toString() });

    assert.strictEqual(
      fireCount,
      2,
      'disposing everything pushed onto subscriptions must stop both stores from further invalidating decorations'
    );
    assert.strictEqual(
      decorationFor(provider, uriC),
      undefined,
      'the store-event subscription(s) themselves must be disposed, not merely the event emitter — ' +
        'a still-live subscription would keep resyncing the decorated-key set even if firing the ' +
        'now-disposed onDidChangeFileDecorations event is a silent no-op'
    );
  });
});
