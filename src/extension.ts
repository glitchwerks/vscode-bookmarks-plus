import * as fs from 'fs';
import * as vscode from 'vscode';
import { BookmarkStore, OutputSink } from './bookmarkStore';
import { BookmarkDecorationProvider } from './bookmarkDecorationProvider';
import { BookmarkContextKeyManager } from './bookmarkContextKeys';
import {
  MIRROR_RELATIVE_PATH,
  MirrorLocation,
  MirrorPort,
  WorkspaceMirrorFile,
  resolveMirrorLocation
} from './bookmarkMirror';
import { BookmarksTreeDataProvider, RecentlyViewedSource, SuggestionsSource } from './bookmarksTreeDataProvider';
import {
  registerAddCommands,
  registerAddToWorkspaceCommand,
  registerCollectionCommands,
  registerDescriptionCommands,
  registerItemCommands,
  registerViewCommands,
  ScopedStores
} from './commands';
import { Delayer } from './delayer';
import { CacheEntry, FsGitCache, ResolveFn } from './fsGitCache';
import {
  createGitApiFactory,
  findRepoNameForUri,
  GitApiFactory,
  GitExtensionExports
} from './gitInfo';
import { registerBookmarksMcpProvider } from './mcpServerProvider';
import { extractTabUri, loadRecentItems, normalizeMaxItems, recordOpen, saveRecentItems } from './recentItems';
import {
  loadRecentlyViewed,
  RECENTLY_VIEWED_MAX_ITEMS,
  recordView,
  saveRecentlyViewed
} from './recentlyViewed';
import { applyWorkspaceEnv } from './workspaceEnv';

const WATCHER_DEBOUNCE_MS = 150;
const EXPLORER_DECORATION_ENABLED_KEY = 'bookmarksPlus.explorerDecoration.enabled';
const SUGGESTIONS_MAX_ITEMS_KEY = 'bookmarksPlus.suggestions.maxItems';
const SUGGESTIONS_MAX_ITEMS_DEFAULT = 10;
const MCP_TEST_DEFINITIONS_COMMAND = 'bookmarks.test.getMcpServerDefinitions';

let activeStores: BookmarkStore[] = [];

export interface McpActivationDependencies {
  getWorkspaceFolders: () => readonly { uri: vscode.Uri }[] | undefined;
  registerProvider: (
    id: string,
    provider: vscode.McpServerDefinitionProvider
  ) => vscode.Disposable;
  onDidChangeWorkspaceFolders: (listener: () => void) => vscode.Disposable;
}

export async function disposeStores(stores: (BookmarkStore | undefined)[]): Promise<void> {
  for (const store of stores) {
    if (!store) {
      continue;
    }
    await store.flushMirrorWrites();
    store.dispose();
  }
}

function logMirrorDisabled(output: OutputSink, reason: string): void {
  output.appendLine(
    `Bookmarks Plus: the ${MIRROR_RELATIVE_PATH} mirror is disabled — ${reason}.`
  );
}

type EnabledMirrorLocation = Extract<MirrorLocation, { kind: 'enabled' }>;

export interface WorkspaceMirrorChangeDependencies {
  createMirror: (location: EnabledMirrorLocation) => MirrorPort;
  createResources: (
    location: EnabledMirrorLocation,
    onMirrorEvent: () => void
  ) => vscode.Disposable;
}

function createMirrorResources(
  location: EnabledMirrorLocation,
  onMirrorEvent: () => void
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(location.folder, MIRROR_RELATIVE_PATH)
  );
  const reloadDelayer = new Delayer(WATCHER_DEBOUNCE_MS);
  const triggerReload = (): void => {
    reloadDelayer.trigger(onMirrorEvent);
  };

  return vscode.Disposable.from(
    watcher,
    reloadDelayer,
    watcher.onDidChange(triggerReload),
    watcher.onDidCreate(triggerReload),
    watcher.onDidDelete(triggerReload)
  );
}

