import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RecoveryConflictError, StaleRecoveryPreviewError, WorkspaceBookmarkStore } from '../../workspaceBookmarkStore';
import { WorkspaceOwnerRef, WorkspacePartitionSnapshot, WORKSPACE_PARTITION_STORAGE_KEY } from '../../workspacePartitionTypes';
import { toRootCandidates } from '../../rootUri';
import { BookmarkStore } from '../../bookmarkStore';
import { BookmarkNode, BookmarksTreeDataProvider } from '../../bookmarksTreeDataProvider';
import { FsGitCache } from '../../fsGitCache';
import { BookmarkCollection, BookmarkItem } from '../../types';
import { isInsideWorkspace } from '../../workspaceFolders';
import {
  ADD_TO_WORKSPACE_LABEL,
  AddToWorkspaceDeps,
  createAddFileHandler,
  createAddFolderHandler,
  createAddToWorkspaceHandler,
  createPromoteRecentItemHandler,
  createPromoteSuggestionHandler,
  createRemoveHandler,
  createRevealHandler,
  OPEN_IN_NEW_WINDOW_LABEL,
  Prompter,
  RevealDeps,
  ScopedStores,
  createNewCollectionHandler,
  createRenameCollectionHandler,
  createDeleteCollectionHandler,
  createMoveToCollectionHandler,
  createSetDescriptionHandler,
  registerViewCommands,
  registerAddCommands
} from '../../commands';
import { createRecoverPartitionHandler, registerRecoveryCommand, REATTACH_ONLY_LABEL, REATTACH_AND_SALVAGE_LABEL, RECOVER_CONFIRM_LABEL } from '../../commands';
import { FakeMemento, FakePrompter, FakeOutput } from './fixtures';

/** Real stores expose writes to the wrong owner without relying on permissive spies. */
async function partitionCommandFixture(rootUris = ['file:///a', 'file:///b']) {
  const state = new FakeMemento();
  const roots = rootUris.map((uri, index) => ({ id: String(index), label: `Root ${index}`, uri: vscode.Uri.parse(uri) }));
  const workspace = await WorkspaceBookmarkStore.create({ state, roots, output: new FakeOutput() });
  const global = new BookmarkStore(new FakeMemento());
  const owners = workspace.getView().attached.map(({ partitionId }) => ({ kind: 'partition' as const, partitionId }));
  return { workspace, global, state, roots, owners, stores: { workspace, global } };
}

function ownedItem(owner: WorkspaceOwnerRef, item: BookmarkItem): BookmarkNode {
  return { kind: 'item', scope: 'workspace', owner, item };
}

function ownedCollection(owner: WorkspaceOwnerRef, collection: BookmarkCollection): BookmarkNode {
  return { kind: 'collection', scope: 'workspace', owner, collection };
}

function partitionNode(partitionId: string, kind: 'workspaceRoot' | 'detachedPartition' = 'workspaceRoot'): BookmarkNode {
  return { kind, partitionId, label: 'Root', scope: 'workspace', collection: { id: '', name: '', order: 0 } };
}

/** A detached snapshot includes resolving, missing and incompatible salvage inputs. */
async function recoveryFixture(options: { mode?: string; confirmed?: boolean; cancelPick?: number; twoDetached?: boolean } = {}) {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const snapshot: WorkspacePartitionSnapshot = {
    version: 1, unassigned: { version: 2, items: [], collections: [] },
    partitions: [{ id: id(1), attachment: null, lastKnownRootUri: 'file:///old', canonicalLastKnownRootUri: 'file:///old',
      replacementEligible: false, mirror: { dirty: false }, data: { version: 2, collections: [],
        items: ['file:///old/ok', 'file:///old/missing1', 'file:///old/missing2', 'file:///outside'].map((uri, i) =>
          ({ id: id(i + 2), type: 'file' as const, uri, collectionId: null, order: i })) } }]
  };
  if (options.twoDetached) snapshot.partitions.push({ ...snapshot.partitions[0], id: id(9), lastKnownRootUri: 'file:///other',
    canonicalLastKnownRootUri: 'file:///other', data: { version: 2, items: [], collections: [] } });
  const state = new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot });
  const roots = toRootCandidates([{ name: 'New root', index: 0, uri: vscode.Uri.parse('file:///new') }]);
  const store = await WorkspaceBookmarkStore.create({ state, roots, output: new FakeOutput() });
  await store.reconcileRoots(roots);
  let folders: readonly vscode.WorkspaceFolder[] = roots.map((r, index) => ({ uri: r.uri, name: r.label, index }));
  const messages: string[] = [];
  const warnings: string[] = [];
  const picks: vscode.QuickPickItem[][] = [];
  const before = state.updateCallCount;
  const prompter = makePrompter({
    showInfo: async message => { messages.push(message); },
    showQuickPick: async items => {
      picks.push(items);
      if (options.cancelPick === picks.length) return undefined;
      return items.find(i => i.label === (options.mode ?? 'Reattach and salvage')) ?? items[0];
    },
    showWarningConfirm: async (message, label) => {
      warnings.push(message);
      assert.strictEqual(label, 'Recover');
      assert.strictEqual(state.updateCallCount, before, 'preview must not persist');
      return options.confirmed ?? true;
    }
  });
  return { store, state, before, messages, warnings, picks, roots, prompter,
    node: partitionNode(id(1), 'detachedPartition'),
    setFolders: (next: readonly vscode.WorkspaceFolder[]) => { folders = next; },
    deps: { store, prompter, getWorkspaceFolders: () => folders, fs: { stat: async (uri: vscode.Uri) => {
      if (uri.toString() !== 'file:///new/ok') throw vscode.FileSystemError.FileNotFound();
      return { type: vscode.FileType.File, size: 0, ctime: 0, mtime: 0 };
    } } } };
}

suite('commands - partition recovery (#62)', () => {
  for (const mode of ['Reattach only', 'Reattach and salvage']) {
    test(`${mode} commits exactly once after existing roots reorder during confirmation`, async () => {
      const f = await recoveryFixture({ mode });
      const folders = [
        { name: 'New root', index: 0, uri: vscode.Uri.parse('file:///new') },
        { name: 'Other', index: 1, uri: vscode.Uri.parse('file:///other') }
      ];
      f.setFolders(folders);
      await f.store.reconcileRoots(toRootCandidates(folders));
      const beforeWrites = f.state.updateCallCount;
      let confirmations = 0;
      let events = 0;
      const subscription = f.store.onBookmarksChanged(() => { events++; });
      f.prompter.showWarningConfirm = async () => {
        confirmations++;
        const reordered = [folders[1], folders[0]];
        f.setFolders(reordered);
        await f.store.reconcileRoots(toRootCandidates(reordered));
        assert.strictEqual(f.state.updateCallCount, beforeWrites, 'reordering must not change the snapshot revision');
        return true;
      };
      try {
        await createRecoverPartitionHandler(f.deps)(f.node);
        assert.strictEqual(f.store.getView().detached.length, 0, 'the confirmed partition must reattach after index-only ID changes');
        assert.strictEqual(f.state.updateCallCount, beforeWrites + 1);
        assert.strictEqual(events, 1);
        assert.strictEqual(confirmations, 1);
        assert.strictEqual(f.store.getAll().items[0].uri, mode === 'Reattach only' ? 'file:///old/ok' : 'file:///new/ok');
      } finally { subscription.dispose(); }
    });
  }
  test('registered recovery command uses the selected partition and injected recovery dependencies', async () => {
    await withIsolatedCommandRegistry(async () => {
      const f = await recoveryFixture();
      const subscriptions: vscode.Disposable[] = [];
      registerRecoveryCommand({ subscriptions } as unknown as vscode.ExtensionContext, f.deps);
      try {
        await vscode.commands.executeCommand('bookmarks.recoverPartition', f.node);
        assert.strictEqual(f.store.getView().detached.length, 0);
        assert.strictEqual(f.state.updateCallCount, f.before + 1);
      } finally { subscriptions.forEach(subscription => subscription.dispose()); }
    });
  });
  test('folder reorder during mode selection uses current candidate IDs for the same destination', async () => {
    const f = await recoveryFixture();
    const getPick = f.prompter.showQuickPick;
    f.prompter.showQuickPick = async (items, options) => {
      const pick = await getPick(items, options);
      if (items[0].label === 'Reattach only') {
        const folders = [ { name: 'Other', index: 0, uri: vscode.Uri.parse('file:///another') },
          { name: 'New root', index: 1, uri: vscode.Uri.parse('file:///new') } ];
        f.setFolders(folders);
        await f.store.reconcileRoots(toRootCandidates(folders));
      }
      return pick;
    };
    f.prompter.showWarningConfirm = async () => true;
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.strictEqual(f.store.getView().detached.length, 0);
    assert.strictEqual(f.store.getAll().items[0].uri, 'file:///new/ok');
  });
  test('destination disappearance during confirmation cancels the commit', async () => {
    const f = await recoveryFixture();
    f.prompter.showWarningConfirm = async () => { f.setFolders([]); return true; };
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.strictEqual(f.state.updateCallCount, f.before);
    assert.match(f.messages.at(-1)!, /not a current workspace root/);
  });
  for (const stage of [1, 2]) {
    test(`context recovery cancellation at destination/mode stage ${stage} preserves the snapshot`, async () => {
      const f = await recoveryFixture({ cancelPick: stage });
      await createRecoverPartitionHandler(f.deps)(f.node);
      assert.strictEqual(f.state.updateCallCount, f.before);
      assert.strictEqual(f.warnings.length, 0);
    });
  }
  test('salvage previews exact counts and commits all rewrites after modal confirmation', async () => {
    const f = await recoveryFixture();
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.match(f.messages[0], /file:\/\/\/old.*4 bookmarks/);
    assert.match(f.warnings[0], /1 recovered, 2 still missing, 1 incompatible/);
    assert.strictEqual(f.state.updateCallCount, f.before + 1);
    assert.deepStrictEqual(f.store.getAll().items.map(i => i.uri), ['file:///new/ok', 'file:///old/missing1', 'file:///old/missing2', 'file:///outside']);
    assert.strictEqual(f.store.getView().detached.length, 0);
    assert.strictEqual(f.store.getView().attached[0].partitionId, f.node.kind === 'detachedPartition' ? f.node.partitionId : '');
  });
  test('reattach only preserves every URI and explains that choice before confirmation', async () => {
    const f = await recoveryFixture({ mode: 'Reattach only' });
    const before = f.store.getAll();
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.deepStrictEqual(f.store.getAll(), before);
    assert.match(f.warnings[0], /unchanged/);
    assert.strictEqual(f.state.updateCallCount, f.before + 1);
  });
  for (const cancelPick of [1, 2, 3]) {
    test(`palette cancellation at selection ${cancelPick} never mutates`, async () => {
      const f = await recoveryFixture({ twoDetached: true, cancelPick });
      await createRecoverPartitionHandler(f.deps)();
      assert.strictEqual(f.state.updateCallCount, f.before);
      assert.strictEqual(f.warnings.length, 0);
    });
  }
  test('declining confirmation leaves attachment and content unchanged', async () => {
    const f = await recoveryFixture({ confirmed: false });
    const before = f.store.getView();
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.deepStrictEqual(f.store.getView(), before);
    assert.strictEqual(f.state.updateCallCount, f.before);
  });
  test('palette selects among detached partitions and displays identifying URI and counts', async () => {
    const f = await recoveryFixture({ twoDetached: true });
    await createRecoverPartitionHandler(f.deps)();
    assert.strictEqual(f.picks[0].length, 2);
    assert.match(JSON.stringify(f.picks[0]), /file:\/\/\/old/);
    assert.strictEqual(f.store.getView().detached.length, 1);
  });
  test('palette uses its only detached partition directly', async () => {
    const f = await recoveryFixture();
    await createRecoverPartitionHandler(f.deps)();
    assert.strictEqual(f.picks.length, 2);
  });
  test('no detached partition or no destination is an informative no-op', async () => {
    const f = await recoveryFixture();
    f.setFolders([]);
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.strictEqual(f.state.updateCallCount, f.before);
    assert.ok(f.messages.length > 0);
    const ready = await partitionCommandFixture();
    const prompt = new FakePrompter();
    await createRecoverPartitionHandler({ ...f.deps, store: ready.workspace, prompter: prompt })();
    assert.ok(prompt.lastInfoMessage);
  });
  test('wrong context and stale detached selection do not start recovery', async () => {
    const f = await recoveryFixture();
    await createRecoverPartitionHandler(f.deps)({ kind: 'globalRoot' });
    await createRecoverPartitionHandler(f.deps)(partitionNode('gone', 'detachedPartition'));
    assert.strictEqual(f.state.updateCallCount, f.before);
    assert.strictEqual(f.picks.length, 0);
  });
  test('established destination conflicts are redacted and never confirmed', async () => {
    const f = await recoveryFixture();
    const owner = f.store.resolveAttachedOwner(vscode.Uri.parse('file:///new/x'))!;
    await f.store.addCollection(owner, 'private name');
    const before = f.state.updateCallCount;
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.strictEqual(f.state.updateCallCount, before);
    assert.match(f.messages.at(-1)!, /established partition/);
    assert.ok(!f.messages.at(-1)!.includes('private name'));
    assert.strictEqual(f.warnings.length, 0);
  });
  for (const stage of ['preview', 'commit'] as const) {
    for (const error of [new Error('unexpected'), new StaleRecoveryPreviewError('stale')]) {
      test(`${stage} propagates ${error.name} to the extension boundary`, async () => {
        const f = await recoveryFixture();
        if (stage === 'preview') f.store.previewRecovery = async () => { throw error; };
        else f.store.commitRecovery = async () => { throw error; };
        await assert.rejects(createRecoverPartitionHandler(f.deps)(f.node), e => e === error);
        assert.strictEqual(f.state.updateCallCount, f.before);
      });
    }
  }
  test('commit eligibility conflict is shown without exposing unrelated error details', async () => {
    const f = await recoveryFixture();
    f.store.commitRecovery = async () => { throw new RecoveryConflictError('Recovery destination eligibility changed.'); };
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.strictEqual(f.messages.at(-1), 'Recovery destination eligibility changed.');
    assert.strictEqual(f.state.updateCallCount, f.before);
  });
  test('a destination removed during prompts cannot be recovered', async () => {
    const f = await recoveryFixture();
    const pick = f.prompter.showQuickPick;
    f.prompter.showQuickPick = async (items, options) => { const result = await pick(items, options); f.setFolders([]); return result; };
    await createRecoverPartitionHandler(f.deps)(f.node);
    assert.strictEqual(f.state.updateCallCount, f.before);
    assert.strictEqual(f.warnings.length, 0);
  });
});

