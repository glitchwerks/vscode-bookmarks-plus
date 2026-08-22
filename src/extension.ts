import * as fs from 'fs';
import * as vscode from 'vscode';
import { BookmarkStore, OutputSink } from './bookmarkStore';
import {
  MIRROR_RELATIVE_PATH,
  WorkspaceMirrorFile,
  resolveMirrorLocation
} from './bookmarkMirror';
import { BookmarksTreeDataProvider } from './bookmarksTreeDataProvider';
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

const WATCHER_DEBOUNCE_MS = 150;

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

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Bookmarks Plus');
  const location = resolveMirrorLocation(vscode.workspace.workspaceFolders);

  if (location.kind === 'disabled') {
    logMirrorDisabled(output, location.reason);
  }

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
  provider = new BookmarksTreeDataProvider(store, cache, globalStore);

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