const defaultWorkspaceMirrorChangeDependencies: WorkspaceMirrorChangeDependencies = {
  createMirror: (location) => new WorkspaceMirrorFile(location),
  createResources: createMirrorResources
};

export async function handleWorkspaceFoldersChanged(
  store: BookmarkStore,
  output: OutputSink,
  folders: readonly { uri: vscode.Uri }[] | undefined,
  mirrorResources?: vscode.Disposable,
  refresh?: () => void,
  deps: WorkspaceMirrorChangeDependencies = defaultWorkspaceMirrorChangeDependencies
): Promise<vscode.Disposable | undefined> {
  const location = resolveMirrorLocation(folders);
  await store.rebindMirror(undefined);
  mirrorResources?.dispose();

  if (location.kind === 'disabled') {
    logMirrorDisabled(output, location.reason);
    refresh?.();
    return undefined;
  }

  let resources: vscode.Disposable | undefined;
  try {
    await store.rebindMirror(deps.createMirror(location));
    resources = deps.createResources(location, () => {
      void store.reloadFromMirror();
    });
    await store.syncWithMirror();
    refresh?.();
    return resources;
  } catch (error: unknown) {
    resources?.dispose();
    try {
      await store.rebindMirror(undefined);
    } catch {
      // Preserve the original setup or reconciliation error.
    }
    throw error;
  }
}

export class WorkspaceMirrorChangeCoordinator implements vscode.Disposable {
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private provisionalResources?: vscode.Disposable;

  constructor(
    private readonly store: BookmarkStore,
    private readonly output: OutputSink,
    private mirrorResources?: vscode.Disposable,
    private readonly refresh?: () => void,
    private readonly deps: WorkspaceMirrorChangeDependencies = defaultWorkspaceMirrorChangeDependencies
  ) {}

  rebind(folders: readonly { uri: vscode.Uri }[] | undefined): Promise<void> {
    const snapshot = folders ? [...folders] : undefined;
    const operation = this.pending.then(async () => {
      if (this.disposed) {
        return;
      }

      let resources: vscode.Disposable | undefined;
      try {
        resources = await handleWorkspaceFoldersChanged(
          this.store,
          this.output,
          snapshot,
          this.mirrorResources,
          this.refresh,
          {
            ...this.deps,
            createResources: (location, onMirrorEvent) => {
              const provisional = this.deps.createResources(location, onMirrorEvent);
              this.provisionalResources = provisional;
              if (this.disposed) {
                provisional.dispose();
                this.store.detachMirror();
              }
              return provisional;
            }
          }
        );
      } finally {
        this.provisionalResources = undefined;
      }
      if (this.disposed) {
        resources?.dispose();
        this.store.detachMirror();
        return;
      }
      this.mirrorResources = resources;
    });

    // Keep later transitions runnable after a failed one while returning the original rejection
    // to the caller so activation can log it.
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  dispose(): void {
    this.disposed = true;
    this.provisionalResources?.dispose();
    this.provisionalResources = undefined;
    this.mirrorResources?.dispose();
    this.mirrorResources = undefined;
    this.store.detachMirror();
  }
}

function createCacheResolver(getGitApi: GitApiFactory): ResolveFn {
  return async (uriString: string): Promise<CacheEntry> => {
    const uri = vscode.Uri.parse(uriString);
    let exists = true;

    try {
      await fs.promises.stat(uri.fsPath);
    } catch {
      exists = false;
    }

    const api = await getGitApi();
    const repoName = api ? findRepoNameForUri(api, uri) : undefined;
    return { exists, repoName };
  };
}

/**
 * Registers a {@link BookmarkDecorationProvider} wired to `stores`, seeded from the
 * `bookmarksPlus.explorerDecoration.enabled` setting (fallback `true`), and kept in sync with
 * subsequent configuration changes (T4, plan §6). Registration and configuration dependencies are
 * injected so this can be exercised without monkey-patching the read-only `vscode` module.
 *
 * Every disposable this creates — the provider registration, the configuration-change listener,
 * and the store-wiring subscription(s) — is pushed onto `subscriptions`.
 */
export function registerBookmarkDecorationProvider(
  stores: BookmarkStore[],
  subscriptions: vscode.Disposable[],
  deps: {
    getConfiguration: () => { get<T>(section: string, defaultValue: T): T };
    registerFileDecorationProvider: (provider: vscode.FileDecorationProvider) => vscode.Disposable;
    onDidChangeConfiguration: (
      listener: (event: vscode.ConfigurationChangeEvent) => void
    ) => vscode.Disposable;
  }
): BookmarkDecorationProvider {
  const provider = new BookmarkDecorationProvider(new Set());
  const wireSubscription = provider.wire(stores);
  provider.setEnabled(deps.getConfiguration().get<boolean>(EXPLORER_DECORATION_ENABLED_KEY, true));

  const registrationSubscription = deps.registerFileDecorationProvider(provider);

  const configChangeSubscription = deps.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(EXPLORER_DECORATION_ENABLED_KEY)) {
      return;
    }
    provider.setEnabled(deps.getConfiguration().get<boolean>(EXPLORER_DECORATION_ENABLED_KEY, true));
  });

  subscriptions.push(wireSubscription, registrationSubscription, configChangeSubscription);

  return provider;
}