suite('commands - partition menu contributions (#62)', () => {
  test('recovery and collection creation expose only their intended root contexts and remain in the palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const menus = manifest.contributes.menus;
    assert.ok(manifest.contributes.commands.some((c: { command: string }) => c.command === 'bookmarks.recoverPartition'));
    for (const [command, context] of [['bookmarks.recoverPartition', 'bookmarkDetachedPartition'], ['bookmarks.newCollection', 'bookmarkWorkspaceRoot']]) {
      assert.deepStrictEqual(menus['view/item/context'].filter((m: { command: string }) => m.command === command).map((m: { when: string }) => m.when),
        [`view == bookmarksView && viewItem == ${context}`]);
      assert.ok(!menus.commandPalette.some((m: { command: string; when: string }) => m.command === command && m.when === 'false'));
    }
    assert.strictEqual(REATTACH_ONLY_LABEL, 'Reattach only');
    assert.strictEqual(REATTACH_AND_SALVAGE_LABEL, 'Reattach and salvage');
    assert.strictEqual(RECOVER_CONFIRM_LABEL, 'Recover');
  });
});

suite('commands - partition owner routing (#62)', () => {
  test('Unassigned content remains editable and removable without creating new content', async () => {
    const f = await recoveryFixture();
    const snapshot = f.state.get<WorkspacePartitionSnapshot>(WORKSPACE_PARTITION_STORAGE_KEY)!;
    const preserved = snapshot.partitions[0].data;
    snapshot.unassigned = preserved;
    snapshot.partitions[0].data = { version: 2, items: [], collections: [] };
    const collection: BookmarkCollection = { id: '00000000-0000-4000-8000-000000000099', name: 'Preserved', order: 0 };
    snapshot.unassigned.collections.push(collection);
    const workspace = await WorkspaceBookmarkStore.create({ state: new FakeMemento({ [WORKSPACE_PARTITION_STORAGE_KEY]: snapshot }), roots: f.roots, output: new FakeOutput() });
    const stores = { workspace, global: new BookmarkStore(new FakeMemento()) };
    const owner: WorkspaceOwnerRef = { kind: 'unassigned' };
    const item = preserved.items[0];
    const prompt = new FakePrompter({ inputBoxResult: 'Edited', warningConfirmResult: true, quickPickResult: { label: 'Preserved', id: collection.id, owner } });
    await createNewCollectionHandler(workspace, prompt)(ownedCollection(owner, collection));
    assert.strictEqual(workspace.getView().unassigned.collections.length, 1);
    await createRenameCollectionHandler(stores, prompt)(ownedCollection(owner, collection));
    await createSetDescriptionHandler(stores, prompt)(ownedCollection(owner, collection));
    await createSetDescriptionHandler(stores, prompt)(ownedItem(owner, item));
    await createMoveToCollectionHandler(stores, prompt)(ownedItem(owner, item));
    assert.strictEqual(workspace.getView().unassigned.items[0].collectionId, collection.id);
    assert.strictEqual(workspace.getView().unassigned.items[0].description, 'Edited');
    assert.strictEqual(workspace.getView().unassigned.collections[0].name, 'Edited');
    assert.strictEqual(workspace.getView().unassigned.collections[0].description, 'Edited');
    await createDeleteCollectionHandler(stores, prompt)(ownedCollection(owner, collection));
    await createRemoveHandler(stores)(ownedItem(owner, item));
    assert.strictEqual(workspace.getView().unassigned.items.length, 3);
    assert.strictEqual(workspace.getView().unassigned.collections.length, 0);
  });
  test('canceling each workspace content prompt never writes', async () => {
    const f = await partitionCommandFixture();
    const item = await f.workspace.addItem(f.owners[0], { type: 'file', uri: 'file:///a/x' });
    const collection = await f.workspace.addCollection(f.owners[0], 'Saved');
    const before = f.state.updateCallCount;
    const prompt = new FakePrompter();
    await createRenameCollectionHandler(f.stores, prompt)(ownedCollection(f.owners[0], collection));
    await createSetDescriptionHandler(f.stores, prompt)(ownedCollection(f.owners[0], collection));
    await createSetDescriptionHandler(f.stores, prompt)(ownedItem(f.owners[0], item));
    await createDeleteCollectionHandler(f.stores, prompt)(ownedCollection(f.owners[0], collection));
    await createMoveToCollectionHandler(f.stores, prompt)(ownedItem(f.owners[0], item));
    assert.strictEqual(f.state.updateCallCount, before);
  });
  test('multiple URI copies within one owner remove the first deterministically without a prompt', async () => {
    const f = await partitionCommandFixture();
    const owner = f.owners[0];
    const collection = await f.workspace.addCollection(owner, 'Group');
    const uri = vscode.Uri.parse('file:///a/x');
    const first = await f.workspace.addItem(owner, { type: 'file', uri: uri.toString() });
    const second = await f.workspace.addItem(owner, { type: 'file', uri: uri.toString(), collectionId: collection.id });
    const prompt = makePrompter({ showQuickPick: async () => { assert.fail('Only one owner exists'); } });
    await createRemoveHandler(f.stores, prompt)(uri);
    assert.deepStrictEqual(f.workspace.getAll().items.map(i => i.id), [second.id]);
    assert.notStrictEqual(first.id, second.id);
  });
  for (const kind of ['suggestion', 'recentItem'] as const) {
    for (const inside of [true, false]) {
      test(`${kind} promotion ${inside ? 'uses deepest owner' : 'rejects an outside URI'}`, async () => {
        const f = await partitionCommandFixture(['file:///a', 'file:///a/nested']);
        const uri = inside ? 'file:///a/nested/new' : 'file:///outside';
        const node: BookmarkNode = kind === 'suggestion'
          ? { kind, recentItem: { uri, firstSeen: 0, previewCount: 0, promoted: true } } : { kind, uri };
        const prompt = new FakePrompter();
        const factory = kind === 'suggestion' ? createPromoteSuggestionHandler : createPromoteRecentItemHandler;
        await factory(f.workspace, prompt)(node);
        assert.strictEqual(f.workspace.getOwnerData(f.owners[0])!.items.length, 0);
        assert.strictEqual(f.workspace.getOwnerData(f.owners[1])!.items.length, inside ? 1 : 0);
        if (!inside) assert.ok(prompt.lastInfoMessage);
        if (inside) {
          await factory(f.workspace, prompt)(node);
          assert.strictEqual(f.workspace.getAll().items.length, 1);
          assert.match(prompt.lastInfoMessage!, /already bookmarked/);
        }
      });
    }
  }

  test('cross-owner command moves are rejected with no write', async () => {
    const f = await partitionCommandFixture();
    const collection = await f.workspace.addCollection(f.owners[1], 'Elsewhere');
    const item = await f.workspace.addItem(f.owners[0], { type: 'file', uri: 'file:///a/x' });
    const prompt = new FakePrompter({ quickPickResult: { label: 'Elsewhere', id: collection.id, owner: f.owners[1] } });
    const before = f.state.updateCallCount;
    await createMoveToCollectionHandler(f.stores, prompt)(ownedItem(f.owners[0], item));
    assert.strictEqual(f.state.updateCallCount, before);
    assert.strictEqual(prompt.lastInfoMessage, 'Bookmarks cannot be moved between workspace roots.');
  });

  for (const context of ['root', 'collection', 'single'] as const) {
    test(`new collection uses ${context} ownership without a root prompt`, async () => {
      const f = await partitionCommandFixture(context === 'single' ? ['file:///a'] : undefined);
      const owner = f.owners.at(-1)!;
      const contextNode = context === 'root' ? partitionNode(owner.partitionId)
        : context === 'collection' ? ownedCollection(owner, await f.workspace.addCollection(owner, 'Existing')) : undefined;
      let picks = 0;
      const prompt = makePrompter({ showInputBox: async () => 'Created', showQuickPick: async () => { picks++; return undefined; } });
      await createNewCollectionHandler(f.workspace, prompt)(contextNode);
      assert.strictEqual(f.workspace.getOwnerData(owner)!.collections.at(-1)!.name, 'Created');
      assert.strictEqual(picks, 0);
    });
  }
  for (const cancel of ['root', 'name'] as const) {
    test(`new collection cancellation at ${cancel} never writes`, async () => {
      const f = await partitionCommandFixture();
      const prompt = makePrompter({ showInputBox: async () => cancel === 'name' ? undefined : 'Created',
        showQuickPick: async options => cancel === 'root' ? undefined : options[0] });
      const before = f.state.updateCallCount;
      await createNewCollectionHandler(f.workspace, prompt)();
      assert.strictEqual(f.state.updateCallCount, before);
    });
  }
  test('no attached root is an informative no-op without prompting for a name', async () => {
    const f = await partitionCommandFixture([]);
    const prompt = new FakePrompter({ inputBoxResult: 'Created' });
    await createNewCollectionHandler(f.workspace, prompt)();
    assert.ok(prompt.lastInfoMessage);
    assert.strictEqual(prompt.inputBoxCallCount, 0);
  });
  test('a root disappearing while entering a name prevents collection creation', async () => {
    const f = await partitionCommandFixture(['file:///a']);
    const prompt = new FakePrompter({ inputBoxResult: 'Created' });
    prompt.showInputBox = async () => { await f.workspace.reconcileRoots([]); return 'Created'; };
    await createNewCollectionHandler(f.workspace, prompt)();
    assert.strictEqual(f.workspace.getAll().collections.length, 0);
    assert.ok(prompt.lastInfoMessage);
  });
  test('Detached and Unassigned forbid creation but allow existing content edits and removal', async () => {
    const f = await recoveryFixture();
    const detached = f.store.getView().detached[0];
    const owner: WorkspaceOwnerRef = { kind: 'partition', partitionId: detached.partitionId };
    const prompt = new FakePrompter({ inputBoxResult: 'Edited' });
    const stores = { workspace: f.store, global: new BookmarkStore(new FakeMemento()) };
    await createNewCollectionHandler(f.store, prompt)(f.node);
    await createNewCollectionHandler(f.store, prompt)({ kind: 'unassignedRoot', scope: 'workspace', collection: { id: '', name: '', order: 0 } });
    assert.strictEqual(f.store.getAll().collections.length, 0);
    await createSetDescriptionHandler(stores, prompt)(ownedItem(owner, detached.data.items[0]));
    assert.strictEqual(f.store.getOwnerData(owner)!.items[0].description, 'Edited');
    await createRemoveHandler(stores)(ownedItem(owner, detached.data.items[0]));
    assert.strictEqual(f.store.getOwnerData(owner)!.items.length, 3);
  });
  test('all content mutations ignore ownerless workspace leaves and structural roots', async () => {
    const f = await partitionCommandFixture();
    const item = await f.workspace.addItem(f.owners[0], { type: 'file', uri: 'file:///a/x' });
    const collection = await f.workspace.addCollection(f.owners[0], 'Saved');
    const prompt = new FakePrompter({ inputBoxResult: 'Changed', warningConfirmResult: true });
    const before = f.state.updateCallCount;
    for (const node of [{ kind: 'item', scope: 'workspace', item }, { kind: 'collection', scope: 'workspace', collection },
      partitionNode(f.owners[0].partitionId)] as BookmarkNode[]) {
      await createRemoveHandler(f.stores)(node);
      await createRenameCollectionHandler(f.stores, prompt)(node);
      await createSetDescriptionHandler(f.stores, prompt)(node);
      await createDeleteCollectionHandler(f.stores, prompt)(node);
      await createMoveToCollectionHandler(f.stores, prompt)(node);
    }
    assert.strictEqual(f.state.updateCallCount, before);
    assert.strictEqual(prompt.inputBoxCallCount, 0);
  });
  for (const cancel of [false, true]) {
    test(`ambiguous URI removal ${cancel ? 'cancellation preserves every owner' : 'prompts for the owner and preserves Global'}`, async () => {
      const f = await partitionCommandFixture(['file:///a']);
      const uri = vscode.Uri.parse('file:///a/nested/x');
      await f.workspace.addItem(f.owners[0], { type: 'file', uri: uri.toString() });
      await f.workspace.reconcileRoots([...f.roots, { id: 'nested', label: 'Nested', uri: vscode.Uri.parse('file:///a/nested') }]);
      const nested = f.workspace.resolveAttachedOwner(uri)!;
      await f.workspace.addItem(nested, { type: 'file', uri: uri.toString() });
      await f.global.addItem({ type: 'file', uri: uri.toString() });
      let optionsSeen: vscode.QuickPickItem[] = [];
      const prompt = makePrompter({ showQuickPick: async options => { optionsSeen = options; return cancel ? undefined : options[1]; } });
      await createRemoveHandler(f.stores, prompt)(uri);
      assert.strictEqual(optionsSeen.length, 2);
      assert.match(JSON.stringify(optionsSeen), /file:\/\/\/a\/nested/);
      assert.strictEqual(f.workspace.getOwnerData(f.owners[0])!.items.length, 1);
      assert.strictEqual(f.workspace.getOwnerData(nested)!.items.length, cancel ? 1 : 0);
      assert.strictEqual(f.global.getAll().items.length, 1);
    });
  }
  test('URI removal falls back to Global only when workspace has no match', async () => {
    const f = await partitionCommandFixture();
    await f.global.addItem({ type: 'file', uri: 'file:///outside' });
    await createRemoveHandler(f.stores)(vscode.Uri.parse('file:///outside'));
    assert.strictEqual(f.global.getAll().items.length, 0);
  });
  test('removes only the item in its explicit owner', async () => {
    const f = await partitionCommandFixture();
    const item = await f.workspace.addItem(f.owners[1], { type: 'file', uri: 'file:///b/test' });
    await createRemoveHandler(f.stores)(ownedItem(f.owners[1], item));
    assert.deepStrictEqual(f.workspace.getOwnerData(f.owners[1])!.items, []);
  });

  for (const [name, factory, type] of [
    ['file', createAddFileHandler, 'file'], ['folder', createAddFolderHandler, 'folder']
  ] as const) {
    test(`adds a ${name} to the deepest attached root`, async () => {
      const f = await partitionCommandFixture(['file:///a', 'file:///a/nested']);
      await factory(f.workspace, makePrompter())(vscode.Uri.parse('file:///a/nested/new'));
      assert.strictEqual(f.workspace.getOwnerData(f.owners[0])!.items.length, 0);
      assert.strictEqual(f.workspace.getOwnerData(f.owners[1])!.items[0].type, type);
    });
    test(`does not add an outside ${name}`, async () => {
      const f = await partitionCommandFixture();
      const messages: string[] = [];
      await factory(f.workspace, makePrompter({ showInfo: async m => { messages.push(m); } }))(vscode.Uri.parse('file:///outside'));
      assert.strictEqual(f.workspace.getAll().items.length, 0);
      assert.strictEqual(messages.length, 1);
    });
  }

  test('routes rename, descriptions, move, and deletion through the collection owner', async () => {
    const f = await partitionCommandFixture();
    const owner = f.owners[1];
    const collection = await f.workspace.addCollection(owner, 'Before');
    const item = await f.workspace.addItem(owner, { type: 'file', uri: 'file:///b/file' });
    const prompt = makePrompter({ showInputBox: async () => 'After', showWarningConfirm: async () => true,
      showQuickPick: async options => options.find(option => option.label === 'After') });
    await createRenameCollectionHandler(f.stores, prompt)(ownedCollection(owner, collection));
    await createSetDescriptionHandler(f.stores, prompt)(ownedCollection(owner, collection));
    await createSetDescriptionHandler(f.stores, prompt)(ownedItem(owner, item));
    await createMoveToCollectionHandler(f.stores, prompt)(ownedItem(owner, item));
    const data = f.workspace.getOwnerData(owner)!;
    assert.strictEqual(data.collections[0].name, 'After');
    assert.strictEqual(data.collections[0].description, 'After');
    assert.strictEqual(data.items[0].description, 'After');
    assert.strictEqual(data.items[0].collectionId, collection.id);
    await createDeleteCollectionHandler(f.stores, prompt)(ownedCollection(owner, collection));
    assert.deepStrictEqual(f.workspace.getOwnerData(owner)!.collections, []);
    assert.strictEqual(f.workspace.getOwnerData(owner)!.items[0].collectionId, null);
    assert.deepStrictEqual(f.workspace.getOwnerData(f.owners[0])!.items, []);
  });

  test('creates a collection in the selected attached root', async () => {
    const f = await partitionCommandFixture();
    const prompt = makePrompter({ showInputBox: async () => 'Work', showQuickPick: async options => options[1] });
    await createNewCollectionHandler(f.workspace, prompt)();
    assert.strictEqual(f.workspace.getOwnerData(f.owners[1])!.collections[0].name, 'Work');
    assert.strictEqual(f.workspace.getOwnerData(f.owners[0])!.collections.length, 0);
  });

  test('sole URI workspace match takes precedence over Global', async () => {
    const f = await partitionCommandFixture();
    await f.workspace.addItem(f.owners[1], { type: 'file', uri: 'file:///b/file' });
    await f.global.addItem({ type: 'file', uri: 'file:///b/file' });
    await createRemoveHandler(f.stores)(vscode.Uri.parse('file:///b/file'));
    assert.strictEqual(f.workspace.getAll().items.length, 0);
    assert.strictEqual(f.global.getAll().items.length, 1);
  });
});

