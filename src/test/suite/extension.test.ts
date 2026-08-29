import * as assert from 'assert';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { BookmarkDecorationProvider } from '../../bookmarkDecorationProvider';
import {
  handleWorkspaceFoldersChanged,
  registerBookmarkDecorationProvider,
  registerRecentItemsTracker
} from '../../extension';
// Namespace import (not a named import) so `registerSuggestionsMaxItemsLiveReload` (#102, not yet
// implemented) can be resolved dynamically below without a compile-time failure on the missing
// export — a compile error is not a valid "red" for this suite; the assertion inside
// `requireRegisterFn()` is the intended failure mode until T-#102 adds the export.
import * as extensionModule from '../../extension';
import { loadRecentItems, normalizeMaxItems } from '../../recentItems';
import { FakeMemento, fakeTab, FakeMirror, FakeOutput } from './fixtures';

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
      'bookmarks.addToWorkspace',
      'bookmarks.promoteSuggestion'
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

  // T5 (plan §6, docs/superpowers/plans/2026-08-25-explorer-decoration-for-bookmarked-files.md):
  // package.json contribution and manifest assertion. D1 resolved to (a), so no
  // contributes.colors section is needed — only the explorerDecoration.enabled setting. This
  // property does not exist in package.json yet, so this test is expected to fail until T5 adds
  // it.
  test('contributes.configuration declares bookmarksPlus.explorerDecoration.enabled as a boolean, default true, window-scoped setting (T5, plan §6)', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    const properties: Record<string, { type?: string; default?: unknown; scope?: string }> | undefined =
      ext!.packageJSON.contributes?.configuration?.properties;
    assert.ok(
      properties && Object.prototype.hasOwnProperty.call(properties, 'bookmarksPlus.explorerDecoration.enabled'),
      'expected package.json contributes.configuration.properties to declare bookmarksPlus.explorerDecoration.enabled'
    );

    const property = properties!['bookmarksPlus.explorerDecoration.enabled'];
    assert.strictEqual(
      property.type,
      'boolean',
      'bookmarksPlus.explorerDecoration.enabled must be declared with type: "boolean"'
    );
    assert.strictEqual(
      property.default,
      true,
      'bookmarksPlus.explorerDecoration.enabled must default to true'
    );
    assert.strictEqual(
      property.scope,
      'window',
      'bookmarksPlus.explorerDecoration.enabled must be declared with scope: "window"'
    );
  });

  // --- #95 T7 (plan docs/superpowers/plans/2026-08-25-suggested-bookmarks-from-recent-items.md):
  // package.json manifest additions for suggested bookmarks — the new command, its command-palette
  // suppression (C5), its view/item/context entry, and the maxItems setting (D3, RESOLVED).

  test('bookmarks.promoteSuggestion is hidden from the command palette like its sibling node-argument commands (C5)', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    const commandPalette: Array<{ command: string; when?: string }> =
      ext!.packageJSON.contributes.menus.commandPalette;
    const entry = commandPalette.find((item) => item.command === 'bookmarks.promoteSuggestion');
    assert.ok(
      entry,
      'expected a contributes.menus.commandPalette entry for bookmarks.promoteSuggestion — it takes ' +
        'a tree-node argument, so palette invocation (no argument) would fail'
    );
    assert.strictEqual(
      entry!.when,
      'false',
      'bookmarks.promoteSuggestion must have when: "false" in contributes.menus.commandPalette to stay hidden from the palette'
    );
  });

  test('view/item/context contributes a promoteSuggestion entry keyed on viewItem == bookmarkSuggestion (T5/T7)', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    const viewItemContext: Array<{ command: string; when?: string }> =
      ext!.packageJSON.contributes.menus['view/item/context'];
    const entry = viewItemContext.find((item) => item.command === 'bookmarks.promoteSuggestion');
    assert.ok(entry, 'expected a view/item/context entry for bookmarks.promoteSuggestion');
    assert.ok(
      entry!.when?.includes('viewItem == bookmarkSuggestion'),
      'the promoteSuggestion menu entry must be keyed on viewItem == bookmarkSuggestion, matching ' +
        'the contextValue T5 sets on a suggestion tree item'
    );
  });

  test('contributes.configuration declares bookmarksPlus.suggestions.maxItems as a number, default 10 (D3, RESOLVED)', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    const properties: Record<string, { type?: string; default?: unknown }> | undefined =
      ext!.packageJSON.contributes?.configuration?.properties;
    assert.ok(
      properties && Object.prototype.hasOwnProperty.call(properties, 'bookmarksPlus.suggestions.maxItems'),
      'expected package.json contributes.configuration.properties to declare bookmarksPlus.suggestions.maxItems'
    );

    const property = properties!['bookmarksPlus.suggestions.maxItems'];
    assert.strictEqual(
      property.type,
      'number',
      'bookmarksPlus.suggestions.maxItems must be declared with type: "number"'
    );
    assert.strictEqual(property.default, 10, 'bookmarksPlus.suggestions.maxItems must default to 10 (D3)');
  });

  test('contributes.configuration declares bookmarksPlus.suggestions.maxItems with minimum: 0 (CodeRabbit: reject negative config values at the schema)', async () => {
    const ext = vscode.extensions.getExtension('cbeaulieu-gt.vscode-bookmarks-plus');
    assert.ok(ext, 'extension not found — check "publisher"/"name" in package.json');
    await ext!.activate();

    const properties: Record<string, { minimum?: unknown }> | undefined =
      ext!.packageJSON.contributes?.configuration?.properties;
    const property = properties?.['bookmarksPlus.suggestions.maxItems'];
    assert.ok(property, 'expected package.json contributes.configuration.properties to declare bookmarksPlus.suggestions.maxItems');
    assert.strictEqual(
      property!.minimum,
      0,
      'bookmarksPlus.suggestions.maxItems must declare minimum: 0 — a negative value can evict every ' +
        'promoted suggestion (see recentItems.test.ts, "recentItems - normalizeMaxItems")'
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

// --- #95 T4/T8: registerRecentItemsTracker — activation wiring for tracking recently-opened tabs
// (plan docs/superpowers/plans/2026-08-25-suggested-bookmarks-from-recent-items.md). Mirrors the
// registerBookmarkDecorationProvider (T4, #96) DI seam directly above: real
// `vscode.window.tabGroups.onDidChangeTabs` is never monkey-patched (this file's established norm
// — see the "no monkey-patch the read-only vscode module" framing on the decoration-provider suite
// above); instead a fake tabGroups-shaped dependency is injected. `registerRecentItemsTracker` does
// not exist yet, so this suite is expected to fail to compile until T4/T8 add it.
//
// Assumption (not pinned by the plan, which explicitly leaves this signature to implementation
// time — plan T4/T8): `registerRecentItemsTracker(memento, subscriptions, deps)` where
// `deps.getTabGroups()` returns a `{ onDidChangeTabs }`-shaped seam and `deps.maxItems` is the cap
// to pass through to `recordOpen`. Any further fields the real implementation's `deps` type needs
// (e.g. a change-notification callback, an injectable clock) must be optional, since the fakes
// below construct `deps` with only these two fields.
//
// Scope note: the plan (T4) explicitly flags that whether repeated *preview* opens of the same uri
// arrive via `TabChangeEvent.opened` or `.changed` needs empirical verification against real VS
// Code behavior — this suite deliberately does not assert which array feeds the preview counter.
// It covers only what the plan pins unconditionally: the subscription/disposal wiring, that a
// plain non-preview open is recorded and persisted, that a single preview open is recorded without
// promoting, that closed tabs are never recorded, and that a non-file-scheme / diff tab is
// filtered out via extractTabUri (T3).
suite('registerRecentItemsTracker (#95 T4/T8)', () => {
  class FakeDisposable implements vscode.Disposable {
    disposeCallCount = 0;
    dispose(): void {
      this.disposeCallCount++;
    }
  }

  class FakeTabGroupsRegistration {
    listeners: Array<(event: vscode.TabChangeEvent) => void> = [];
    disposables: FakeDisposable[] = [];

    onDidChangeTabs = (listener: (event: vscode.TabChangeEvent) => void): vscode.Disposable => {
      this.listeners.push(listener);
      const disposable = new FakeDisposable();
      this.disposables.push(disposable);
      return disposable;
    };

    fire(event: Partial<vscode.TabChangeEvent>): void {
      const fullEvent: vscode.TabChangeEvent = { opened: [], closed: [], changed: [], ...event };
      for (const listener of this.listeners) {
        listener(fullEvent);
      }
    }
  }

  function createDeps(maxItems = 10): {
    tabGroups: FakeTabGroupsRegistration;
    deps: {
      getTabGroups: () => Pick<vscode.TabGroups, 'onDidChangeTabs'>;
      maxItems: number;
    };
  } {
    const tabGroups = new FakeTabGroupsRegistration();
    return {
      tabGroups,
      deps: {
        getTabGroups: () => ({ onDidChangeTabs: tabGroups.onDidChangeTabs }),
        maxItems
      }
    };
  }

  test('subscribes to tabGroups.onDidChangeTabs exactly once', () => {
    const { tabGroups, deps } = createDeps();
    registerRecentItemsTracker(new FakeMemento(), [], deps);
    assert.strictEqual(tabGroups.listeners.length, 1);
  });

  test('pushes the subscription disposable onto subscriptions, disposed exactly once on teardown', () => {
    const { tabGroups, deps } = createDeps();
    const subscriptions: vscode.Disposable[] = [];

    registerRecentItemsTracker(new FakeMemento(), subscriptions, deps);
    for (const subscription of subscriptions) {
      subscription.dispose();
    }

    assert.strictEqual(tabGroups.disposables.length, 1);
    assert.strictEqual(tabGroups.disposables[0].disposeCallCount, 1);
  });

  test('records a non-preview opened text tab as a promoted entry, persisted to workspaceState', () => {
    const { tabGroups, deps } = createDeps();
    const memento = new FakeMemento();
    registerRecentItemsTracker(memento, [], deps);

    const uri = vscode.Uri.file('/workspace/a.txt');
    tabGroups.fire({ opened: [fakeTab(new vscode.TabInputText(uri), { isPreview: false })] });

    const list = loadRecentItems(memento);
    const entry = list.find((i) => i.uri === uri.toString());
    assert.ok(entry, 'expected the opened tab to be recorded');
    assert.strictEqual(entry!.promoted, true, 'a non-preview open must promote immediately');
  });

  test('records a preview opened text tab without promoting it', () => {
    const { tabGroups, deps } = createDeps();
    const memento = new FakeMemento();
    registerRecentItemsTracker(memento, [], deps);

    const uri = vscode.Uri.file('/workspace/preview.txt');
    tabGroups.fire({ opened: [fakeTab(new vscode.TabInputText(uri), { isPreview: true })] });

    const list = loadRecentItems(memento);
    const entry = list.find((i) => i.uri === uri.toString());
    assert.ok(entry, 'expected the preview tab to still be tracked (counter-only, per D2)');
    assert.strictEqual(entry!.promoted, false, 'a single preview open must not promote (threshold 3, D2)');
  });

  test('a closed tab is never recorded', () => {
    const { tabGroups, deps } = createDeps();
    const memento = new FakeMemento();
    registerRecentItemsTracker(memento, [], deps);

    const uri = vscode.Uri.file('/workspace/closed.txt');
    tabGroups.fire({ closed: [fakeTab(new vscode.TabInputText(uri), { isPreview: false })] });

    const list = loadRecentItems(memento);
    assert.strictEqual(
      list.find((i) => i.uri === uri.toString()),
      undefined
    );
  });

  test('a non-file-scheme tab (e.g. output:) is filtered out via extractTabUri (T3/C6)', () => {
    const { tabGroups, deps } = createDeps();
    const memento = new FakeMemento();
    registerRecentItemsTracker(memento, [], deps);

    const uri = vscode.Uri.parse('output:some-channel');
    tabGroups.fire({ opened: [fakeTab(new vscode.TabInputText(uri), { isPreview: false })] });

    const list = loadRecentItems(memento);
    assert.strictEqual(list.length, 0, 'a non-file-scheme tab must never be recorded');
  });

  test('a diff tab (TabInputTextDiff) is filtered out — no single uri to record (D1)', () => {
    const { tabGroups, deps } = createDeps();
    const memento = new FakeMemento();
    registerRecentItemsTracker(memento, [], deps);

    const original = vscode.Uri.file('/workspace/original.txt');
    const modified = vscode.Uri.file('/workspace/modified.txt');
    tabGroups.fire({
      opened: [fakeTab(new vscode.TabInputTextDiff(original, modified), { isPreview: false })]
    });

    const list = loadRecentItems(memento);
    assert.strictEqual(list.length, 0, 'a diff tab must never be recorded (D1: skipped entirely in v1)');
  });

  // CodeRabbit finding (PR #103, package.json review): maxItems config normalization. This is the
  // integration point showing the normalized cap actually reaches `recordOpen` through the full
  // `registerRecentItemsTracker` pipeline — `deps.maxItems` is documented as the already-normalized
  // value the config-read site in `activate()` is expected to compute via `normalizeMaxItems`
  // before injecting it here (see recentItems.test.ts, "recentItems - normalizeMaxItems", for the
  // pure-function unit tests and the direct recordOpen-composition tests).
  test('a normalized (floored) maxItems value caps the tracked promoted list through the tracker, not just at the raw config value (CodeRabbit: maxItems config normalization)', () => {
    const normalizedCap = normalizeMaxItems(3.7); // expected 3
    const { tabGroups, deps } = createDeps(normalizedCap);
    const memento = new FakeMemento();
    registerRecentItemsTracker(memento, [], deps);

    for (const name of ['a', 'b', 'c', 'd']) {
      const uri = vscode.Uri.file(`/workspace/${name}.txt`);
      tabGroups.fire({ opened: [fakeTab(new vscode.TabInputText(uri), { isPreview: false })] });
    }

    const promoted = loadRecentItems(memento).filter((i) => i.promoted);
    assert.strictEqual(
      promoted.length,
      3,
      'a fractional maxItems of 3.7, normalized to 3 before reaching the tracker, must cap the ' +
        'tracked promoted list at 3 entries, not 4'
    );
  });
});

// --- #102: live-reload of bookmarksPlus.suggestions.maxItems -------------------------------
//
// Today (pre-#102) `activate()` reads bookmarksPlus.suggestions.maxItems exactly once, at
// activation time, and hands the normalized value to two consumers: `registerRecentItemsTracker`'s
// `deps.maxItems` (read live inside its tab-change listener — extension.ts, not hoisted to a local)
// and the `BookmarksTreeDataProvider`'s `SuggestionsSource.maxItems` (read live inside
// `getSuggestedLeaves`/`withRoots`, not captured). Because both consumers already re-read their
// backing value on every use rather than snapshotting it once, neither `recentItems.ts` nor
// `bookmarksTreeDataProvider.ts` needs to change for the cap to become live-reloadable — only
// `extension.ts` needs a new `workspace.onDidChangeConfiguration` listener that re-reads,
// re-normalizes, and pushes the fresh cap into both consumers, then forces a tree refresh (VS Code
// does not re-query `getChildren` just because a backing value changed out from under it).
//
// Test-author design choice (this function does not exist yet — T-#102 must add it): a third DI
// helper, `registerSuggestionsMaxItemsLiveReload(subscriptions, deps)`, mirroring the two existing
// precedents immediately above (`registerBookmarkDecorationProvider`, `registerRecentItemsTracker`)
// rather than adding untestable inline logic to `activate()` itself. `deps` exposes:
//   - `getConfiguration()` / `onDidChangeConfiguration(listener)` — the same
//     `vscode.workspace`-shaped seams `registerBookmarkDecorationProvider` already uses.
//   - `setTrackerMaxItems(maxItems)` / `setSuggestionsMaxItems(maxItems)` — callbacks the
//     implementation invokes with the freshly re-read, re-normalized cap. Deliberately callbacks,
//     not "hand back a mutable object and mutate its .maxItems field" — that would bake one
//     particular propagation mechanism into a frozen test contract instead of asserting the
//     observable result. In the real `activate()` wiring these callbacks are expected to close over
//     the same `deps.maxItems` object already passed to `registerRecentItemsTracker` and the same
//     `SuggestionsSource` object already passed to `BookmarksTreeDataProvider`, but that wiring
//     detail is `activate()`'s to choose, not this suite's to assert.
//   - `refresh()` — called to force the tree to re-render (e.g. `provider?.refresh()`).
// The helper subscribes exactly one `onDidChangeConfiguration` listener, pushed onto
// `subscriptions` per the established disposal convention, whose body is a no-op unless
// `event.affectsConfiguration('bookmarksPlus.suggestions.maxItems')` is true.
//
// Coverage gap (report, not to solve here): every test below exercises the helper directly, not
// `activate()` itself. `activate()` returns `void` and exposes no DI seam of its own, so whether
// `activate()` actually calls this helper is unverifiable at this granularity — same limitation
// already accepted for `registerBookmarkDecorationProvider`/`registerRecentItemsTracker` above,
// neither of which has an `activate()`-level wiring test either.
suite('registerSuggestionsMaxItemsLiveReload (#102)', () => {
  const SUGGESTIONS_MAX_ITEMS_KEY = 'bookmarksPlus.suggestions.maxItems';
  const SUGGESTIONS_MAX_ITEMS_DEFAULT = 10;

  class FakeDisposable implements vscode.Disposable {
    disposeCallCount = 0;
    dispose(): void {
      this.disposeCallCount++;
    }
  }

  /** Fake of the `vscode.WorkspaceConfiguration` subset the helper reads from — copied from the
   * `registerBookmarkDecorationProvider` suite above rather than shared, matching this file's
   * existing convention of duplicating these small per-suite fakes instead of lifting them to
   * fixtures.ts. */
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

  class FakeConfigurationChangeEvent implements vscode.ConfigurationChangeEvent {
    affectsConfigurationCalls: string[] = [];
    constructor(private readonly response: boolean) {}

    affectsConfiguration(section: string): boolean {
      this.affectsConfigurationCalls.push(section);
      return this.response;
    }
  }

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

  interface MaxItemsLiveReloadDeps {
    getConfiguration: () => { get<T>(section: string, defaultValue: T): T };
    onDidChangeConfiguration: (
      listener: (event: vscode.ConfigurationChangeEvent) => void
    ) => vscode.Disposable;
    setTrackerMaxItems: (maxItems: number) => void;
    setSuggestionsMaxItems: (maxItems: number) => void;
    refresh: () => void;
  }

  type MaxItemsLiveReloadFn = (subscriptions: vscode.Disposable[], deps: MaxItemsLiveReloadDeps) => void;

  interface MaxItemsLiveReloadModule {
    registerSuggestionsMaxItemsLiveReload?: MaxItemsLiveReloadFn;
  }

  /** Resolves `registerSuggestionsMaxItemsLiveReload` off the module namespace without a
   * compile-time named import (see the import comment at the top of this file), then asserts it
   * exists. Until #102 is implemented this assertion is the intended failure for every test in
   * this suite — a clean, message-bearing "missing behavior" red rather than a tsc error. */
  function requireRegisterFn(): MaxItemsLiveReloadFn {
    const fn = (extensionModule as MaxItemsLiveReloadModule).registerSuggestionsMaxItemsLiveReload;
    assert.ok(
      typeof fn === 'function',
      'expected extension.ts to export registerSuggestionsMaxItemsLiveReload(subscriptions, deps) ' +
        '(#102) — the live-reload wiring for bookmarksPlus.suggestions.maxItems does not exist yet'
    );
    return fn as MaxItemsLiveReloadFn;
  }

  function createDeps(configValues: Record<string, unknown> = {}): {
    configuration: FakeConfiguration;
    configChangeRegistration: FakeConfigurationChangeRegistration;
    trackerCalls: number[];
    suggestionsCalls: number[];
    refreshCallCount: () => number;
    deps: MaxItemsLiveReloadDeps;
  } {
    const configuration = new FakeConfiguration(configValues);
    const configChangeRegistration = new FakeConfigurationChangeRegistration();
    const trackerCalls: number[] = [];
    const suggestionsCalls: number[] = [];
    let refreshCount = 0;
    return {
      configuration,
      configChangeRegistration,
      trackerCalls,
      suggestionsCalls,
      refreshCallCount: () => refreshCount,
      deps: {
        getConfiguration: () => configuration,
        onDidChangeConfiguration: configChangeRegistration.onDidChangeConfiguration,
        setTrackerMaxItems: (maxItems: number) => {
          trackerCalls.push(maxItems);
        },
        setSuggestionsMaxItems: (maxItems: number) => {
          suggestionsCalls.push(maxItems);
        },
        refresh: () => {
          refreshCount++;
        }
      }
    };
  }

  test('registers exactly one onDidChangeConfiguration listener', () => {
    const fn = requireRegisterFn();
    const { deps, configChangeRegistration } = createDeps();

    fn([], deps);

    assert.strictEqual(
      configChangeRegistration.listeners.length,
      1,
      'expected exactly one onDidChangeConfiguration listener to be registered'
    );
  });

  test('pushes the configuration-change listener disposable onto subscriptions, disposed exactly once on teardown', () => {
    const fn = requireRegisterFn();
    const { deps, configChangeRegistration } = createDeps();
    const subscriptions: vscode.Disposable[] = [];

    fn(subscriptions, deps);
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

  test('ignores a configuration-change event whose affectsConfiguration returns false for the watched key: no cap propagation, no refresh', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration, trackerCalls, suggestionsCalls, refreshCallCount } =
      createDeps();
    fn([], deps);

    // The setting value on disk changed, but this particular event does not report it as
    // affected — e.g. it fired for an unrelated configuration key.
    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, 5);
    configChangeRegistration.fire(new FakeConfigurationChangeEvent(false));

    assert.strictEqual(
      trackerCalls.length,
      0,
      'setTrackerMaxItems must not be called when affectsConfiguration returns false for the watched key'
    );
    assert.strictEqual(
      suggestionsCalls.length,
      0,
      'setSuggestionsMaxItems must not be called when affectsConfiguration returns false for the watched key'
    );
    assert.strictEqual(
      refreshCallCount(),
      0,
      'refresh must not be called when affectsConfiguration returns false for the watched key'
    );
  });

  test('calls affectsConfiguration with bookmarksPlus.suggestions.maxItems', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration } = createDeps();
    fn([], deps);

    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, 4);
    const event = new FakeConfigurationChangeEvent(true);
    configChangeRegistration.fire(event);

    assert.ok(
      event.affectsConfigurationCalls.includes(SUGGESTIONS_MAX_ITEMS_KEY),
      'expected the listener to call affectsConfiguration with bookmarksPlus.suggestions.maxItems'
    );
  });

  test('propagates the freshly read cap to both the tracker and the suggestions source when the change affects the watched key', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration, trackerCalls, suggestionsCalls } = createDeps();
    fn([], deps);

    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, 4);
    configChangeRegistration.fire(new FakeConfigurationChangeEvent(true));

    assert.deepStrictEqual(
      trackerCalls,
      [4],
      'expected setTrackerMaxItems to be called once with the freshly configured value'
    );
    assert.deepStrictEqual(
      suggestionsCalls,
      [4],
      'expected setSuggestionsMaxItems to be called once with the freshly configured value'
    );
  });

  test('re-reads the configuration at change time rather than a stale value captured at registration', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration, trackerCalls, suggestionsCalls } = createDeps({
      [SUGGESTIONS_MAX_ITEMS_KEY]: 10
    });
    fn([], deps);

    // Changed after registration, before the change event fires — the listener must not have
    // captured/closed over the value that was present when `fn` was called.
    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, 2);
    configChangeRegistration.fire(new FakeConfigurationChangeEvent(true));

    assert.deepStrictEqual(
      trackerCalls,
      [2],
      'expected the listener to re-read the config value at change time (2), not the value present at registration time (10)'
    );
    assert.deepStrictEqual(
      suggestionsCalls,
      [2],
      'expected the listener to re-read the config value at change time (2), not the value present at registration time (10)'
    );
  });

  test('re-reads bookmarksPlus.suggestions.maxItems using a fallback default of 10 when calling get()', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration } = createDeps();
    fn([], deps);

    configChangeRegistration.fire(new FakeConfigurationChangeEvent(true));

    const readCall = configuration.calls.find((call) => call.section === SUGGESTIONS_MAX_ITEMS_KEY);
    assert.ok(readCall, 'expected the change listener to re-read bookmarksPlus.suggestions.maxItems');
    assert.strictEqual(
      readCall!.defaultValue,
      SUGGESTIONS_MAX_ITEMS_DEFAULT,
      'the fallback default passed to get() must be 10, matching SUGGESTIONS_MAX_ITEMS_DEFAULT'
    );
  });

  test('normalizes a negative raw config value (-5) to 0 before propagating, matching normalizeMaxItems', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration, trackerCalls, suggestionsCalls } = createDeps();
    fn([], deps);

    assert.strictEqual(normalizeMaxItems(-5), 0, 'sanity check on normalizeMaxItems itself');

    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, -5);
    configChangeRegistration.fire(new FakeConfigurationChangeEvent(true));

    assert.deepStrictEqual(trackerCalls, [0], 'a negative raw value must be clamped to 0 before reaching the tracker');
    assert.deepStrictEqual(
      suggestionsCalls,
      [0],
      'a negative raw value must be clamped to 0 before reaching the suggestions source'
    );
  });

  test('normalizes a fractional raw config value (2.7) to 2 before propagating, matching normalizeMaxItems', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration, trackerCalls, suggestionsCalls } = createDeps();
    fn([], deps);

    assert.strictEqual(normalizeMaxItems(2.7), 2, 'sanity check on normalizeMaxItems itself');

    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, 2.7);
    configChangeRegistration.fire(new FakeConfigurationChangeEvent(true));

    assert.deepStrictEqual(trackerCalls, [2], 'a fractional raw value must be floored to 2 before reaching the tracker');
    assert.deepStrictEqual(
      suggestionsCalls,
      [2],
      'a fractional raw value must be floored to 2 before reaching the suggestions source'
    );
  });

  test('triggers exactly one tree refresh after a scoped, valid change', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration, refreshCallCount } = createDeps();
    fn([], deps);

    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, 6);
    configChangeRegistration.fire(new FakeConfigurationChangeEvent(true));

    assert.strictEqual(refreshCallCount(), 1, 'expected exactly one tree refresh after a scoped maxItems change');
  });

  test('re-saving the same maxItems value re-applies safely without throwing (regression)', () => {
    const fn = requireRegisterFn();
    const { deps, configuration, configChangeRegistration, trackerCalls, suggestionsCalls } = createDeps({
      [SUGGESTIONS_MAX_ITEMS_KEY]: 5
    });
    fn([], deps);

    // Re-saving the exact same value: VS Code still fires a configuration-change event for this,
    // and affectsConfiguration still reports it as affected — the listener must not throw or skip
    // re-propagating just because the value is unchanged from what was last applied.
    configuration.set(SUGGESTIONS_MAX_ITEMS_KEY, 5);
    assert.doesNotThrow(() => {
      configChangeRegistration.fire(new FakeConfigurationChangeEvent(true));
    });

    assert.deepStrictEqual(
      trackerCalls,
      [5],
      'an unchanged value must still be safely re-applied to the tracker'
    );
    assert.deepStrictEqual(
      suggestionsCalls,
      [5],
      'an unchanged value must still be safely re-applied to the suggestions source'
    );
  });
});