/**
 * Registers the recently-opened-items tracker (#95, T4/T8): subscribes to
 * `window.tabGroups.onDidChangeTabs`, runs the pure tab adapter/list logic
 * (`extractTabUri`/`recordOpen`), and persists the result to `memento` under
 * `RECENT_STORAGE_KEY`. `deps` is injected — mirroring
 * `registerBookmarkDecorationProvider` above — so this can be exercised without monkey-patching
 * the read-only `vscode` module; `deps.getTabGroups` stands in for `vscode.window.tabGroups`.
 *
 * Only the `opened` array is consumed (D1/T4): the `TabChangeEvent` API docs describe `changed`
 * as covering things like a tab's `isActive` state flipping, not an existing tab's `input` being
 * replaced — VS Code reusing a single preview tab across successive Explorer single-clicks
 * surfaces as a close-then-open pair (a `closed` entry for the vacated preview plus an `opened`
 * entry for the newly selected file), so `opened` alone already sees every preview selection.
 *
 * The subscription disposable is pushed onto `subscriptions`, matching the
 * `context.subscriptions` disposal pattern used throughout `activate()`.
 */
export function registerRecentItemsTracker(
  memento: vscode.Memento,
  subscriptions: vscode.Disposable[],
  deps: {
    getTabGroups: () => Pick<vscode.TabGroups, 'onDidChangeTabs'>;
    maxItems: number;
    onDidChange?: () => void;
    now?: () => number;
  }
): void {
  const now = deps.now ?? Date.now;
  const subscription = deps.getTabGroups().onDidChangeTabs((event) => {
    let list = loadRecentItems(memento);
    let changed = false;

    for (const tab of event.opened) {
      const uri = extractTabUri(tab.input);
      if (!uri) {
        continue;
      }
      list = recordOpen(list, { uri: uri.toString(), isPreview: tab.isPreview }, deps.maxItems, now());
      changed = true;
    }

    if (changed) {
      void saveRecentItems(memento, list);
      deps.onDidChange?.();
    }
  });
  subscriptions.push(subscription);
}