function makePrompter(overrides: Partial<Prompter> = {}): Prompter {
  return {
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showWarningConfirm: async () => false,
    showInfo: async () => {},
    showActionPrompt: async () => undefined,
    ...overrides
  };
}

/**
 * Builds a ScopedStores fixture (T4 / #55 D2 option A: `stores[node.scope]`). Any store not
 * supplied gets a fresh, empty BookmarkStore backed by its own FakeMemento — never shared with
 * the other scope, so "the other store is untouched" assertions are meaningful.
 */
function makeScopedStores(overrides: Partial<ScopedStores<BookmarkStore>> = {}): ScopedStores<BookmarkStore> {
  return {
    workspace: overrides.workspace ?? new BookmarkStore(new FakeMemento()),
    global: overrides.global ?? new BookmarkStore(new FakeMemento())
  };
}

interface StoreSnapshot {
  data: ReturnType<BookmarkStore['getAll']>;
  updateCallCount: number;
}

function snapshotStore(store: BookmarkStore, memento: FakeMemento): StoreSnapshot {
  // Deep-copy via JSON round-trip (BookmarkData is plain primitives/arrays) so this snapshot is
  // immune to `getAll()` returning the store's live internal object by reference — otherwise a
  // later `assertUntouched` deep-equal would tautologically compare the mutated object to itself.
  return {
    data: JSON.parse(JSON.stringify(store.getAll())) as ReturnType<BookmarkStore['getAll']>,
    updateCallCount: memento.updateCallCount
  };
}

/**
 * Asserts a store was not mutated by the handler under test: both its content (deep-equal
 * snapshot) and the fact that no write was even attempted (Memento.update call count unchanged).
 */
function assertUntouched(
  store: BookmarkStore,
  memento: FakeMemento,
  before: StoreSnapshot,
  label: string
): void {
  assert.deepStrictEqual(store.getAll(), before.data, `the ${label} store must be untouched`);
  assert.strictEqual(
    memento.updateCallCount,
    before.updateCallCount,
    `the ${label} store must not even attempt a write`
  );
}

