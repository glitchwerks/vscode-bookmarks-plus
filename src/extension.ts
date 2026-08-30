import * as fs from 'fs';
import * as vscode from 'vscode';
import { BookmarkStore, OutputSink } from './bookmarkStore';
import { BookmarkDecorationProvider } from './bookmarkDecorationProvider';
import {
  MIRROR_RELATIVE_PATH,
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

let activeStores: BookmarkStore[] = [];

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

export function handleWorkspaceFoldersChanged(
  store: BookmarkStore,
  output: OutputSink,
  folders: readonly { uri: vscode.Uri }[] | undefined,
  mirrorResources?: vscode.Disposable,
  refresh?: () => void
): boolean {
  const location = resolveMirrorLocation(folders);
  if (location.kind === 'enabled') {
    refresh?.();
    return false;
  }

  logMirrorDisabled(output, location.reason);
  store.detachMirror();
  mirrorResources?.dispose();
  refresh?.();
  return true;
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

export function activate(context: vscode.ExtensionContext): void {
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
    mirror: location.kind === 'enabled' ? new WorkspaceMirrorFile(location) : undefined
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
    recentlyViewedSource
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

  registerBookmarkDecorationProvider([store, globalStore], context.subscriptions, {
    getConfiguration: () => vscode.workspace.getConfiguration(),
    registerFileDecorationProvider: (decorationProvider) =>
      vscode.window.registerFileDecorationProvider(decorationProvider),
    onDidChangeConfiguration: (listener) => vscode.workspace.onDidChangeConfiguration(listener)
  });

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
    // One path, never the workspace at large. The .tmp staging file used for atomic
    // writes deliberately does not match this pattern.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(location.folder, MIRROR_RELATIVE_PATH)
    );
    // A single logical save fires several raw filesystem events, so coalesce before reloading.
    const reloadDelayer = new Delayer(WATCHER_DEBOUNCE_MS);
    const onMirrorEvent = (): void => {
      reloadDelayer.trigger(() => store.reloadFromMirror());
    };
    watcher.onDidChange(onMirrorEvent, undefined, context.subscriptions);
    watcher.onDidCreate(onMirrorEvent, undefined, context.subscriptions);
    watcher.onDidDelete(onMirrorEvent, undefined, context.subscriptions);
    context.subscriptions.push(watcher, reloadDelayer);
    mirrorResources = vscode.Disposable.from(watcher, reloadDelayer);

    void store.syncWithMirror().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Bookmarks Plus: mirror reconcile failed — ${message}`);
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const disabled = handleWorkspaceFoldersChanged(
        store,
        output,
        vscode.workspace.workspaceFolders,
        mirrorResources,
        () => provider?.refresh()
      );
      if (disabled) {
        mirrorResources = undefined;
      }

      // Runs unconditionally, as a sibling to handleWorkspaceFoldersChanged rather than nested
      // inside it (plan D-A). handleWorkspaceFoldersChanged early-returns on an enabled→enabled
      // transition, but a single-root → single-root folder swap is exactly that transition and
      // still needs the env var resynced to the new folder's path.
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
