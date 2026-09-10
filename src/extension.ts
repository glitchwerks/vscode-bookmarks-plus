import * as fs from 'fs';
import * as vscode from 'vscode';
import { BookmarkContentReader, BookmarkStore, OutputSink } from './bookmarkStore';
import { BookmarkDecorationProvider } from './bookmarkDecorationProvider';
import { BookmarkContextKeyManager } from './bookmarkContextKeys';
import {
  MIRROR_RELATIVE_PATH,
  WorkspaceMirrorFile
} from './bookmarkMirror';
import { BookmarksTreeDataProvider, RecentlyViewedSource, SuggestionsSource } from './bookmarksTreeDataProvider';
import {
  registerAddCommands,
  registerAddToWorkspaceCommand,
  registerCollectionCommands,
  registerDescriptionCommands,
  registerItemCommands,
  registerViewCommands,
  ScopedStores,
  createPrompter,
  registerRecoveryCommand
} from './commands';
import { CacheEntry, FsGitCache, ResolveFn } from './fsGitCache';
import {
  createGitApiFactory,
  findRepoNameForUri,
  GitApiFactory,
  GitExtensionExports
} from './gitInfo';
import { registerBookmarksMcpProvider } from './mcpServerProvider';
import { LiveMcpBridgeService, LiveMcpBridgeServiceOptions } from './liveMcpBridgeService';
import { extractTabUri, loadRecentItems, normalizeMaxItems, recordOpen, saveRecentItems } from './recentItems';
import {
  loadRecentlyViewed,
  RECENTLY_VIEWED_MAX_ITEMS,
  recordView,
  saveRecentlyViewed
} from './recentlyViewed';
import { applyWorkspaceEnv } from './workspaceEnv';
import { WorkspaceBookmarkStore } from './workspaceBookmarkStore';
import { PartitionMirrorResources, WorkspaceMirrorCoordinator } from './workspaceMirrorCoordinator';
import { RootCandidate, toRootCandidates } from './rootUri';

const EXPLORER_DECORATION_ENABLED_KEY = 'bookmarksPlus.explorerDecoration.enabled';
const SUGGESTIONS_MAX_ITEMS_KEY = 'bookmarksPlus.suggestions.maxItems';
const SUGGESTIONS_MAX_ITEMS_DEFAULT = 10;
const MCP_TEST_DEFINITIONS_COMMAND = 'bookmarks.test.getMcpServerDefinitions';
const MCP_TEST_RESOLVE_COMMAND = 'bookmarks.test.resolveMcpServerDefinition';
const MCP_TEST_STATE_COMMAND = 'bookmarks.test.getScopedBookmarkState';

let activeRuntime: {
  store: WorkspaceBookmarkStore; globalStore: BookmarkStore; mirrors: WorkspaceMirrorCoordinator;
  bridge?: LiveMcpBridgeService;
  output: OutputSink; pending: Promise<void>; stopping: boolean;
} | undefined;