suite('commands - addFile / addFolder / remove / reveal', () => {
  test('addFile handler adds a root-level file bookmark for the given uri', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/a.txt');
    await createAddFileHandler(store, makePrompter())(uri);

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'file');
    assert.strictEqual(items[0].uri, uri.toString());
  });

  test('addFolder handler adds a root-level folder bookmark for the given uri', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/dir');
    await createAddFolderHandler(store, makePrompter())(uri);

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'folder');
  });

  test('addFile handler notifies exactly once for a duplicate and not for a normal add', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/a.txt');
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });
    const handler = createAddFileHandler(store, prompter);

    await handler(uri);
    assert.strictEqual(messages.length, 0);

    await handler(uri);

    assert.strictEqual(store.getAll().items.length, 1);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('addFolder handler notifies exactly once for a duplicate and not for a normal add', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = vscode.Uri.file('/workspace/dir');
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });
    const handler = createAddFolderHandler(store, prompter);

    await handler(uri);
    assert.strictEqual(messages.length, 0);

    await handler(uri);

    assert.strictEqual(store.getAll().items.length, 1);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('remove handler deletes the targeted item and ignores non-item nodes', async () => {
    const stores = makeScopedStores();
    const item = await stores.workspace.addItem({ type: 'file', uri: 'file:///a.txt' });
    const handler = createRemoveHandler(stores);

    const nonItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };
    await handler(nonItemNode);
    assert.strictEqual(stores.workspace.getAll().items.length, 1, 'non-item nodes must be a no-op');

    await handler({ kind: 'item', item, scope: 'workspace' });
    assert.strictEqual(stores.workspace.getAll().items.length, 0);
  });

  test('remove handler on a workspace-scoped node removes only from the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    const globalBefore = snapshotStore(global, globalMemento);
    const handler = createRemoveHandler(makeScopedStores({ workspace, global }));

    await handler({ kind: 'item', item: workspaceItem, scope: 'workspace' });

    assert.strictEqual(workspace.getAll().items.length, 0, 'the workspace item must be removed');
    assertUntouched(global, globalMemento, globalBefore, 'global');
    assert.strictEqual(global.getAll().items.find((i) => i.id === globalItem.id)?.id, globalItem.id);
  });

  test('remove handler on a global-scoped node removes only from the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const handler = createRemoveHandler(makeScopedStores({ workspace, global }));

    await handler({ kind: 'item', item: globalItem, scope: 'global' });

    assert.strictEqual(global.getAll().items.length, 0, 'the global item must be removed');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
    assert.strictEqual(workspace.getAll().items.find((i) => i.id === workspaceItem.id)?.id, workspaceItem.id);
  });

  // `createRevealHandler`'s tests (both its pre-existing plain-reveal branches and the new
  // addable-global-folder action-prompt branches, #93) live in their own
  // `commands - reveal (out-of-workspace global folder prompt, #93)` suite below, once its
  // `RevealDeps` fixtures (`folder()`, `folderItem()`) are in scope — see that suite for the full
  // reveal coverage, including the file/non-item/in-workspace no-prompt cases that used to live
  // here.
});

// #114: `bookmarks.remove` must become reachable from the Explorer / editor-title context menus,
// which invoke a command with a `vscode.Uri` argument (the right-clicked resource), not a
// `BookmarkNode` (the tree view's own argument shape). Per the issue's technical notes this is the
// *same* command id as the tree view's remove — so `createRemoveHandler`'s returned handler must
// accept either shape. These tests pin the Uri-argument branch of that contract; the pre-existing
// `BookmarkNode`-argument branch is covered by the suite above and is unchanged.
//
// Scope resolution: a resource Uri carries no explicit scope, so the handler must search both
// stores. These tests only cover the disjoint cases (bookmarked in exactly one scope) — which
// scope wins when the *same* uri is bookmarked in both is left unspecified by the issue and is
// deliberately not asserted here.
suite('commands - remove (resource URI from Explorer/editor context, #114)', () => {
  test('removes the matching bookmark when invoked with a workspace-bookmarked resource Uri', async () => {
    const stores = makeScopedStores();
    const uri = vscode.Uri.file('/workspace/a.txt');
    await stores.workspace.addItem({ type: 'file', uri: uri.toString() });
    const handler = createRemoveHandler(stores);

    await handler(uri);

    assert.strictEqual(stores.workspace.getAll().items.length, 0);
  });

  test('removes only the global bookmark when the resource is bookmarked globally; workspace store untouched', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const uri = vscode.Uri.file('/global/a.txt');
    await global.addItem({ type: 'file', uri: uri.toString() });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const handler = createRemoveHandler(makeScopedStores({ workspace, global }));

    await handler(uri);

    assert.strictEqual(global.getAll().items.length, 0, 'the global bookmark for this resource must be removed');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('is a no-op and does not throw when the given resource Uri is not bookmarked in any scope', async () => {
    const stores = makeScopedStores();
    const uri = vscode.Uri.file('/workspace/not-bookmarked.txt');
    const handler = createRemoveHandler(stores);

    await assert.doesNotReject(() => handler(uri));

    assert.strictEqual(stores.workspace.getAll().items.length, 0);
    assert.strictEqual(stores.global.getAll().items.length, 0);
  });

  test('removes a folder bookmark matching the given resource Uri, leaving unrelated items untouched', async () => {
    const stores = makeScopedStores();
    const targetUri = vscode.Uri.file('/workspace/dir');
    const otherUri = vscode.Uri.file('/workspace/other.txt');
    await stores.workspace.addItem({ type: 'folder', uri: targetUri.toString() });
    const other = await stores.workspace.addItem({ type: 'file', uri: otherUri.toString() });
    const handler = createRemoveHandler(stores);

    await handler(targetUri);

    const remaining = stores.workspace.getAll().items;
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, other.id);
  });
});

// T4 (#55 D2) scope-routing note: `createAddFileHandler` / `createAddFolderHandler` take a
// vscode.Uri, not a BookmarkNode, so there is no `node.scope` to route on — they stay bound to a
// single store here, and #55's global-add commands (bookmarks.addFileGlobal /
// bookmarks.addFolderGlobal) are separately-registered handlers over the global store (plan T5),
// not a scope-routed variant of these. `createRevealHandler` takes a node but never touches a
// store at all, so it is scope-irrelevant.