/**
 * Registers the recently-*viewed* tracker (#108) — a SEPARATE, independent `onDidChangeTabs`
 * subscription from `registerRecentItemsTracker` above, backing the plain MRU "Recent" tree row
 * rather than the #95 suggestion-promotion pipeline. Deliberately its own tracker against its own
 * storage key (`recentlyViewed.ts`'s `RECENTLY_VIEWED_STORAGE_KEY`), for the same reason
 * `recentItems.ts` is independent of `BookmarkData` — a per-user browsing-history concern must not
 * be folded into another one. Mirrors `registerRecentItemsTracker`'s DI shape, minus anything
 * preview-count/threshold/`now`-related: this tracker has no preview concept (every open, preview
 * or not, moves the uri to front) and no configurable cap (`RECENTLY_VIEWED_MAX_ITEMS` is fixed and
 * enforced entirely inside `recordView`), so `deps` carries no `maxItems`/`now` fields at all.
 *
 * The subscription disposable is pushed onto `subscriptions`, matching the
 * `context.subscriptions` disposal pattern used throughout `activate()`.
 */
export function registerRecentlyViewedTracker(
  memento: vscode.Memento,
  subscriptions: vscode.Disposable[],
  deps: {
    getTabGroups: () => Pick<vscode.TabGroups, 'onDidChangeTabs'>;
    onDidChange?: () => void;
  }
): void {
  const subscription = deps.getTabGroups().onDidChangeTabs((event) => {
    let list = loadRecentlyViewed(memento);
    let changed = false;

    // CodeRabbit finding (PR #109 review, inline comment on this file): a "view" must be gated on
    // `tab.isActive`, and must be read from BOTH `event.opened` and `event.changed`. `event.opened`
    // alone over-records — a tab opened in the background (e.g. "Open All", a diff comparison base)
    // fires `opened` without ever being looked at — and under-records — VS Code reports switching
    // focus to an already-open tab via `event.changed`, not a new `opened` event, so that case was
    // silently dropped entirely pre-fix.
    for (const tab of [...event.opened, ...event.changed]) {
      if (!tab.isActive) {
        continue;
      }
      const uri = extractTabUri(tab.input);
      if (!uri) {
        continue;
      }
      list = recordView(list, uri.toString(), RECENTLY_VIEWED_MAX_ITEMS);
      changed = true;
    }

    if (changed) {
      void saveRecentlyViewed(memento, list);
      deps.onDidChange?.();
    }
  });
  subscriptions.push(subscription);
}

/**
 * Live-reloads `bookmarksPlus.suggestions.maxItems` (#102): mirrors
 * `registerBookmarkDecorationProvider` above by subscribing a single scoped
 * `onDidChangeConfiguration` listener, injected via `deps` so this can be exercised without
 * monkey-patching the read-only `vscode` module.
 *
 * Pre-#102, `activate()` only reads this setting once, at activation time, and hands the
 * normalized value to the recent-items tracker and the tree provider's `SuggestionsSource`. Both
 * of those consumers already re-read their backing value live on every use rather than
 * snapshotting it once (see the tracker's `deps.maxItems` and `SuggestionsSource.maxItems`
 * accesses), so this listener only needs to re-read and re-normalize the setting and push the
 * fresh value into both consumers via callbacks, then force a tree refresh — VS Code does not
 * re-query `getChildren` just because a backing value changed out from under it.
 *
 * The configuration-change listener disposable is pushed onto `subscriptions`, matching the
 * `context.subscriptions` disposal pattern used throughout `activate()`.
 */
export function registerSuggestionsMaxItemsLiveReload(
  subscriptions: vscode.Disposable[],
  deps: {
    getConfiguration: () => { get<T>(section: string, defaultValue: T): T };
    onDidChangeConfiguration: (
      listener: (event: vscode.ConfigurationChangeEvent) => void
    ) => vscode.Disposable;
    setTrackerMaxItems: (maxItems: number) => void;
    setSuggestionsMaxItems: (maxItems: number) => void;
    refresh: () => void;
  }
): void {
  const configChangeSubscription = deps.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(SUGGESTIONS_MAX_ITEMS_KEY)) {
      return;
    }

    const maxItems = normalizeMaxItems(
      deps.getConfiguration().get<number>(SUGGESTIONS_MAX_ITEMS_KEY, SUGGESTIONS_MAX_ITEMS_DEFAULT)
    );
    deps.setTrackerMaxItems(maxItems);
    deps.setSuggestionsMaxItems(maxItems);
    deps.refresh();
  });

  subscriptions.push(configChangeSubscription);
}