export interface McpActivationDependencies {
  getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  registerProvider: (
    id: string,
    provider: vscode.McpServerDefinitionProvider
  ) => vscode.Disposable;
  onDidChangeWorkspaceFolders: (listener: () => void | Promise<void>) => vscode.Disposable;
  createOutputChannel?: () => vscode.OutputChannel;
  createMirrorResources?: (root: vscode.Uri) => PartitionMirrorResources;
  registerCommands?: typeof registerCommands;
  isWorkspaceTrusted?: () => boolean;
  startLiveBridge?: (options: LiveMcpBridgeServiceOptions) => Promise<LiveMcpBridgeService>;
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
  stores: BookmarkContentReader[],
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

export async function activate(
  context: vscode.ExtensionContext,
  mcpDeps: McpActivationDependencies = {
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
    registerProvider: (id, provider) =>
      vscode.lm.registerMcpServerDefinitionProvider(id, provider),
    onDidChangeWorkspaceFolders: (listener) =>
      vscode.workspace.onDidChangeWorkspaceFolders(listener)
  }
): Promise<void> {
  const output = mcpDeps.createOutputChannel?.() ?? vscode.window.createOutputChannel('Bookmarks Plus');
  const folders = mcpDeps.getWorkspaceFolders();
  applyWorkspaceEnv(context.environmentVariableCollection, folders);
  const bufferedRoots: (readonly RootCandidate[])[] = [];
  let initializing = true;
  // Migration and initial mirror I/O may yield while VS Code changes non-first folders.
  // Keep every topology snapshot until initialization can serialize it through the coordinator.
  context.subscriptions.push(mcpDeps.onDidChangeWorkspaceFolders(() => {
    const currentFolders = mcpDeps.getWorkspaceFolders();
    applyWorkspaceEnv(context.environmentVariableCollection, currentFolders);
    const roots = toRootCandidates(currentFolders);
    if (initializing) {
      bufferedRoots.push(roots);
      return;
    }
    return reconcileFolders(roots);
  }));
  const store = await WorkspaceBookmarkStore.create({
    state: context.workspaceState, output, roots: toRootCandidates(folders)
  });
  const globalStore = new BookmarkStore(context.globalState, output);
  const stores: ScopedStores<WorkspaceBookmarkStore> = { workspace: store, global: globalStore };
  const mirrorCoordinator = new WorkspaceMirrorCoordinator({
    store, output, createResources: mcpDeps.createMirrorResources ?? createPartitionMirrorResources
  });
  const runtime: NonNullable<typeof activeRuntime> = {
    store, globalStore, mirrors: mirrorCoordinator, output, pending: Promise.resolve(), stopping: false
  };
  activeRuntime = runtime;
  if (store.getView().kind === 'ready') {
    await store.reconcileRoots(toRootCandidates(folders));
    await mirrorCoordinator.reconcileBindings();
  }
  const reconcileFolders = (roots: readonly RootCandidate[]): Promise<void> => {
    if (runtime.stopping) return Promise.resolve();
    runtime.pending = mirrorCoordinator.handleRootsChanged(roots).then(() => undefined,
      () => { output.appendLine('Bookmarks Plus: workspace folder reconciliation failed.'); });
    return runtime.pending;
  };
  while (bufferedRoots.length > 0) {
    await reconcileFolders(bufferedRoots.shift()!);
  }
  // No await between draining the buffer and switching to the live listener.
  initializing = false;

  const getAvailableRoots = () => {
    const view = store.getView();
    const unavailable = new Set(view.unavailableRoots);
    return view.attached.filter(root => !unavailable.has(root.canonicalRootUri));
  };
  const getAttachedRoot: LiveMcpBridgeServiceOptions['getAttachedRoot'] = canonicalRootUri => {
    const root = getAvailableRoots().find(value => value.canonicalRootUri === canonicalRootUri);
    return root ? { rootUri: root.rootUri, canonicalRootUri: root.canonicalRootUri,
      owner: { kind: 'partition', partitionId: root.partitionId } } : undefined;
  };
  const trusted = (mcpDeps.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted))();
  if (trusted) {
    try {
      runtime.bridge = await (mcpDeps.startLiveBridge ?? LiveMcpBridgeService.start)({
        workspaceStore: store, globalStore, output, getAttachedRoot,
        editorSessionId: vscode.env.sessionId, extensionId: context.extension.id
      });
      context.subscriptions.push(store.onDidChangePartitions(() => runtime.bridge?.refreshAvailableRoots()));
    } catch {
      output.appendLine('Bookmarks Plus: live MCP bridge startup failed.');
    }
  }

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
  // Store and mirror disposal belongs to async deactivate, after bridge requests drain.
  context.subscriptions.push(
    output,
    treeView
  );