// T5 (#55) registerAddCommands wiring: registers four commands over a ScopedStores — the two
// existing workspace-bound commands (regression-checked here so the ScopedStores signature change
// cannot silently flip their routing) plus two new global-bound commands.
//
// `registerAddCommands` registers all four command ids ('bookmarks.addFile', '.addFolder',
// '.addFileGlobal', '.addFolderGlobal') on every call, and the real extension's own `activate()`
// registers those same four ids for real via the exact same `registerAddCommands` call, triggered
// by `onStartupFinished` (implied by package.json's `activationEvents: []`) at a non-deterministic
// point in the mocha run — independent of which test is currently executing. Each test here used to
// call `registerAddCommands` directly against the real `vscode.commands` registry, so if real
// activation happened to land between two of these tests (after one test's `dispose()` calls freed
// the ids, before the next test's `registerAddCommands` call re-registered them), the next
// `registerCommand` call would throw `command '...' already exists` — and since real activation is
// never disposed mid-process, every later `registerAddCommands` call in the whole run would then
// fail permanently too. This reproduced in CI (PR #75, commit 65cac1d): the `addFolder`-workspace
// test failed with `command 'bookmarks.addFile' already exists` after the two preceding tests in
// this same suite passed — i.e. activation landed mid-suite. Confirmed by instrumenting an
// artificial delay into this suite locally: shifting the wall-clock offset reproducibly moved the
// same class of real-activation collision (there, "Trying to add a disposable to a DisposableStore
// that has already been disposed of") into a different suite, proving activation genuinely fires
// asynchronously mid-run and collides with any suite that owns the real command/store lifecycle
// without isolating it. This is the same race the `commands - view` suite below already isolates
// itself from via `withIsolatedCommandRegistry` — applying the identical fix here.
suite('commands - registerAddCommands (workspace + global)', () => {
  test('bookmarks.addFileGlobal adds a bookmark to the global store; workspace store is untouched', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const workspaceBefore = snapshotStore(workspace, workspaceMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/global/a.txt');
        await vscode.commands.executeCommand('bookmarks.addFileGlobal', uri);

        const globalItems = global.getAll().items;
        assert.strictEqual(globalItems.length, 1);
        assert.strictEqual(globalItems[0].type, 'file');
        assert.strictEqual(globalItems[0].uri, uri.toString());
        assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('bookmarks.addFolderGlobal adds a bookmark to the global store; workspace store is untouched', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const workspaceBefore = snapshotStore(workspace, workspaceMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/global/dir');
        await vscode.commands.executeCommand('bookmarks.addFolderGlobal', uri);

        const globalItems = global.getAll().items;
        assert.strictEqual(globalItems.length, 1);
        assert.strictEqual(globalItems[0].type, 'folder');
        assert.strictEqual(globalItems[0].uri, uri.toString());
        assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('bookmarks.addFile still adds only to the workspace store after the ScopedStores signature change', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const globalBefore = snapshotStore(global, globalMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/workspace/a.txt');
        await vscode.commands.executeCommand('bookmarks.addFile', uri);

        const workspaceItems = workspace.getAll().items;
        assert.strictEqual(workspaceItems.length, 1);
        assert.strictEqual(workspaceItems[0].type, 'file');
        assert.strictEqual(workspaceItems[0].uri, uri.toString());
        assertUntouched(global, globalMemento, globalBefore, 'global');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('bookmarks.addFolder still adds only to the workspace store after the ScopedStores signature change', async () => {
    await withIsolatedCommandRegistry(async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      const globalBefore = snapshotStore(global, globalMemento);
      const subscriptions: vscode.Disposable[] = [];
      registerAddCommands({ subscriptions } as unknown as vscode.ExtensionContext, { workspace, global });

      try {
        const uri = vscode.Uri.file('/workspace/dir');
        await vscode.commands.executeCommand('bookmarks.addFolder', uri);

        const workspaceItems = workspace.getAll().items;
        assert.strictEqual(workspaceItems.length, 1);
        assert.strictEqual(workspaceItems[0].type, 'folder');
        assert.strictEqual(workspaceItems[0].uri, uri.toString());
        assertUntouched(global, globalMemento, globalBefore, 'global');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });
});

suite('commands - collections', () => {
  test('newCollection handler creates a collection with the prompted name', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = makePrompter({ showInputBox: async () => 'Work' });

    await createNewCollectionHandler(store, prompter)();

    const collections = store.getAll().collections;
    assert.strictEqual(collections.length, 1);
    assert.strictEqual(collections[0].name, 'Work');
  });

  test('newCollection handler does nothing when the prompt is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await createNewCollectionHandler(store, makePrompter())();
    assert.strictEqual(store.getAll().collections.length, 0);
  });

  // T4 (#55 D2) scope-routing note: `bookmarks.newCollection` is pinned to the workspace store
  // per plan T5 ("global collections are created from the Global row's own inline button") —
  // `createNewCollectionHandler` takes no node, so there is no `node.scope` to route on, and it
  // is not part of the ScopedStores contract.

  test('createNewCollectionHandler bound to the global store creates a collection in the global store only, workspace store untouched', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = makePrompter({ showInputBox: async () => 'My Global Collection' });

    await createNewCollectionHandler(global, prompter)();

    const globalCollections = global.getAll().collections;
    assert.strictEqual(globalCollections.length, 1);
    assert.strictEqual(globalCollections[0].name, 'My Global Collection');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('renameCollection handler renames the targeted collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const prompter = makePrompter({ showInputBox: async () => 'Work Stuff' });

    await createRenameCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections[0].name, 'Work Stuff');
  });

  test('renameCollection handler does nothing when the prompt is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');

    await createRenameCollectionHandler(makeScopedStores({ workspace: store }), makePrompter())({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections[0].name, 'Work', 'cancelled prompt must not rename');
  });

  test('renameCollection handler ignores non-collection nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    let inputBoxCalled = false;
    const prompter = makePrompter({
      showInputBox: async () => {
        inputBoxCalled = true;
        return 'Whatever';
      }
    });

    await createRenameCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });
    assert.strictEqual(store.getAll().collections.length, 0);
    assert.strictEqual(inputBoxCalled, false, 'must not prompt for a non-collection node');
  });

  test('renameCollection handler on a workspace-scoped node renames only in the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Work');
    await global.addCollection('Work'); // deliberately colliding name, distinct store
    const globalBefore = snapshotStore(global, globalMemento);
    const prompter = makePrompter({ showInputBox: async () => 'Work Stuff' });

    await createRenameCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'collection',
      collection: workspaceCollection,
      scope: 'workspace'
    });

    assert.strictEqual(workspace.getAll().collections[0].name, 'Work Stuff');
    assertUntouched(global, globalMemento, globalBefore, 'global');
  });

  test('renameCollection handler on a global-scoped node renames only in the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    await workspace.addCollection('Work'); // deliberately colliding name, distinct store
    const globalCollection = await global.addCollection('Work');
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = makePrompter({ showInputBox: async () => 'Personal' });

    await createRenameCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'collection',
      collection: globalCollection,
      scope: 'global'
    });

    assert.strictEqual(global.getAll().collections[0].name, 'Personal');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('deleteCollection handler does nothing when the confirmation is declined', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const declining = makePrompter({ showWarningConfirm: async () => false });

    await createDeleteCollectionHandler(makeScopedStores({ workspace: store }), declining)({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections.length, 1, 'declined confirmation must not delete');
    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, collection.id);
  });

  test('deleteCollection handler deletes the collection and ungroups its items after confirmation', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const confirming = makePrompter({ showWarningConfirm: async () => true });

    await createDeleteCollectionHandler(makeScopedStores({ workspace: store }), confirming)({
      kind: 'collection',
      collection,
      scope: 'workspace'
    });

    const data = store.getAll();
    assert.strictEqual(data.collections.length, 0);
    assert.strictEqual(
      data.items.find((i) => i.id === item.id)!.collectionId,
      null,
      'items must be ungrouped, not deleted'
    );
  });

  test('deleteCollection handler ignores non-collection nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    let warningConfirmCalled = false;
    const confirming = makePrompter({
      showWarningConfirm: async () => {
        warningConfirmCalled = true;
        return true;
      }
    });

    await createDeleteCollectionHandler(makeScopedStores({ workspace: store }), confirming)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().items.length, 1, 'non-collection nodes must be a no-op');
    assert.strictEqual(
      warningConfirmCalled,
      false,
      'must not confirm deletion for a non-collection node'
    );
  });

  test('deleteCollection handler on a global-scoped node deletes only in the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Notes'); // untouched control
    const globalCollection = await global.addCollection('Notes');
    const globalItem = await global.addItem({
      type: 'file',
      uri: 'file:///global-note.txt',
      collectionId: globalCollection.id
    });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const confirming = makePrompter({ showWarningConfirm: async () => true });

    await createDeleteCollectionHandler(makeScopedStores({ workspace, global }), confirming)({
      kind: 'collection',
      collection: globalCollection,
      scope: 'global'
    });

    const globalData = global.getAll();
    assert.strictEqual(globalData.collections.length, 0, 'the global collection must be deleted');
    assert.strictEqual(
      globalData.items.find((i) => i.id === globalItem.id)!.collectionId,
      null,
      'the global item must be ungrouped, not deleted'
    );
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
    assert.strictEqual(workspace.getAll().collections[0].id, workspaceCollection.id);
  });

  test(
    'deleteCollection handler on a global collection ungroups only the global item, leaving a ' +
      'workspace item at the same uri and its own collection untouched',
    async () => {
      const workspaceMemento = new FakeMemento();
      const globalMemento = new FakeMemento();
      const workspace = new BookmarkStore(workspaceMemento);
      const global = new BookmarkStore(globalMemento);
      // Same uri and collection name in both scopes (D6: same URI is allowed once per scope) —
      // this must not fool the handler into ungrouping across scopes.
      const uri = 'file:///shared.txt';
      const workspaceCollection = await workspace.addCollection('Shared Name');
      const workspaceItem = await workspace.addItem({ type: 'file', uri, collectionId: workspaceCollection.id });
      const globalCollection = await global.addCollection('Shared Name');
      const globalItem = await global.addItem({ type: 'file', uri, collectionId: globalCollection.id });
      const workspaceBefore = snapshotStore(workspace, workspaceMemento);
      const confirming = makePrompter({ showWarningConfirm: async () => true });

      await createDeleteCollectionHandler(makeScopedStores({ workspace, global }), confirming)({
        kind: 'collection',
        collection: globalCollection,
        scope: 'global'
      });

      const globalData = global.getAll();
      assert.strictEqual(globalData.collections.length, 0);
      assert.strictEqual(
        globalData.items.find((i) => i.id === globalItem.id)!.collectionId,
        null,
        'the global item sharing a uri with a workspace item must be ungrouped'
      );
      assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
      assert.strictEqual(
        workspace.getAll().items.find((i) => i.id === workspaceItem.id)!.collectionId,
        workspaceCollection.id,
        'the workspace item and its collection must be unaffected by deleting the same-named, ' +
          'same-uri global collection'
      );
    }
  );

  test('moveToCollection handler moves the item into the chosen collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Work')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, collection.id);
  });

  test('moveToCollection handler reports a duplicate and leaves the item in its collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const uri = 'file:///a.txt';
    const item = await store.addItem({ type: 'file', uri });
    await store.addItem({ type: 'file', uri, collectionId: collection.id });
    const messages: string[] = [];
    const prompter = makePrompter({
      showQuickPick: async (items) =>
        items.find((quickPickItem) => quickPickItem.label === 'Work'),
      showInfo: async (message) => {
        messages.push(message);
      }
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

    assert.deepStrictEqual(messages, ['This item is already bookmarked.']);
    assert.strictEqual(
      store.getAll().items.find((storedItem) => storedItem.id === item.id)!.collectionId,
      null
    );
  });

  test('moveToCollection handler distinguishes collections with duplicate names by id', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addCollection('Work');
    const secondCollection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = makePrompter({
      showQuickPick: async (items) =>
        items.find(
          (quickPickItem) =>
            'id' in quickPickItem && quickPickItem.id === secondCollection.id
        )
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

    assert.strictEqual(
      store.getAll().items.find((storedItem) => storedItem.id === item.id)!.collectionId,
      secondCollection.id
    );
  });

  test('moveToCollection handler offers "Ungrouped" and moving to it clears collectionId', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const collection = await store.addCollection('Work');
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt', collectionId: collection.id });
    const prompter = makePrompter({
      showQuickPick: async (items) =>
        items.find((quickPickItem) => quickPickItem.label === 'Ungrouped')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'item',
      item,
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, null);
  });

  test('moveToCollection handler does nothing when the pick is cancelled', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), makePrompter())({
      kind: 'item',
      item,
      scope: 'workspace'
    });
    assert.strictEqual(store.getAll().items.find((i) => i.id === item.id)!.collectionId, null);
  });

  test('moveToCollection handler ignores non-item nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addCollection('Work');
    const nonItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };
    let quickPickCalled = false;
    const prompter = makePrompter({
      showQuickPick: async () => {
        quickPickCalled = true;
        return undefined;
      }
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace: store }), prompter)(nonItemNode);

    assert.strictEqual(quickPickCalled, false, 'must not prompt when there is no item to move');
  });

  test('moveToCollection handler offers only global collections (and Ungrouped) for a global-scoped node', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    // Deliberately colliding label so a label-based assertion could pass vacuously; the id set
    // is the only thing that actually proves scope isolation.
    await workspace.addCollection('Shared Name');
    const globalCollectionA = await global.addCollection('Shared Name');
    const globalCollectionB = await global.addCollection('Other Global');
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    let offeredIds: Array<string | null> = [];
    const prompter = makePrompter({
      showQuickPick: async (items) => {
        offeredIds = (items as unknown as Array<{ id: string | null }>).map((item) => item.id);
        return undefined;
      }
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItem,
      scope: 'global'
    });

    assert.deepStrictEqual(
      [...offeredIds].sort(),
      [null, globalCollectionA.id, globalCollectionB.id].sort(),
      'a global node picker must offer exactly the global collections plus Ungrouped, never workspace collections'
    );
  });

  test('moveToCollection handler offers only workspace collections (and Ungrouped) for a workspace-scoped node', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Shared Name');
    await global.addCollection('Shared Name'); // deliberately colliding label, distinct store
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    let offeredIds: Array<string | null> = [];
    const prompter = makePrompter({
      showQuickPick: async (items) => {
        offeredIds = (items as unknown as Array<{ id: string | null }>).map((item) => item.id);
        return undefined;
      }
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: workspaceItem,
      scope: 'workspace'
    });

    assert.deepStrictEqual(
      [...offeredIds].sort(),
      [null, workspaceCollection.id].sort(),
      'a workspace node picker must offer exactly the workspace collections plus Ungrouped, never global collections'
    );
  });

  test('moveToCollection handler computes the sibling count from the target scope store, not the other scope', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);

    // The workspace collection of the same name has a different sibling count (3) than the
    // global collection (1) being moved into — proves order comes from the resolved store.
    const workspaceCollection = await workspace.addCollection('Personal');
    await workspace.addItem({ type: 'file', uri: 'file:///w1.txt', collectionId: workspaceCollection.id });
    await workspace.addItem({ type: 'file', uri: 'file:///w2.txt', collectionId: workspaceCollection.id });
    await workspace.addItem({ type: 'file', uri: 'file:///w3.txt', collectionId: workspaceCollection.id });

    const globalCollection = await global.addCollection('Personal');
    await global.addItem({ type: 'file', uri: 'file:///g1.txt', collectionId: globalCollection.id });
    const globalItemToMove = await global.addItem({ type: 'file', uri: 'file:///g2.txt' });

    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Personal')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItemToMove,
      scope: 'global'
    });

    const moved = global.getAll().items.find((i) => i.id === globalItemToMove.id)!;
    assert.strictEqual(moved.collectionId, globalCollection.id);
    assert.strictEqual(
      moved.order,
      1,
      'order must equal the global collection\'s existing sibling count (1), not the workspace collection\'s (3)'
    );
  });

  test('moveToCollection handler on a workspace-scoped node leaves the global store untouched', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceCollection = await workspace.addCollection('Work');
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///a.txt' });
    await global.addCollection('Work'); // deliberately colliding name, distinct store
    const globalBefore = snapshotStore(global, globalMemento);
    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Work')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: workspaceItem,
      scope: 'workspace'
    });

    assert.strictEqual(
      workspace.getAll().items.find((i) => i.id === workspaceItem.id)!.collectionId,
      workspaceCollection.id
    );
    assertUntouched(global, globalMemento, globalBefore, 'global');
  });

  test('moveToCollection handler on a global-scoped node leaves the workspace store untouched', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    await workspace.addCollection('Work'); // deliberately colliding name, distinct store
    const globalCollection = await global.addCollection('Work');
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///a.txt' });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = makePrompter({
      showQuickPick: async (items) => items.find((quickPickItem) => quickPickItem.label === 'Work')
    });

    await createMoveToCollectionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItem,
      scope: 'global'
    });

    assert.strictEqual(
      global.getAll().items.find((i) => i.id === globalItem.id)!.collectionId,
      globalCollection.id
    );
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });
});