export function activate(
  context: vscode.ExtensionContext,
  mcpDeps: McpActivationDependencies = {
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
    registerProvider: (id, provider) =>
      vscode.lm.registerMcpServerDefinitionProvider(id, provider),
    onDidChangeWorkspaceFolders: (listener) =>
      vscode.workspace.onDidChangeWorkspaceFolders(listener)
  }
): void {
  const output = vscode.window.createOutputChannel('Bookmarks Plus');
  const location = resolveMirrorLocation(vscode.workspace.workspaceFolders);

  if (location.kind === 'disabled') {
    logMirrorDisabled(output, location.reason);
  }

  // Written early, ahead of command registration, so the variable is set even if a later
  // activation step throws (plan D-B). Only the initial write lives here; resyncing on
  // workspace-folder changes is wired separately (T5).
  applyWorkspaceEnv(context.environmentVariableCollection, vscode.workspace.workspaceFolders);

  const store = new BookmarkStore(context.workspaceState, output, {
    mirror: location.kind === 'enabled' ? new WorkspaceMirrorFile(location) : null
  });
  const globalStore = new BookmarkStore(context.globalState, output);
  const stores: ScopedStores = { workspace: store, global: globalStore };
  activeStores = [store, globalStore];

  let provider: BookmarksTreeDataProvider | undefined = undefined;
  const getGitApi = createGitApiFactory(
    () => vscode.extensions.getExtension<GitExtensionExports>('vscode.git'),
    () => provider?.refresh()
  );
  const cache = new FsGitCache(createCacheResolver(getGitApi));
  // Read once at activation, normalized (CodeRabbit: maxItems config normalization) so both
  // consumers below receive an already-clamped-and-floored value rather than a raw, possibly
  // negative/fractional setting. Held as a mutable field on each consumer's own DI object
  // (`suggestionsSource`/`recentItemsTrackerDeps`, both already re-read live on every use — see
  // `SuggestionsSource.maxItems` and `registerRecentItemsTracker`'s `deps.maxItems`) rather than a
  // captured local, so `registerSuggestionsMaxItemsLiveReload` (#102) can push a freshly configured
  // value into both without either consumer needing its own live-reload logic.
  const suggestionsMaxItems = normalizeMaxItems(
    vscode.workspace.getConfiguration().get<number>(SUGGESTIONS_MAX_ITEMS_KEY, SUGGESTIONS_MAX_ITEMS_DEFAULT)
  );
  const suggestionsSource: SuggestionsSource = {
    getRecentItems: () => loadRecentItems(context.workspaceState),
    maxItems: suggestionsMaxItems
  };
  const recentlyViewedSource: RecentlyViewedSource = {
    getUris: () => loadRecentlyViewed(context.workspaceState)
  };
  provider = new BookmarksTreeDataProvider(
    store,
    cache,
    globalStore,
    undefined,
    suggestionsSource,
    recentlyViewedSource,
    context.workspaceState
  );

  const treeView = vscode.window.createTreeView('bookmarksView', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true
  });
  context.subscriptions.push(
    output,
    treeView,
    { dispose: () => store.dispose() },
    { dispose: () => globalStore.dispose() }
  );

  const mcpProvider = registerBookmarksMcpProvider(context.subscriptions, {
    ...mcpDeps,
    extensionUri: context.extensionUri,
    extensionVersion: String(context.extension.packageJSON.version),
    output
  });
  // VS Code has no public API for tests to enumerate registered MCP definitions. Expose the
  // definition only inside the packaged test host, after the real registration path succeeds.
  if (process.env.BOOKMARKS_PACKAGED_MCP_TEST === '1' && mcpProvider) {
    context.subscriptions.push(
      vscode.commands.registerCommand(MCP_TEST_DEFINITIONS_COMMAND, async () => {
        const cancellation = new vscode.CancellationTokenSource();
        try {
          return await mcpProvider.provideMcpServerDefinitions(cancellation.token);
        } finally {
          cancellation.dispose();
        }
      })
    );
  }

  registerBookmarkDecorationProvider([store, globalStore], context.subscriptions, {
    getConfiguration: () => vscode.workspace.getConfiguration(),
    registerFileDecorationProvider: (decorationProvider) =>
      vscode.window.registerFileDecorationProvider(decorationProvider),
    onDidChangeConfiguration: (listener) => vscode.workspace.onDidChangeConfiguration(listener)
  });

  // #114: keeps BOOKMARKED_RESOURCE_CONTEXT_KEY current so the Explorer/editor context menus can
  // show "Remove Bookmark" instead of "Add Bookmark" for an already-bookmarked resource.
  // #120: also keeps the per-scope workspace/global context keys current, so "Add Bookmark" and
  // "Add Bookmark (Global)" visibility each depend only on that scope's own bookmark state, not
  // the merged union `wire()` publishes.
  const contextKeyManager = new BookmarkContextKeyManager({
    setContext: (key, value) => vscode.commands.executeCommand('setContext', key, value)
  });
  contextKeyManager.wire([store, globalStore]);
  contextKeyManager.wireScoped({ workspace: store, global: globalStore });

  const recentItemsTrackerDeps = {
    getTabGroups: () => vscode.window.tabGroups,
    maxItems: suggestionsMaxItems,
    onDidChange: () => provider?.refresh()
  };
  registerRecentItemsTracker(context.workspaceState, context.subscriptions, recentItemsTrackerDeps);
  registerRecentlyViewedTracker(context.workspaceState, context.subscriptions, {
    getTabGroups: () => vscode.window.tabGroups,
    onDidChange: () => provider?.refresh()
  });

  registerSuggestionsMaxItemsLiveReload(context.subscriptions, {
    getConfiguration: () => vscode.workspace.getConfiguration(),
    onDidChangeConfiguration: (listener) => vscode.workspace.onDidChangeConfiguration(listener),
    setTrackerMaxItems: (maxItems) => {
      recentItemsTrackerDeps.maxItems = maxItems;
    },
    setSuggestionsMaxItems: (maxItems) => {
      suggestionsSource.maxItems = maxItems;
    },
    refresh: () => provider?.refresh()
  });

  registerAddCommands(context, stores);
  registerAddToWorkspaceCommand(context, store);
  registerItemCommands(context, stores);
  registerCollectionCommands(context, stores);
  registerDescriptionCommands(context, stores);
  registerViewCommands(context, provider);

  let mirrorResources: vscode.Disposable | undefined;
  if (location.kind === 'enabled') {
    mirrorResources = createMirrorResources(location, () => {
      void store.reloadFromMirror();
    });

    void store.syncWithMirror().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Bookmarks Plus: mirror reconcile failed — ${message}`);
    });
  }

  const mirrorCoordinator = new WorkspaceMirrorChangeCoordinator(
    store,
    output,
    mirrorResources,
    () => provider?.refresh()
  );
  context.subscriptions.push(
    mirrorCoordinator,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void mirrorCoordinator.rebind(vscode.workspace.workspaceFolders).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Bookmarks Plus: mirror rebind failed — ${message}`);
      });

      // The terminal environment tracks the VS Code workspace immediately; mirror transitions
      // are serialized separately because they may need to flush an in-flight file write first.
      applyWorkspaceEnv(context.environmentVariableCollection, vscode.workspace.workspaceFolders);
    })
  );

  void getGitApi().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Git integration unavailable: ${message}`);
  });
}

export async function deactivate(): Promise<void> {
  // Flush rather than drop a pending mirror write. A failed write records the mirror as
  // dirty so workspaceState wins and the write is retried on the next activation.
  await disposeStores(activeStores);
  activeStores = [];
}