  const mcpProvider = trusted ? registerBookmarksMcpProvider(context.subscriptions, {
    ...mcpDeps,
    getAttachedRoots: () => getAvailableRoots().map(root => ({ uri: vscode.Uri.parse(root.rootUri), name: root.label })),
    isBridgeReady: () => !runtime.stopping && runtime.bridge !== undefined,
    issueGrant: (rootUri, scopes) => {
      if (runtime.stopping || !runtime.bridge) throw new Error('bridge-unavailable');
      return runtime.bridge.issueGrant(rootUri, scopes);
    },
    onDidChangePartitions: listener => store.onDidChangePartitions(listener),
    extensionUri: context.extensionUri,
    extensionVersion: String(context.extension.packageJSON.version),
    output
  }) : undefined;
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
      }),
      vscode.commands.registerCommand(MCP_TEST_RESOLVE_COMMAND, async (rootUri: string) => {
        const cancellation = new vscode.CancellationTokenSource();
        try {
          const definitions = await mcpProvider.provideMcpServerDefinitions(cancellation.token);
          const definition = definitions?.find(value => value.env.BOOKMARKS_PLUS_ROOT_URI === rootUri);
          return definition ? await mcpProvider.resolveMcpServerDefinition!(definition, cancellation.token) : undefined;
        } finally {
          cancellation.dispose();
        }
      }),
      vscode.commands.registerCommand(MCP_TEST_STATE_COMMAND, (rootUri: string) => {
        const root = getAttachedRoot(rootUri);
        return root ? { workspace: store.getOwnerData(root.owner), global: globalStore.getAll() } : undefined;
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

  context.subscriptions.push(
    store.onDidChangePartitions(() => provider?.refresh())
  );
  (mcpDeps.registerCommands ?? registerCommands)(context, stores, provider, mirrorCoordinator, output);

  void getGitApi().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Git integration unavailable: ${message}`);
  });
}

/** Registers UI commands with explicit workspace and Global owners. */
function registerCommands(
  context: vscode.ExtensionContext, stores: ScopedStores<WorkspaceBookmarkStore>,
  provider: BookmarksTreeDataProvider, mirrors: WorkspaceMirrorCoordinator, output: vscode.OutputChannel
): void {
  context.subscriptions.push(vscode.commands.registerCommand('bookmarks.showOutput', () => output.show()));
  registerAddCommands(context, stores);
  registerAddToWorkspaceCommand(context, () => mirrors.flushAll());
  registerItemCommands(context, stores);
  registerCollectionCommands(context, stores);
  registerDescriptionCommands(context, stores);
  registerViewCommands(context, provider);
  registerRecoveryCommand(context, {
    store: stores.workspace, prompter: createPrompter(),
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
    fs: { stat: uri => vscode.workspace.fs.stat(uri) }
  });
}

/** Opens the independent filesystem port and watcher for one attached root. */
function createPartitionMirrorResources(root: vscode.Uri): PartitionMirrorResources {
  const directory = vscode.Uri.joinPath(root, '.vscode');
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, MIRROR_RELATIVE_PATH));
  return {
    port: new WorkspaceMirrorFile({ directory, file: vscode.Uri.joinPath(directory, 'bookmarks.json') }),
    onDidChange: listener => watcher.onDidChange(() => listener()),
    onDidCreate: listener => watcher.onDidCreate(() => listener()),
    onDidDelete: listener => watcher.onDidDelete(() => listener()),
    dispose: () => watcher.dispose()
  };
}

/** Stops live access, drains admitted store work, then flushes and disposes owned resources. */
export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  if (!runtime) return;
  runtime.stopping = true;
  await runtime.pending;
  await runtime.bridge?.stop();
  try { await runtime.mirrors.drainAndFlush(); }
  catch { runtime.output.appendLine('Bookmarks Plus: workspace mirror flush failed.'); }
  for (const resource of [runtime.mirrors, runtime.store, runtime.globalStore]) {
    try { resource.dispose(); }
    catch { runtime.output.appendLine('Bookmarks Plus: workspace resource disposal failed.'); }
  }
}