// The VS Code Extension Test Host activates this extension for real at some point during the
// mocha run (package.json's `"activationEvents": []` implies `onStartupFinished`), independent of
// test/file order — permanently registering the real `bookmarks.*` commands, including
// `bookmarks.toggleGroupByRepo` / `bookmarks.refresh`, through the real extension's own
// `context.subscriptions` (never disposed mid-process). `vscode.commands.registerCommand` is a
// single, non-idempotent, process-wide registry, so once real activation has claimed an id, any
// later `registerCommand` call for that same id — such as this suite's stub-context registration —
// throws `command '...' already exists`, and there is no supported API to unregister a command
// owned by a `Disposable` this suite never held. This is not just a "runs late in the file" problem:
// PR #75's CI run proved real activation can land in the middle of the (textually earlier, four-test)
// `registerAddCommands` suite too — the third test passed, then the fourth failed with `command
// 'bookmarks.addFile' already exists`, because activation registered it in the gap between the two
// tests. That suite now uses this same shim (see its comment above) rather than relying on running
// "early enough" to win a race that has no guaranteed winner.
//
// These two tests isolate themselves from that shared, uncontrollable global registry by swapping
// `vscode.commands.registerCommand` / `executeCommand` for an in-memory stand-in for the test's
// duration only, then restoring the originals. `registerViewCommands` still calls the exact same
// API surface with the exact same signatures, and the test still dispatches by command id through
// `vscode.commands.executeCommand` — so this still proves `registerViewCommands` wires
// `bookmarks.toggleGroupByRepo` / `bookmarks.refresh` to the given `BookmarksTreeDataProvider`
// exactly as a real command dispatch would. It just never touches the real extension's
// registrations, so the assertions no longer depend on winning a timing race against
// `onStartupFinished`. Any id not registered through the shim falls through to the real dispatcher,
// so this cannot mask an unrelated command lookup.
async function withIsolatedCommandRegistry<T>(run: () => Promise<T>): Promise<T> {
  const realRegisterCommand = vscode.commands.registerCommand;
  const realExecuteCommand = vscode.commands.executeCommand;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  (vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand = ((
    command: string,
    callback: (...args: unknown[]) => unknown,
    thisArg?: unknown
  ) => {
    handlers.set(command, thisArg === undefined ? callback : callback.bind(thisArg));
    return { dispose: () => handlers.delete(command) };
  }) as typeof vscode.commands.registerCommand;

  (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = (async (
    command: string,
    ...rest: unknown[]
  ) => {
    const handler = handlers.get(command);
    if (!handler) {
      return realExecuteCommand(command, ...rest);
    }
    return handler(...rest);
  }) as typeof vscode.commands.executeCommand;

  try {
    return await run();
  } finally {
    (vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand =
      realRegisterCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand =
      realExecuteCommand;
  }
}

suite('commands - view (toggleGroupByRepo / refresh)', () => {
  test('toggleGroupByRepo flips between default and byRepo', async () => {
    await withIsolatedCommandRegistry(async () => {
      const store = new BookmarkStore(new FakeMemento());
      const cache = new FsGitCache(async () => ({ exists: true }));
      const provider = new BookmarksTreeDataProvider(store, cache);
      const subscriptions: vscode.Disposable[] = [];
      registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

      try {
        assert.strictEqual(provider.getGroupMode(), 'default');
        await vscode.commands.executeCommand('bookmarks.toggleGroupByRepo');
        assert.strictEqual(provider.getGroupMode(), 'byRepo');
        await vscode.commands.executeCommand('bookmarks.toggleGroupByRepo');
        assert.strictEqual(provider.getGroupMode(), 'default');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('refresh invalidates the cache so the next render re-resolves', async () => {
    await withIsolatedCommandRegistry(async () => {
      let resolveCalls = 0;
      const store = new BookmarkStore(new FakeMemento());
      const cache = new FsGitCache(async () => {
        resolveCalls++;
        return { exists: true };
      });
      const provider = new BookmarksTreeDataProvider(store, cache);
      const subscriptions: vscode.Disposable[] = [];
      registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

      try {
        const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
        await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
        assert.strictEqual(resolveCalls, 1);

        await vscode.commands.executeCommand('bookmarks.refresh');
        await provider.getTreeItem({ kind: 'item', item, scope: 'workspace' });
        assert.strictEqual(resolveCalls, 2);
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });
});

// --- #115: "Toggle Show Full Path" — a view-title-bar toggle mirroring toggleGroupByRepo's shape
// exactly (new command id `bookmarks.toggleShowFullPath`, wired through `registerViewCommands`,
// flips a flag on the provider, and triggers a refresh). See bookmarksTreeDataProvider.test.ts's
// "show full path (#115)" suite for the label/description rendering and persistence contract;
// this suite only proves the command plumbing, the same split `toggleGroupByRepo` already has
// between this file (wiring) and the provider's own tests (rendering).
suite('commands - view (toggleShowFullPath) (#115)', () => {
  test('toggleShowFullPath flips the full-path display flag, mirroring toggleGroupByRepo', async () => {
    await withIsolatedCommandRegistry(async () => {
      const store = new BookmarkStore(new FakeMemento());
      const cache = new FsGitCache(async () => ({ exists: true }));
      const provider = new BookmarksTreeDataProvider(store, cache);
      const subscriptions: vscode.Disposable[] = [];
      registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

      try {
        assert.strictEqual(provider.getShowFullPath(), false, 'the toggle must default to off');
        await vscode.commands.executeCommand('bookmarks.toggleShowFullPath');
        assert.strictEqual(provider.getShowFullPath(), true);
        await vscode.commands.executeCommand('bookmarks.toggleShowFullPath');
        assert.strictEqual(provider.getShowFullPath(), false);
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });

  test('toggleShowFullPath triggers a tree refresh (onDidChangeTreeData), same as toggleGroupByRepo', async () => {
    await withIsolatedCommandRegistry(async () => {
      const store = new BookmarkStore(new FakeMemento());
      const cache = new FsGitCache(async () => ({ exists: true }));
      const provider = new BookmarksTreeDataProvider(store, cache);
      const subscriptions: vscode.Disposable[] = [];
      registerViewCommands({ subscriptions } as unknown as vscode.ExtensionContext, provider);

      try {
        let redraws = 0;
        provider.onDidChangeTreeData(() => {
          redraws++;
        });
        await vscode.commands.executeCommand('bookmarks.toggleShowFullPath');
        assert.strictEqual(redraws, 1, 'toggling full-path display must trigger a refresh, same as toggleGroupByRepo');
      } finally {
        subscriptions.forEach((d) => d.dispose());
      }
    });
  });
});

suite('commands - setDescription', () => {
  function itemNode(item: BookmarkItem): BookmarkNode {
    return { kind: 'item', item, scope: 'workspace' };
  }

  test('is a no-op when invoked without a tree node', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = new FakePrompter({ inputBoxResult: 'unused' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)();

    assert.strictEqual(prompter.inputBoxCallCount, 0);
  });

  test('sets a description on an item', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    const prompter = new FakePrompter({ inputBoxResult: 'the entrypoint' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(store.getAll().items[0].description, 'the entrypoint');
  });

  test('pre-fills the input box with the current description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: 'updated' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(prompter.lastInputBoxOptions?.value, 'existing');
  });

  test('submitting an empty input box clears the description', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: '' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(store.getAll().items[0].description, undefined);
  });

  test('dismissing the input box leaves the description unchanged', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const item = await store.addItem({ type: 'file', uri: 'file:///a.txt' });
    await store.setItemDescription(item.id, 'existing');
    const prompter = new FakePrompter({ inputBoxResult: undefined });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)(
      itemNode(store.getAll().items[0])
    );

    assert.strictEqual(store.getAll().items[0].description, 'existing');
  });

  test('sets a description on a collection', async () => {
    const store = new BookmarkStore(new FakeMemento());
    await store.addCollection('Work');
    const prompter = new FakePrompter({ inputBoxResult: 'work-related bookmarks' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'collection',
      collection: store.getAll().collections[0],
      scope: 'workspace'
    });

    assert.strictEqual(store.getAll().collections[0].description, 'work-related bookmarks');
  });

  test('is a no-op on a repoGroup node', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const prompter = new FakePrompter({ inputBoxResult: 'nope' });

    await createSetDescriptionHandler(makeScopedStores({ workspace: store }), prompter)({
      kind: 'repoGroup',
      label: 'repo-a',
      repoKey: 'repo:repo-a'
    });

    assert.strictEqual(prompter.inputBoxCallCount, 0, 'the input box must not even open for a repo group');
  });

  test('sets a description on a global-scoped item without touching the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const globalItem = await global.addItem({ type: 'file', uri: 'file:///global-item.txt' });
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = new FakePrompter({ inputBoxResult: 'always available' });

    await createSetDescriptionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: globalItem,
      scope: 'global'
    });

    assert.strictEqual(global.getAll().items[0].description, 'always available');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('sets a description on a global-scoped collection without touching the workspace store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    await workspace.addCollection('Work'); // deliberately colliding name, distinct store
    const globalCollection = await global.addCollection('Work');
    const workspaceBefore = snapshotStore(workspace, workspaceMemento);
    const prompter = new FakePrompter({ inputBoxResult: 'global collection note' });

    await createSetDescriptionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'collection',
      collection: globalCollection,
      scope: 'global'
    });

    assert.strictEqual(global.getAll().collections[0].description, 'global collection note');
    assertUntouched(workspace, workspaceMemento, workspaceBefore, 'workspace');
  });

  test('sets a description on a workspace-scoped item without touching the global store', async () => {
    const workspaceMemento = new FakeMemento();
    const globalMemento = new FakeMemento();
    const workspace = new BookmarkStore(workspaceMemento);
    const global = new BookmarkStore(globalMemento);
    const workspaceItem = await workspace.addItem({ type: 'file', uri: 'file:///workspace-item.txt' });
    const globalBefore = snapshotStore(global, globalMemento);
    const prompter = new FakePrompter({ inputBoxResult: 'project-specific' });

    await createSetDescriptionHandler(makeScopedStores({ workspace, global }), prompter)({
      kind: 'item',
      item: workspaceItem,
      scope: 'workspace'
    });

    assert.strictEqual(workspace.getAll().items[0].description, 'project-specific');
    assertUntouched(global, globalMemento, globalBefore, 'global');
  });
});

// T10 (#55/#56) `createAddToWorkspaceHandler`: promotes an addable global folder into the current
// workspace via `vscode.workspace.updateWorkspaceFolders`. Contract pinned in
// docs/superpowers/specs/2026-07-22-vscode-bookmarks-plus-design.md §5, issue #56.
//
// `folder()` mirrors the fixture shape already used in workspaceFolders.test.ts:10-12 — `index`
// isn't part of any contract this handler reads, a fixed default is fine.
function folder(uri: vscode.Uri, name = 'workspace-folder', index = 0): vscode.WorkspaceFolder {
  return { uri, name, index };
}

interface UpdateWorkspaceFoldersCall {
  start: number;
  deleteCount: number | undefined | null;
  folders: { uri: vscode.Uri; name?: string }[];
}

interface AddToWorkspaceFakes {
  deps: AddToWorkspaceDeps;
  /** Ordered log of every side-effecting call the handler made, across all three fakes. */
  calls: string[];
  updateCalls: UpdateWorkspaceFoldersCall[];
  infoMessages: string[];
  confirmCalls: Array<{ message: string; confirmLabel: string }>;
}

/**
 * Builds a fresh set of `AddToWorkspaceDeps` fakes plus recorders. `calls` is the single shared
 * ordering log ('confirm' / 'flush' / 'update') used to pin the confirm-before-flush-before-update
 * sequence, the flush-must-precede-mutation risk (plan risk 2), and the never-call-twice rule all
 * in one assertion per test, rather than needing a dedicated "called exactly once" test.
 */
function makeAddToWorkspaceFakes(
  options: {
    folders?: readonly vscode.WorkspaceFolder[] | undefined;
    confirmResult?: boolean;
    updateResult?: boolean;
  } = {}
): AddToWorkspaceFakes {
  const calls: string[] = [];
  const updateCalls: UpdateWorkspaceFoldersCall[] = [];
  const infoMessages: string[] = [];
  const confirmCalls: Array<{ message: string; confirmLabel: string }> = [];
  const confirmResult = options.confirmResult ?? true;
  const updateResult = options.updateResult ?? true;

  const deps: AddToWorkspaceDeps = {
    prompter: {
      showWarningConfirm: async (message: string, confirmLabel: string) => {
        calls.push('confirm');
        confirmCalls.push({ message, confirmLabel });
        return confirmResult;
      },
      showInfo: async (message: string) => {
        infoMessages.push(message);
      }
    },
    getWorkspaceFolders: () => options.folders,
    updateWorkspaceFolders: (
      start: number,
      deleteCount: number | undefined | null,
      ...foldersToAdd: { uri: vscode.Uri; name?: string }[]
    ) => {
      calls.push('update');
      updateCalls.push({ start, deleteCount, folders: foldersToAdd });
      return updateResult;
    },
    flushMirrorWrites: async () => {
      calls.push('flush');
    }
  };

  return { deps, calls, updateCalls, infoMessages, confirmCalls };
}

function folderItem(uri: vscode.Uri, id = 'addable-folder'): BookmarkItem {
  return { id, type: 'folder', uri: uri.toString(), collectionId: null, order: 0 };
}

suite('commands - addToWorkspace', () => {
  // A location that is never inside any of this suite's fixture workspace-folder lists, so it is
  // always the "outside the workspace" addable case unless a test constructs its own uri.
  const outsideUri = vscode.Uri.file('/outside/new-folder');

  function assertNoSideEffects(fakes: AddToWorkspaceFakes): void {
    assert.deepStrictEqual(
      fakes.calls,
      [],
      'a refused node must never call updateWorkspaceFolders or flushMirrorWrites'
    );
  }

  test('refuses a workspace-scoped folder item', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'workspace'
    });
    assertNoSideEffects(fakes);
  });

  test('refuses a global-scoped file item', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    const item: BookmarkItem = {
      id: 'global-file',
      type: 'file',
      uri: outsideUri.toString(),
      collectionId: null,
      order: 0
    };
    await createAddToWorkspaceHandler(fakes.deps)({ kind: 'item', item, scope: 'global' });
    assertNoSideEffects(fakes);
  });

  test('refuses a global folder item that is already inside the workspace', async () => {
    const root = vscode.Uri.file('/workspace/project');
    const folders = [folder(root)];
    const descendantUri = vscode.Uri.file('/workspace/project/subfolder');
    assert.strictEqual(
      isInsideWorkspace(descendantUri, folders),
      true,
      'fixture precondition: the descendant uri must actually be inside these folders'
    );
    const fakes = makeAddToWorkspaceFakes({ folders });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(descendantUri),
      scope: 'global'
    });
    assertNoSideEffects(fakes);
  });

  test('refuses a collection node', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    const collection: BookmarkCollection = { id: 'c1', name: 'Work', order: 0 };
    await createAddToWorkspaceHandler(fakes.deps)({ kind: 'collection', collection, scope: 'global' });
    assertNoSideEffects(fakes);
  });

  test('refuses a repoGroup node', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'repoGroup',
      label: 'repo-a',
      repoKey: 'repo:repo-a'
    });
    assertNoSideEffects(fakes);
  });

  test('refuses a globalRoot node', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({ kind: 'globalRoot' });
    assertNoSideEffects(fakes);
  });

  test('empty window (folders undefined): adds at index 0, no confirm, flush before update', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['flush', 'update'],
      'an empty window must flush the mirror before updating folders, and never confirm'
    );
    assert.strictEqual(fakes.updateCalls.length, 1);
    const call = fakes.updateCalls[0];
    assert.strictEqual(call.start, 0);
    assert.strictEqual(call.deleteCount, null);
    assert.strictEqual(call.folders.length, 1);
    assert.strictEqual(call.folders[0].uri.toString(), outsideUri.toString());
  });

  test('empty window (folders []): adds at index 0, no confirm, flush before update', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: [] });
    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(fakes.calls, ['flush', 'update']);
    assert.strictEqual(fakes.updateCalls.length, 1);
    assert.strictEqual(fakes.updateCalls[0].start, 0);
    assert.strictEqual(fakes.updateCalls[0].deleteCount, null);
    assert.strictEqual(fakes.updateCalls[0].folders[0].uri.toString(), outsideUri.toString());
  });

  test(
    'single-root: flushes then adds the second root without an obsolete mirror warning',
    async () => {
      const root = vscode.Uri.file('/workspace/project');
      const folders = [folder(root)];
      const fakes = makeAddToWorkspaceFakes({ folders, confirmResult: true });

      await createAddToWorkspaceHandler(fakes.deps)({
        kind: 'item',
        item: folderItem(outsideUri),
        scope: 'global'
      });

      assert.deepStrictEqual(
        fakes.calls,
        ['flush', 'update'],
        'must flush the mirror then update folders'
      );
      assert.strictEqual(fakes.confirmCalls.length, 0);

      assert.strictEqual(fakes.updateCalls.length, 1);
      assert.strictEqual(fakes.updateCalls[0].start, 1, 'start index must equal the current folder count (1)');
      assert.strictEqual(fakes.updateCalls[0].deleteCount, null);
      assert.strictEqual(fakes.updateCalls[0].folders[0].uri.toString(), outsideUri.toString());
    }
  );

  test('single-root addition no longer depends on obsolete mirror confirmation', async () => {
    const root = vscode.Uri.file('/workspace/project');
    const folders = [folder(root)];
    const fakes = makeAddToWorkspaceFakes({ folders, confirmResult: false });

    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['flush', 'update'],
      'the obsolete confirmation is never requested'
    );
  });

  test('multi-root: no confirm, adds at index equal to the current folder count', async () => {
    const folders = [
      folder(vscode.Uri.file('/workspace/repo-a'), 'repo-a', 0),
      folder(vscode.Uri.file('/workspace/repo-b'), 'repo-b', 1),
      folder(vscode.Uri.file('/workspace/repo-c'), 'repo-c', 2)
    ];
    const fakes = makeAddToWorkspaceFakes({ folders });

    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['flush', 'update'],
      'a transition that is already multi-root must not confirm'
    );
    assert.strictEqual(fakes.updateCalls.length, 1);
    assert.strictEqual(fakes.updateCalls[0].start, 3, 'start index must equal the current folder count (3)');
    assert.strictEqual(fakes.updateCalls[0].deleteCount, null);
  });

  test('a false return from updateWorkspaceFolders surfaces an info message and does not throw', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined, updateResult: false });

    await assert.doesNotReject(
      createAddToWorkspaceHandler(fakes.deps)({
        kind: 'item',
        item: folderItem(outsideUri),
        scope: 'global'
      })
    );

    assert.strictEqual(fakes.infoMessages.length, 1, 'a false return must surface exactly one info message');
    assert.ok(fakes.infoMessages[0].length > 0, 'the failure message must not be empty');
  });

  test('a true return from updateWorkspaceFolders is silent (no info message)', async () => {
    const fakes = makeAddToWorkspaceFakes({ folders: undefined, updateResult: true });

    await createAddToWorkspaceHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.strictEqual(fakes.infoMessages.length, 0, 'success must not surface an info message');
  });
});

// Issue #93: clicking a global folder bookmark outside the workspace used to silently no-op
// (revealInExplorer has nothing to reveal for a folder that isn't part of any open workspace
// folder). `createRevealHandler` now takes a `RevealDeps` bag instead of a bare reveal function,
// and branches: an "addable global folder" (same condition as `isAddableGlobalFolder` in
// bookmarksTreeDataProvider.ts:199 — global scope, folder type, not already inside the workspace)
// shows a two-action prompt instead of revealing; every other node shape reveals exactly as
// before. `ADD_TO_WORKSPACE_LABEL` / `OPEN_IN_NEW_WINDOW_LABEL` are imported from `commands.ts`
// rather than hardcoded here so the test file and the implementation share one source of truth for
// the action labels.
interface RevealFakes {
  deps: RevealDeps;
  /** Ordered log of every side-effecting call the handler made, across all four fakes. */
  calls: string[];
  revealedUris: string[];
  promptCalls: Array<{ message: string; actions: string[] }>;
  addToWorkspaceCalls: BookmarkNode[];
  openInNewWindowUris: string[];
}

function makeRevealFakes(
  options: {
    folders?: readonly vscode.WorkspaceFolder[] | undefined;
    actionPromptResult?: string | undefined;
  } = {}
): RevealFakes {
  const calls: string[] = [];
  const revealedUris: string[] = [];
  const promptCalls: Array<{ message: string; actions: string[] }> = [];
  const addToWorkspaceCalls: BookmarkNode[] = [];
  const openInNewWindowUris: string[] = [];

  const deps: RevealDeps = {
    reveal: async (uri) => {
      calls.push('reveal');
      revealedUris.push(uri.toString());
    },
    prompter: {
      showActionPrompt: async (message, actions) => {
        calls.push('prompt');
        promptCalls.push({ message, actions });
        return options.actionPromptResult;
      }
    },
    getWorkspaceFolders: () => options.folders,
    addToWorkspace: async (node) => {
      calls.push('addToWorkspace');
      addToWorkspaceCalls.push(node);
    },
    openInNewWindow: async (uri) => {
      calls.push('openInNewWindow');
      openInNewWindowUris.push(uri.toString());
    }
  };

  return { deps, calls, revealedUris, promptCalls, addToWorkspaceCalls, openInNewWindowUris };
}

suite('commands - reveal (out-of-workspace global folder prompt, #93)', () => {
  // Never inside any of this suite's fixture workspace-folder lists, so it is always the
  // "outside the workspace" case unless a test constructs its own uri/folders pair.
  const outsideUri = vscode.Uri.file('/outside/new-folder');

  function assertNoCalls(fakes: RevealFakes, label: string): void {
    assert.deepStrictEqual(fakes.calls, [], `${label} must not call reveal, prompt, addToWorkspace, or openInNewWindow`);
  }

  test('is a no-op for non-item nodes (repoGroup)', async () => {
    const fakes = makeRevealFakes();
    await createRevealHandler(fakes.deps)({ kind: 'repoGroup', label: 'x', repoKey: 'x' });
    assertNoCalls(fakes, 'a repoGroup node');
  });

  test('is a no-op for non-item nodes (globalRoot)', async () => {
    const fakes = makeRevealFakes();
    await createRevealHandler(fakes.deps)({ kind: 'globalRoot' });
    assertNoCalls(fakes, 'a globalRoot node');
  });

  test('is a no-op for non-item nodes (collection)', async () => {
    const fakes = makeRevealFakes();
    const collection: BookmarkCollection = { id: 'c1', name: 'Work', order: 0 };
    await createRevealHandler(fakes.deps)({ kind: 'collection', collection, scope: 'global' });
    assertNoCalls(fakes, 'a collection node');
  });

  test('reveals a workspace-scoped file item without prompting', async () => {
    const fakes = makeRevealFakes({ folders: undefined });
    const item: BookmarkItem = { id: '1', type: 'file', uri: 'file:///a.txt', collectionId: null, order: 0 };

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'workspace' });

    assert.deepStrictEqual(fakes.calls, ['reveal']);
    assert.deepStrictEqual(fakes.revealedUris, ['file:///a.txt']);
  });

  test('reveals a global-scoped file item without prompting, even when it is outside every workspace folder', async () => {
    const fakes = makeRevealFakes({ folders: undefined });
    const item: BookmarkItem = { id: '2', type: 'file', uri: outsideUri.toString(), collectionId: null, order: 0 };

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'global' });

    assert.deepStrictEqual(fakes.calls, ['reveal'], 'a file is never "addable", so it always just reveals');
    assert.deepStrictEqual(fakes.revealedUris, [outsideUri.toString()]);
  });

  test('reveals a workspace-scoped folder item without prompting, regardless of workspace-folder membership', async () => {
    // Deliberately outside every fixture workspace folder — proves the no-prompt behavior here
    // comes from scope (not global), not from the folder happening to already be inside the
    // workspace.
    const fakes = makeRevealFakes({ folders: undefined });
    const item: BookmarkItem = { id: '3', type: 'folder', uri: outsideUri.toString(), collectionId: null, order: 0 };

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'workspace' });

    assert.deepStrictEqual(fakes.calls, ['reveal']);
    assert.deepStrictEqual(fakes.revealedUris, [outsideUri.toString()]);
  });

  test('reveals a global folder item that is already inside the workspace without prompting', async () => {
    const root = vscode.Uri.file('/workspace/project');
    const folders = [folder(root)];
    const descendantUri = vscode.Uri.file('/workspace/project/subfolder');
    assert.strictEqual(
      isInsideWorkspace(descendantUri, folders),
      true,
      'fixture precondition: the descendant uri must actually be inside these folders'
    );
    const fakes = makeRevealFakes({ folders });

    await createRevealHandler(fakes.deps)({ kind: 'item', item: folderItem(descendantUri), scope: 'global' });

    assert.deepStrictEqual(fakes.calls, ['reveal'], 'an already-in-workspace global folder is not "addable"');
    assert.deepStrictEqual(fakes.revealedUris, [descendantUri.toString()]);
  });

  test(
    'prompts with the Add-to-Workspace and Open-in-New-Window actions for an addable global ' +
      'folder outside the workspace, and does not reveal',
    async () => {
      const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: undefined });

      await createRevealHandler(fakes.deps)({
        kind: 'item',
        item: folderItem(outsideUri),
        scope: 'global'
      });

      assert.strictEqual(fakes.promptCalls.length, 1, 'exactly one action prompt must be shown');
      const { message, actions } = fakes.promptCalls[0];
      assert.ok(message.length > 0, 'the prompt message must not be empty');
      assert.deepStrictEqual(
        actions,
        [ADD_TO_WORKSPACE_LABEL, OPEN_IN_NEW_WINDOW_LABEL],
        'the two offered actions must be exactly the Add-to-Workspace and Open-in-New-Window labels, in that order'
      );
      assert.strictEqual(fakes.revealedUris.length, 0, 'reveal must never be called for an addable global folder');
    }
  );

  test('the same addable-global-folder condition also applies when the folder list is empty ([])', async () => {
    const fakes = makeRevealFakes({ folders: [], actionPromptResult: undefined });

    await createRevealHandler(fakes.deps)({ kind: 'item', item: folderItem(outsideUri), scope: 'global' });

    assert.strictEqual(fakes.promptCalls.length, 1);
    assert.strictEqual(fakes.revealedUris.length, 0);
  });

  test('picking Add to Workspace calls addToWorkspace with the node and calls neither openInNewWindow nor reveal', async () => {
    const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: ADD_TO_WORKSPACE_LABEL });
    const node: BookmarkNode = { kind: 'item', item: folderItem(outsideUri), scope: 'global' };

    await createRevealHandler(fakes.deps)(node);

    assert.deepStrictEqual(fakes.calls, ['prompt', 'addToWorkspace']);
    assert.deepStrictEqual(fakes.addToWorkspaceCalls, [node]);
    assert.strictEqual(fakes.openInNewWindowUris.length, 0);
    assert.strictEqual(fakes.revealedUris.length, 0);
  });

  test('picking Open in New Window calls openInNewWindow with the parsed uri and calls neither addToWorkspace nor reveal', async () => {
    const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: OPEN_IN_NEW_WINDOW_LABEL });
    const item = folderItem(outsideUri);

    await createRevealHandler(fakes.deps)({ kind: 'item', item, scope: 'global' });

    assert.deepStrictEqual(fakes.calls, ['prompt', 'openInNewWindow']);
    assert.deepStrictEqual(fakes.openInNewWindowUris, [outsideUri.toString()]);
    assert.strictEqual(fakes.addToWorkspaceCalls.length, 0);
    assert.strictEqual(fakes.revealedUris.length, 0);
  });

  test('dismissing the action prompt (undefined) does nothing further', async () => {
    const fakes = makeRevealFakes({ folders: undefined, actionPromptResult: undefined });

    await createRevealHandler(fakes.deps)({
      kind: 'item',
      item: folderItem(outsideUri),
      scope: 'global'
    });

    assert.deepStrictEqual(
      fakes.calls,
      ['prompt'],
      'dismissing the prompt must not call addToWorkspace, openInNewWindow, or reveal'
    );
  });

  test('the exported action labels are the user-visible strings the prompt must offer', () => {
    // Pins the label *values*, not just their names — the branch tests above only prove the
    // prompt is offered `[ADD_TO_WORKSPACE_LABEL, OPEN_IN_NEW_WINDOW_LABEL]` and route on
    // whichever string each constant happens to hold, which is satisfied no matter what those
    // constants are set to. This is the one assertion in the suite that pins the actual spec text.
    assert.strictEqual(ADD_TO_WORKSPACE_LABEL, 'Add to Workspace');
    assert.strictEqual(OPEN_IN_NEW_WINDOW_LABEL, 'Open in New Window');
  });
});

// --- #95 R4: regression guards for the widened BookmarkNode union — createRemoveHandler and
// createRevealHandler must keep treating a 'suggestion' node exactly like any other non-'item'
// node (a no-op), the same way both already handle 'collection' / 'repoGroup' / 'globalRoot'
// throughout this file. Built with `as unknown as BookmarkNode` so this file compiles against
// both today's four-arm union and the widened one from T5 (plan docs/superpowers/plans/2026-08-25-
// suggested-bookmarks-from-recent-items.md) — these prove today's `node.kind !== 'item'` guards
// already cover the new kind, rather than being expected to start red.
suite('commands - suggestion-kind regression guards (#95 R4)', () => {
  function suggestionNode(uri = 'file:///suggested.txt'): BookmarkNode {
    return {
      kind: 'suggestion',
      recentItem: { uri, firstSeen: 1000, previewCount: 0, promoted: true }
    } as unknown as BookmarkNode;
  }

  test('remove handler ignores a suggestion node', async () => {
    const stores = makeScopedStores();
    await stores.workspace.addItem({ type: 'file', uri: 'file:///a.txt' });
    const handler = createRemoveHandler(stores);

    await handler(suggestionNode());

    assert.strictEqual(stores.workspace.getAll().items.length, 1, 'a suggestion node must not remove anything');
  });

  test('reveal handler ignores a suggestion node', async () => {
    const fakes = makeRevealFakes();
    await createRevealHandler(fakes.deps)(suggestionNode());
    assert.deepStrictEqual(
      fakes.calls,
      [],
      'a suggestion node must not reveal, prompt, addToWorkspace, or openInNewWindow'
    );
  });
});

// --- #95 T6: bookmarks.promoteSuggestion — routes through the exact same addBookmark() helper
// every other add path uses (commands.ts:47-61), so DuplicateBookmarkError produces the identical
// "already bookmarked" info toast. Promoting removes the item from the Suggested list on the next
// render because it becomes bookmarked and C7/D9's either-store filter then excludes it — that
// filter is exercised directly in bookmarksTreeDataProvider.test.ts ("excludes a uri already
// bookmarked ..."); this suite only proves the store write and duplicate-handling contract of the
// command itself.
//
// Assumption (not pinned by the plan, which leaves the exact signature to implementation time):
// `createPromoteSuggestionHandler` is bound to a single (workspace) store, mirroring
// `createAddFileHandler`'s shape — the same store `bookmarks.addFile` targets — rather than a
// `ScopedStores` bag, since a recent-item has no scope of its own to route on.
suite('commands - promoteSuggestion (#95 T6)', () => {
  function suggestionNode(uri: string): BookmarkNode {
    return {
      kind: 'suggestion',
      recentItem: { uri, firstSeen: 1000, previewCount: 0, promoted: true }
    } as unknown as BookmarkNode;
  }

  test('adds the suggested uri as a file bookmark to the workspace store', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///suggested-a.txt';

    await createPromoteSuggestionHandler(store, makePrompter())(suggestionNode(uri));

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'file');
    assert.strictEqual(items[0].uri, uri);
  });

  test('shows the same "already bookmarked" info message as every other add path on a duplicate', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///suggested-a.txt';
    await store.addItem({ type: 'file', uri });
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });

    await createPromoteSuggestionHandler(store, prompter)(suggestionNode(uri));

    assert.strictEqual(
      store.getAll().items.length,
      1,
      'promoting an already-bookmarked uri must not create a duplicate'
    );
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('ignores non-suggestion nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const nonSuggestionNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };

    await createPromoteSuggestionHandler(store, makePrompter())(nonSuggestionNode);

    assert.strictEqual(store.getAll().items.length, 0, 'a non-suggestion node must not add anything');
  });
});

// --- #108: bookmarks promote-from-Recent — mirrors createPromoteSuggestionHandler exactly in
// shape: routed through the same addBookmark() helper (commands.ts) so DuplicateBookmarkError
// produces the identical "already bookmarked" info toast. Workspace-scoped, same as
// promoteSuggestion, since a recentItem node has no scope of its own to route on.
//
// `createPromoteRecentItemHandler` does not exist yet — this suite is expected to fail to compile
// until it is added.
suite('commands - promoteRecentItem (#108)', () => {
  function recentItemNode(uri: string): BookmarkNode {
    return { kind: 'recentItem', uri } as unknown as BookmarkNode;
  }

  test('adds the recent uri as a file bookmark to the workspace store', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///recent-a.txt';

    await createPromoteRecentItemHandler(store, makePrompter())(recentItemNode(uri));

    const items = store.getAll().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, 'file');
    assert.strictEqual(items[0].uri, uri);
  });

  test('shows the same "already bookmarked" info message as every other add path on a duplicate', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const uri = 'file:///recent-a.txt';
    await store.addItem({ type: 'file', uri });
    const messages: string[] = [];
    const prompter = makePrompter({
      showInfo: async (message) => {
        messages.push(message);
      }
    });

    await createPromoteRecentItemHandler(store, prompter)(recentItemNode(uri));

    assert.strictEqual(
      store.getAll().items.length,
      1,
      'promoting an already-bookmarked recent uri must not create a duplicate'
    );
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /already bookmarked/i);
  });

  test('ignores non-recentItem nodes', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const nonRecentItemNode: BookmarkNode = { kind: 'repoGroup', label: 'x', repoKey: 'x' };

    await createPromoteRecentItemHandler(store, makePrompter())(nonRecentItemNode);

    assert.strictEqual(store.getAll().items.length, 0, 'a non-recentItem node must not add anything');
  });

  test('ignores a suggestion node too (only recentItem nodes are promoted by this handler)', async () => {
    const store = new BookmarkStore(new FakeMemento());
    const suggestionNode: BookmarkNode = {
      kind: 'suggestion',
      recentItem: { uri: 'file:///suggested.txt', firstSeen: 1000, previewCount: 0, promoted: true }
    } as unknown as BookmarkNode;

    await createPromoteRecentItemHandler(store, makePrompter())(suggestionNode);

    assert.strictEqual(store.getAll().items.length, 0);
  });
});
