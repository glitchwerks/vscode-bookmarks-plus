# Multi-root Workspace Partitioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the window-wide workspace bookmark store with stable root partitions, lossless legacy migration, explicit detached-root recovery, and one isolated mirror per attached root.

**Architecture:** A new atomic `bookmarks.workspacePartitions` snapshot owns all workspace partitions and Unassigned content. Pure URI and migration modules feed a partition-aware workspace store; a separate coordinator binds one existing-shape mirror to each attached partition. Global bookmarks continue using the existing `BookmarkStore` unchanged.

**Tech Stack:** TypeScript 5.4, VS Code Extension API 1.101, Node.js 20 APIs, Mocha TDD tests running in `@vscode/test-electron`, esbuild, ESLint. (`package.json:L12`; `package.json:L127-L159`)

**Spec:** `docs/superpowers/specs/2026-09-07-multi-root-workspace-partitioning-design.md`

## Global Constraints

- Issue #62 is the delivery boundary; #129 and #138 remain out of scope. (#62; spec §§1-3, 16)
- Store the entire workspace model under one `bookmarks.workspacePartitions` Memento key; retain `bookmarks.data` unchanged for Global. (spec §5.1; `src/extension.ts:L439-L444`)
- Every workspace mutation resolves within an explicit owner; no cross-owner lookup, drag, move, or implicit merge is permitted. (spec §7)
- One canonical URI implementation governs root equality, containment, migration, recovery, mirror validation, and future MCP validation. (spec §6; #62)
- Existing ownership never changes because roots are added, nested, or reordered. (spec §§7, 9; #62)
- Unassigned and Detached data remain lossless and have no mirror. (spec §§10, 12; #62)
- The per-root mirror payload remains schema-v2 `BookmarkData`; it contains no partition metadata. (spec §12; `src/types.ts:L19-L28`)
- A malformed partition snapshot is preserved, workspace mutations and mirrors are disabled, and Global remains usable. (spec §14)
- Migration and recovery publish no partial workspace state. (spec §§8, 11, 14)
- Logs contain counts and error categories, never bookmark content or MCP descriptor data. (spec §§8, 14; #62)
- Preserve the existing line-ending configuration; do not add line-ending overrides.
- Do not stage this plan file until Task 9, after every source and test path named by the plan exists in `HEAD`.

---

## File map

| File | Responsibility |
|---|---|
| `src/rootUri.ts` | Canonical root identities, component containment, deepest-root selection, collision detection, and prefix rebasing |
| `src/workspacePartitionTypes.ts` | Snapshot types, owner references, strict validation, invariant checks, and empty factories |
| `src/workspacePartitionMigration.ts` | Pure legacy splitting plus crash-safe Memento migration orchestration |
| `src/workspaceBookmarkStore.ts` | Atomic partition-aware reads, CRUD, lifecycle reconciliation, recovery planning, and recovery commit |
| `src/workspaceMirrorCoordinator.ts` | Per-partition mirror queues, hashes, dirty state, external validation, watcher bindings, and failure isolation |
| `src/mcpServerProvider.ts` | Preserve the single-root definition and expose one explicitly labeled mirror server per root in multi-root windows |
| `src/bookmarkStore.ts` | Keep Global behavior; export the small read/change interface shared by consumers |
| `src/workspaceFolders.ts` | Delegate existing containment and relative-path behavior to the canonical root URI module |
| `src/bookmarksTreeDataProvider.ts` | Render attached roots, Unassigned, Detached, diagnostics, and partition-carrying nodes |
| `src/commands.ts` | Route workspace commands by owner and implement root selection plus recovery UX |
| `src/extension.ts` | Asynchronous workspace-store initialization and lifecycle/mirror wiring |
| `src/bookmarkDecorationProvider.ts` | Accept the common read/change interface without changing decoration semantics |
| `src/bookmarkContextKeys.ts` | Accept the common read/change interface without changing context-key semantics |
| `src/test/suite/*.test.ts` | Boundary-focused TDD tests and activation integration coverage |
| `src/test/suite/fixtures.ts` | Failure-capable Memento, mirror, watcher, and filesystem fakes |
| `package.json` | Recovery command and Detached context-menu contribution |
| `README.md` | User-visible partition, mirror, Unassigned, Detached, and recovery behavior |

The split follows the approved component boundaries in spec §13. Existing mirror I/O stays behind
`MirrorPort` (`src/bookmarkMirror.ts:L46-L90`), and existing consumers currently depend directly on
`BookmarkStore` (`src/bookmarksTreeDataProvider.ts:L72-L92`; `src/commands.ts:L25-L28`).

### Test-fixture contracts

Helper names used in the test snippets below are test-local builders, not production APIs. Implement
them in the listed test file with these exact states:

| Helper | Required state |
|---|---|
| `deterministicIds()` | Closure returning sequential valid UUID strings with incrementing final 12 hexadecimal digits |
| `roots()` | Root candidates `{ id: 'a', label: 'A', uri: file:///a }` and `{ id: 'b', label: 'B', uri: file:///b }`, in that order |
| `legacyData()` | Schema-v2 data with one ungrouped item at `file:///a/ungrouped.ts` |
| `mixedLegacyData()` | Schema-v2 data with one collection containing items at `file:///a/a.ts`, `file:///b/b.ts`, and `file:///outside.ts`; one unmatched-only collection; one empty collection; and one ungrouped root-A item |
| `allIds(snapshot)` | Flat array of every partition, collection, and item ID, including Unassigned |
| `readyStore()` | Two attached empty partitions for `file:///a` and `file:///b`, both replacement-eligible, returned with owners and the backing `FakeMemento` |
| `readyStoreWithItems()` | `readyStore()` with one fixed item in each partition |
| `replacementEligibleStore()` | One attached empty root-A partition whose `replacementEligible` is `true` |
| `parentStoreWithNestedItem()` | Attached `file:///work` partition containing item `file:///work/child/a.ts` |
| `singleRootStore()` | One established attached `file:///work` partition |
| `storeWithDuplicateDetachedIdentities()` | Two detached partitions whose canonical last-known identity is `file:///work` |
| `salvageStore(options)` | Detached old root `file:///old/repo`, eligible destination `file:///new/repo`, and three items: resolving `src/a.ts`, missing `src/missing.ts`, and incompatible `file:///elsewhere/kept.ts`; fake `stat` succeeds only for `options.existing` |
| `establishedDestinationStore()` | Detached old-root partition plus a destination partition with `replacementEligible: false`; return `beforeView` as `JSON.stringify(store.getView())` |
| `twoRootCoordinator()` | Workspace store with one item in each of attached roots A/B, one fake mirror resource per root, and exposed partition/owner IDs |
| `mirrorJson(items)` | Serialized schema-v2 `BookmarkData` with supplied items normalized to `type: 'file'`, `collectionId: null`, contiguous order, and no collections |
| `partition(id, label, data)` | Attached partition view using `file:///${id}`, supplied label, supplied data or empty schema-v2 data |
| `oneItem()` | Schema-v2 data containing one ungrouped file bookmark and no collections |
| `workspaceView(overrides)` | Ready `WorkspaceStoreView` with empty defaults merged with the supplied overrides |
| `unavailableWorkspaceView()` | `WorkspaceStoreView` with `kind: 'unavailable'`, reason `malformed-snapshot`, and no content |
| `providerFor(view)` | Tree provider backed by a workspace reader returning `view`, an empty Global store, and deterministic cache misses |
| `dragTransferFor(envelope)` | `vscode.DataTransfer` containing `envelope` under `DND_MIME_TYPE` |
| `collectionNodeFor(partitionId)` | Workspace collection node owned by the named partition |
| `cancellationToken()` | A fresh `vscode.CancellationTokenSource().token` used only for the call |
| `recordedWorkspaceMoves()` | Array captured by the provider fixture's workspace `moveItem` spy |
| `commandFixture()` | Workspace command spy with owners A/B and one item in B; record every mutation argument |
| `workspaceItemNode(owner, item)` | `{ kind: 'item', scope: 'workspace', owner, item }` |
| `multiRootCollectionFixture(options)` | Two attached roots, quick-pick result from `options.selectedPartitionId`, input result from `options.name`, and an `addCollection` spy |
| `crossOwnerMoveFixture()` | Root-A item node, only a root-B collection offered by the injected test seam, and a workspace `moveItem` spy |
| `recoveryCommandFixture(options)` | One detached partition, one eligible destination, preview `{ token: 'recovery-token', resolving: 1, missing: 2, incompatible: 1 }`, prompts driven by `options`, and a `commitRecovery` spy |
| `activationFixture(options)` | Fake extension context, injected roots/events/mirror resource factory, exposed stores/provider, optional malformed workspace snapshot, and optional Global item |

Do not export these builders from production modules. Their exact return types are inferred from the
production interfaces established in the corresponding task.

---

### Task 1: Canonical root URI primitives

**Files:**
- Create: `src/rootUri.ts`
- Create: `src/test/suite/rootUri.test.ts`
- Modify: `src/workspaceFolders.ts:3-94`
- Modify: `src/test/suite/workspaceFolders.test.ts:14-185`

**Interfaces:**
- Consumes: `vscode.Uri`, `vscode.WorkspaceFolder`.
- Produces:

```ts
export interface RootCandidate {
  readonly id: string;
  readonly label: string;
  readonly uri: vscode.Uri;
}

export interface RootMatch extends RootCandidate {
  readonly canonicalUri: string;
}

export interface RebaseResult {
  readonly kind: 'rebased' | 'outside-old-root' | 'incompatible-uri';
  readonly uri?: vscode.Uri;
}

export class InvalidRootUriError extends Error {}

export function canonicalizeRootUri(uri: vscode.Uri): string;
export function isUriInsideRoot(uri: vscode.Uri, root: vscode.Uri): boolean;
export function findDeepestRoot(uri: vscode.Uri, roots: readonly RootCandidate[]): RootMatch | undefined;
export function findCanonicalRootCollisions(roots: readonly RootCandidate[]): ReadonlyMap<string, readonly RootCandidate[]>;
export function rebaseUri(uri: vscode.Uri, oldRoot: vscode.Uri, newRoot: vscode.Uri): RebaseResult;
export function toRootCandidates(
  folders: readonly vscode.WorkspaceFolder[] | undefined
): readonly RootCandidate[];
```

Implements spec §6 and preserves the existing order-independent deepest-root behavior documented in
`src/workspaceFolders.ts:L72-L94`.

- [ ] **Step 1: Write failing canonicalization and containment tests**

Create table-driven tests that pin every identity rule:

```ts
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

  test('rejects query and fragment root identities', () => {
    assert.throws(() => canonicalizeRootUri(vscode.Uri.parse('file:///repo?x=1')));
    assert.throws(() => canonicalizeRootUri(vscode.Uri.parse('file:///repo#part')));
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

  test('reports canonical collisions instead of using array order', () => {
    const collisions = findCanonicalRootCollisions([
      { id: 'a', label: 'A', uri: vscode.Uri.parse('file:///work/repo') },
      { id: 'b', label: 'B', uri: vscode.Uri.parse('FILE:///work/repo/') }
    ]);
    assert.deepStrictEqual([...collisions.values()].map((group) => group.map((root) => root.id)), [['a', 'b']]);
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
});
```

- [ ] **Step 2: Compile to verify the new module is missing**

Run: `npm run compile-tests`

Expected: FAIL because `../../rootUri` and its exports do not exist.

- [ ] **Step 3: Implement canonical structural operations**

Use VS Code's already-decoded path components without decoding percent-like literal names again.
Remove only non-root trailing separators, preserve interior empty components and path case (except
the Windows file drive letter), compare complete components, and retain relative paths when rebasing.
Serialize each path component with URI-safe escaping while preserving structural separators and the
established `file:///c:/...` drive-colon spelling. Require canonical parse/serialization idempotence
and distinct identities for literal `%61`, `%7e`, `%2F`, spaces, `#`, and `?` names.
(`src/test/suite/rootUri.test.ts:L22-L34`; `src/test/suite/rootUri.test.ts:L106-L143`)

Build `canonicalizeRootUri`, `findDeepestRoot`, collision grouping, and `rebaseUri` only from this
structural representation. Throw a descriptive `InvalidRootUriError` for a relative root, query, or
fragment.

- [ ] **Step 4: Delegate old workspace helpers to the new primitives**

Keep the public functions used elsewhere, but eliminate their separate case-folding algorithm:

```ts
export function isInsideWorkspace(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[] | undefined
): boolean {
  return findDeepestRoot(
    uri,
    (folders ?? []).map((folder, index) => ({
      id: `${index}:${folder.uri.toString(true)}`,
      label: folder.name,
      uri: folder.uri
    }))
  ) !== undefined;
}
```

Update `getWorkspaceRelativePath` to select the `findDeepestRoot` result and slice path components
without changing their case. Replace the old path-case tests with the spec's case-preserving
expectations while retaining multi-root and segment-boundary coverage.

- [ ] **Step 5: Run the root and regression tests**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including `rootUri` and `workspaceFolders`.

- [ ] **Step 6: Commit**

```bash
git add src/rootUri.ts src/workspaceFolders.ts src/test/suite/rootUri.test.ts src/test/suite/workspaceFolders.test.ts
git commit -m "feat: add canonical workspace root identity"
```

---

### Task 2: Partition snapshot types and invariants

**Files:**
- Create: `src/workspacePartitionTypes.ts`
- Create: `src/test/suite/workspacePartitionTypes.test.ts`

**Interfaces:**
- Consumes: `BookmarkData`, `emptyBookmarkData`, `isStrictBookmarkData`, `canonicalizeRootUri`.
- Produces:

```ts
export const WORKSPACE_PARTITION_STORAGE_KEY = 'bookmarks.workspacePartitions';
export const WORKSPACE_PARTITION_SCHEMA_VERSION = 1;

export type WorkspaceOwnerRef =
  | { readonly kind: 'partition'; readonly partitionId: string }
  | { readonly kind: 'unassigned' };

export interface WorkspacePartitionSnapshot {
  version: 1;
  partitions: WorkspacePartition[];
  unassigned: BookmarkData;
}

export interface WorkspacePartition {
  id: string;
  attachment: {
    rootUri: string;
    canonicalRootUri: string;
  } | null;
  lastKnownRootUri: string;
  canonicalLastKnownRootUri: string;
  replacementEligible: boolean;
  data: BookmarkData;
  mirror: {
    lastSuccessfulHash?: string;
    dirty: boolean;
  };
}
export interface SnapshotValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function emptyWorkspacePartitionSnapshot(): WorkspacePartitionSnapshot;
export function validateWorkspacePartitionSnapshot(value: unknown): SnapshotValidationResult;
export function cloneWorkspacePartitionSnapshot(value: WorkspacePartitionSnapshot): WorkspacePartitionSnapshot;
export function ownerKey(owner: WorkspaceOwnerRef): string;
```

Implements spec §§5.1 and 14.

- [ ] **Step 1: Write failing strict-validation tests**

```ts
import * as assert from 'assert';
import {
  emptyWorkspacePartitionSnapshot,
  validateWorkspacePartitionSnapshot
} from '../../workspacePartitionTypes';

suite('workspacePartitionTypes', () => {
  test('accepts the empty current snapshot', () => {
    assert.deepStrictEqual(validateWorkspacePartitionSnapshot(emptyWorkspacePartitionSnapshot()), { ok: true });
  });

  for (const [name, mutate] of [
    ['future outer version', (value: any) => { value.version = 2; }],
    ['duplicate partition id', (value: any) => { value.partitions.push(value.partitions[0]); }],
    ['duplicate item id across owners', (value: any) => {
      value.unassigned.items.push({ ...value.partitions[0].data.items[0] });
    }],
    ['cross-owner collection reference', (value: any) => {
      value.partitions[0].data.items[0].collectionId = value.unassigned.collections[0].id;
    }]
  ] as const) {
    test(`rejects ${name}`, () => {
      const value: any = seededSnapshot();
      mutate(value);
      assert.strictEqual(validateWorkspacePartitionSnapshot(value).ok, false);
    });
  }
});
```

Define the test-local `seededSnapshot(): WorkspacePartitionSnapshot` helper with one attached
partition, one item and collection, plus one Unassigned item and collection. Use these fixed IDs so
the duplicate tests are deterministic:

```ts
const PARTITION_ID = '10000000-0000-4000-8000-000000000001';
const PARTITION_COLLECTION_ID = '20000000-0000-4000-8000-000000000001';
const PARTITION_ITEM_ID = '30000000-0000-4000-8000-000000000001';
const UNASSIGNED_COLLECTION_ID = '20000000-0000-4000-8000-000000000002';
const UNASSIGNED_ITEM_ID = '30000000-0000-4000-8000-000000000002';
```

- [ ] **Step 2: Compile to verify the type module is missing**

Run: `npm run compile-tests`

Expected: FAIL because `../../workspacePartitionTypes` does not exist.

- [ ] **Step 3: Implement the snapshot model and whole-snapshot validator**

Use the exact persisted structure from spec §5.1. The validator must check:

```ts
function validateOwnerData(data: unknown, allIds: Set<string>): string | undefined {
  if (!isStrictBookmarkData(data)) return 'owner content is malformed';
  const collectionIds = new Set(data.collections.map((collection) => collection.id));
  for (const collection of data.collections) {
    if (allIds.has(collection.id)) return 'identifier is duplicated across owners';
    allIds.add(collection.id);
  }
  for (const item of data.items) {
    if (allIds.has(item.id)) return 'identifier is duplicated across owners';
    allIds.add(item.id);
    if (item.collectionId !== null && !collectionIds.has(item.collectionId)) {
      return 'item references a collection outside its owner';
    }
  }
  return undefined;
}
```

Also validate UUID format for every partition/item/collection ID, attachment/null shape, canonical
metadata, last-known URI, boolean mirror fields, unique partition IDs, and current outer version.
Return redacted reason categories only.

- [ ] **Step 4: Run tests**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including malformed owner, duplicate ID, and cross-owner reference cases.

- [ ] **Step 5: Commit**

```bash
git add src/workspacePartitionTypes.ts src/test/suite/workspacePartitionTypes.test.ts
git commit -m "feat: define workspace partition snapshot"
```

---

### Task 3: Lossless legacy migration

**Files:**
- Create: `src/workspacePartitionMigration.ts`
- Create: `src/test/suite/workspacePartitionMigration.test.ts`
- Modify: `src/test/suite/fixtures.ts:5-47`

**Interfaces:**
- Consumes: `migrateBookmarkData`, `normalizeBookmarkData`, `findDeepestRoot`, partition factories.
- Produces:

```ts
export interface PartitionMigrationDiagnostics {
  readonly sourceItems: number;
  readonly sourceCollections: number;
  readonly partitions: number;
  readonly splitCollections: number;
  readonly unassignedItems: number;
  readonly unassignedCollections: number;
}

export interface LoadedWorkspaceSnapshot {
  readonly kind: 'ready';
  readonly snapshot: WorkspacePartitionSnapshot;
  readonly diagnostics?: PartitionMigrationDiagnostics;
}

export interface UnavailableWorkspaceSnapshot {
  readonly kind: 'unavailable';
  readonly reason: string;
}

export function partitionLegacyData(
  data: BookmarkData,
  roots: readonly RootCandidate[],
  createId: () => string
): { snapshot: WorkspacePartitionSnapshot; diagnostics: PartitionMigrationDiagnostics };

export async function loadOrMigrateWorkspaceSnapshot(
  state: vscode.Memento,
  roots: readonly RootCandidate[],
  createId: () => string,
  output: OutputSink
): Promise<LoadedWorkspaceSnapshot | UnavailableWorkspaceSnapshot>;
```

Implements spec §§8 and 14. Existing content migrations reject unsupported future versions
(`src/migrations.ts:L27-L47`).

- [ ] **Step 1: Extend the Memento fake with deterministic failures**

Add keyed failure controls without changing existing tests:

```ts
failUpdateForKey: string | undefined;

update(key: string, value: unknown): Thenable<void> {
  if (this.failUpdateForKey === key) {
    this.failUpdateForKey = undefined;
    return Promise.reject(new Error(`simulated update failure: ${key}`));
  }
  if (value === undefined) {
    this.store.delete(key);
  } else {
    this.store.set(key, value);
  }
  this.updateCallCount++;
  return Promise.resolve();
}
```

- [ ] **Step 2: Write failing split and persistence-order tests**

```ts
suite('workspacePartitionMigration', () => {
  test('splits a mixed collection and preserves unmatched data', () => {
    const result = partitionLegacyData(mixedLegacyData(), roots(), deterministicIds());
    assert.deepStrictEqual(result.snapshot.partitions.map((partition) => partition.data.items.length), [1, 1]);
    assert.strictEqual(result.snapshot.unassigned.items.length, 1);
    assert.strictEqual(result.snapshot.unassigned.collections.length, 2);
    assert.strictEqual(result.diagnostics.splitCollections, 1);
    assert.strictEqual(new Set(allIds(result.snapshot)).size, allIds(result.snapshot).length);
  });

  test('does not delete legacy state when the new snapshot write fails', async () => {
    const state = new FakeMemento({ 'bookmarks.data': legacyData() });
    state.failUpdateForKey = WORKSPACE_PARTITION_STORAGE_KEY;
    await assert.rejects(loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), new FakeOutput()));
    assert.deepStrictEqual(state.get('bookmarks.data'), legacyData());
    assert.strictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), undefined);
  });

  test('uses the new snapshot after legacy cleanup failure', async () => {
    const state = new FakeMemento({ 'bookmarks.data': legacyData() });
    state.failUpdateForKey = 'bookmarks.data';
    await assert.rejects(loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), new FakeOutput()));
    const persisted = state.get(WORKSPACE_PARTITION_STORAGE_KEY);
    const retried = await loadOrMigrateWorkspaceSnapshot(state, roots(), deterministicIds(), new FakeOutput());
    assert.strictEqual(retried.kind, 'ready');
    assert.deepStrictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), persisted);
  });
});
```

Fixtures must include a collection spanning root A, root B, and unmatched data, one unmatched-only
collection, one empty collection, and one ungrouped item.

- [ ] **Step 3: Compile and run to verify failure**

Run: `npm run compile-tests`

Expected: FAIL because the migration module does not exist.

- [ ] **Step 4: Implement pure splitting and ordered persistence**

For each source collection, group member items by `ownerKey`; allocate a new collection ID per
represented owner; preserve source metadata and relative order; bind only that group's items.
Preserve an existing item ID only when it is a valid UUID and unique across the output; otherwise
allocate a replacement. Always allocate distinct UUIDs for split collection copies and rebind member
items to the correct copy.
Persist in this order:

```ts
await state.update(WORKSPACE_PARTITION_STORAGE_KEY, snapshot);
try {
  await state.update('bookmarks.data', undefined);
} catch (error: unknown) {
  output.appendLine('Workspace partition migration: legacy cleanup failed after snapshot commit.');
  throw error;
}
```

On the next load, validate and prefer the new snapshot before inspecting the legacy key. Log only
the fields from `PartitionMigrationDiagnostics`.

- [ ] **Step 5: Run tests**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including split, empty collection, unmatched, idempotent retry, new-write
failure, and cleanup-failure cases.

- [ ] **Step 6: Commit**

```bash
git add src/workspacePartitionMigration.ts src/test/suite/workspacePartitionMigration.test.ts src/test/suite/fixtures.ts
git commit -m "feat: migrate legacy workspace bookmarks into partitions"
```

---

### Task 4: Atomic partition-aware workspace store

**Files:**
- Create: `src/workspaceBookmarkStore.ts`
- Create: `src/test/suite/workspaceBookmarkStore.test.ts`
- Modify: `src/bookmarkStore.ts:23-251`

**Interfaces:**
- Consumes: loaded snapshot, canonical root matching, existing bookmark normalization semantics.
- Produces:

```ts
export interface BookmarkContentReader {
  readonly onBookmarksChanged: vscode.Event<void>;
  getAll(): BookmarkData;
}

export interface WorkspaceBookmarkStoreOptions {
  readonly state: vscode.Memento;
  readonly roots: readonly RootCandidate[];
  readonly output: OutputSink;
  readonly createId?: () => string;
}

export interface AttachedPartitionView {
  readonly partitionId: string;
  readonly label: string;
  readonly rootUri: string;
  readonly canonicalRootUri: string;
  readonly replacementEligible: boolean;
  readonly data: BookmarkData;
}

export interface DetachedPartitionView {
  readonly partitionId: string;
  readonly lastKnownRootUri: string;
  readonly canonicalLastKnownRootUri: string;
  readonly replacementEligible: boolean;
  readonly data: BookmarkData;
}

export interface WorkspaceStoreView {
  readonly kind: 'ready' | 'unavailable';
  readonly attached: readonly AttachedPartitionView[];
  readonly detached: readonly DetachedPartitionView[];
  readonly unassigned: BookmarkData;
  readonly unavailableRoots: readonly string[];
  readonly reason?: string;
}

export class PartitionBoundaryError extends Error {}
export class WorkspaceSnapshotInvariantError extends Error {}
export class WorkspaceDataUnavailableError extends Error {}

export class WorkspaceBookmarkStore implements BookmarkContentReader, vscode.Disposable {
  static create(options: WorkspaceBookmarkStoreOptions): Promise<WorkspaceBookmarkStore>;
  getAll(): BookmarkData;
  getView(): WorkspaceStoreView;
  getOwnerData(owner: WorkspaceOwnerRef): BookmarkData | undefined;
  findItemsByUri(uri: vscode.Uri): readonly { owner: WorkspaceOwnerRef; item: BookmarkItem }[];
  resolveAttachedOwner(uri: vscode.Uri): WorkspaceOwnerRef | undefined;
  addItem(owner: WorkspaceOwnerRef, input: AddItemInput): Promise<BookmarkItem>;
  removeItem(owner: WorkspaceOwnerRef, id: string): Promise<void>;
  addCollection(owner: WorkspaceOwnerRef, name: string): Promise<BookmarkCollection>;
  moveItem(owner: WorkspaceOwnerRef, id: string, collectionId: string | null, index: number): Promise<void>;
  renameCollection(owner: WorkspaceOwnerRef, id: string, name: string): Promise<void>;
  setItemDescription(owner: WorkspaceOwnerRef, id: string, description: string | undefined): Promise<void>;
  setCollectionDescription(owner: WorkspaceOwnerRef, id: string, description: string | undefined): Promise<void>;
  deleteCollection(owner: WorkspaceOwnerRef, id: string): Promise<void>;
  dispose(): void;
}
```

Export `BookmarkContentReader` from `bookmarkStore.ts` and have the existing `BookmarkStore`
implement it structurally. This lets decorations and context keys consume either implementation
without changing Global behavior. Implements spec §§5.1, 7, and 14.

- [ ] **Step 1: Write failing owner-isolation and atomicity tests**

```ts
suite('WorkspaceBookmarkStore content operations', () => {
  test('creates only inside the explicit matching attached partition', async () => {
    const { store, state, ownerA, ownerB } = await readyStore();
    const events: number[] = [];
    store.onBookmarksChanged(() => events.push(1));
    const updatesBefore = state.updateCallCount;
    await store.addItem(ownerA, { type: 'file', uri: 'file:///a/src/a.ts' });
    assert.strictEqual(store.getOwnerData(ownerA)?.items.length, 1);
    assert.strictEqual(store.getOwnerData(ownerB)?.items.length, 0);
    assert.strictEqual(state.updateCallCount, updatesBefore + 1);
    assert.strictEqual(events.length, 1);
  });

  test('rejects a cross-root URI without mutation or event', async () => {
    const { store, state, ownerA } = await readyStore();
    const before = state.get(WORKSPACE_PARTITION_STORAGE_KEY);
    let events = 0;
    store.onBookmarksChanged(() => events++);
    await assert.rejects(
      store.addItem(ownerA, { type: 'file', uri: 'file:///b/src/b.ts' }),
      PartitionBoundaryError
    );
    assert.deepStrictEqual(state.get(WORKSPACE_PARTITION_STORAGE_KEY), before);
    assert.strictEqual(events, 0);
  });

  test('looks up ids only inside the selected owner', async () => {
    const { store, ownerA, ownerB, itemA } = await readyStoreWithItems();
    await store.removeItem(ownerB, itemA.id);
    assert.strictEqual(store.getOwnerData(ownerA)?.items.some((item) => item.id === itemA.id), true);
  });

  test('permanently establishes a partition on first content mutation', async () => {
    const { store, ownerA } = await replacementEligibleStore();
    const item = await store.addItem(ownerA, { type: 'file', uri: 'file:///a/a.ts' });
    await store.removeItem(ownerA, item.id);
    assert.strictEqual(store.getView().attached[0].replacementEligible, false);
  });
});
```

- [ ] **Step 2: Compile and run to verify failure**

Run: `npm run compile-tests`

Expected: FAIL because `WorkspaceBookmarkStore`, its options, and boundary errors do not exist.

- [ ] **Step 3: Implement serialized clone-validate-persist-publish mutations**

Use one promise tail for all workspace snapshot changes:

```ts
private enqueue<T>(operation: (draft: WorkspacePartitionSnapshot) => T | Promise<T>): Promise<T> {
  const run = this.operationTail.then(async () => {
    this.assertReady();
    const draft = cloneWorkspacePartitionSnapshot(this.snapshot!);
    const result = await operation(draft);
    const validation = validateWorkspacePartitionSnapshot(draft);
    if (!validation.ok) throw new WorkspaceSnapshotInvariantError(validation.reason!);
    await this.state.update(WORKSPACE_PARTITION_STORAGE_KEY, draft);
    this.snapshot = draft;
    this.revision++;
    this._onBookmarksChanged.fire();
    return result;
  });
  this.operationTail = run.then(() => undefined, () => undefined);
  return run;
}
```

Return defensive clones from reads. Treat an ID absent from the selected owner as a no-op, matching
the existing remove semantics. Reject creates for Unassigned or detached partitions. Reuse the
existing duplicate and ordering behavior from `BookmarkStore` (`src/bookmarkStore.ts:L118-L251`).
`getAll()` returns a transient aggregate containing every attached, detached, and Unassigned item
and collection; it exists only for read-only union consumers and is never persisted or mirrored.
Every local content mutation in an attached partition sets that partition's `mirror.dirty` to `true`
inside the same snapshot write. Successful mirror bookkeeping updates persist metadata without
emitting a bookmark-content event.

- [ ] **Step 4: Implement malformed-state mode**

`WorkspaceBookmarkStore.create` consumes `loadOrMigrateWorkspaceSnapshot`. For an unavailable
result, retain the reason, return `getView().kind === 'unavailable'`, reject every workspace mutation
with `WorkspaceDataUnavailableError`, and never write the workspace Memento.

- [ ] **Step 5: Run tests**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including owner isolation, no-op wrong-owner IDs, permanent establishment,
single-write/single-event atomicity, and malformed-state behavior.

- [ ] **Step 6: Commit**

```bash
git add src/bookmarkStore.ts src/workspaceBookmarkStore.ts src/test/suite/workspaceBookmarkStore.test.ts
git commit -m "feat: add atomic workspace partition store"
```

---

### Task 5: Root lifecycle, recovery preview, and salvage

**Files:**
- Modify: `src/workspaceBookmarkStore.ts`
- Modify: `src/workspacePartitionTypes.ts`
- Modify: `src/test/suite/workspaceBookmarkStore.test.ts`

**Interfaces:**
- Consumes: store mutation queue, root canonicalization, `rebaseUri`.
- Produces:

```ts
export interface RootReconcileResult {
  readonly attachedPartitionIds: readonly string[];
  readonly detachedPartitionIds: readonly string[];
  readonly unavailableCanonicalRoots: readonly string[];
}

export interface PartitionLifecycleChange extends RootReconcileResult {
  readonly currentRoots: readonly RootCandidate[];
}

export type RecoveryMode = 'reattach-only' | 'salvage';

export interface RecoveryPreview {
  readonly token: string;
  readonly detachedPartitionId: string;
  readonly destinationRootUri: string;
  readonly mode: RecoveryMode;
  readonly resolving: number;
  readonly missing: number;
  readonly incompatible: number;
}

export interface RecoveryFileSystem {
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
}

export class RecoveryConflictError extends Error {}
export class StaleRecoveryPreviewError extends Error {}

reconcileRoots(roots: readonly RootCandidate[]): Promise<RootReconcileResult>;
readonly onDidChangePartitions: vscode.Event<PartitionLifecycleChange>;
previewRecovery(
  partitionId: string,
  destination: RootCandidate,
  mode: RecoveryMode,
  fs: RecoveryFileSystem
): Promise<RecoveryPreview>;
commitRecovery(token: string): Promise<void>;
```

Implements spec §§9 and 11.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
test('adding a nested root preserves existing ownership', async () => {
  const { store, parentId, itemId } = await parentStoreWithNestedItem();
  await store.reconcileRoots([
    { id: 'parent-folder', label: 'Work', uri: vscode.Uri.parse('file:///work') },
    { id: 'child-folder', label: 'Child', uri: vscode.Uri.parse('file:///work/child') }
  ]);
  assert.strictEqual(store.getOwnerData({ kind: 'partition', partitionId: parentId })?.items[0].id, itemId);
  assert.strictEqual(store.resolveAttachedOwner(vscode.Uri.parse('file:///work/child/new.ts'))?.kind, 'partition');
  assert.notStrictEqual(
    (store.resolveAttachedOwner(vscode.Uri.parse('file:///work/child/new.ts')) as any).partitionId,
    parentId
  );
});

test('removal detaches and exact return reattaches', async () => {
  const { store, partitionId } = await singleRootStore();
  await store.reconcileRoots([]);
  assert.strictEqual(store.getView().detached[0].partitionId, partitionId);
  await store.reconcileRoots([{ id: 'returning', label: 'Work', uri: vscode.Uri.parse('file:///work') }]);
  assert.strictEqual(store.getView().attached[0].partitionId, partitionId);
});

test('multiple detached identity matches leave the root unavailable', async () => {
  const store = await storeWithDuplicateDetachedIdentities();
  const result = await store.reconcileRoots([{ id: 'returning', label: 'Work', uri: vscode.Uri.parse('file:///work') }]);
  assert.strictEqual(result.unavailableCanonicalRoots.length, 1);
  assert.strictEqual(store.getView().attached.length, 0);
});

test('removal emits one lifecycle change naming the detached partition', async () => {
  const { store, partitionId } = await singleRootStore();
  const changes: PartitionLifecycleChange[] = [];
  store.onDidChangePartitions((change) => changes.push(change));
  await store.reconcileRoots([]);
  assert.deepStrictEqual(changes.map((change) => change.detachedPartitionIds), [[partitionId]]);
});
```

- [ ] **Step 2: Write failing recovery tests**

```ts
test('salvage previews and commits only resolving rebases', async () => {
  const { store, detachedId, destination, fs } = await salvageStore({
    existing: ['file:///new/repo/src/a.ts']
  });
  const preview = await store.previewRecovery(detachedId, destination, 'salvage', fs);
  assert.deepStrictEqual(
    { resolving: preview.resolving, missing: preview.missing, incompatible: preview.incompatible },
    { resolving: 1, missing: 1, incompatible: 1 }
  );
  await store.commitRecovery(preview.token);
  const uris = store.getOwnerData({ kind: 'partition', partitionId: detachedId })!.items.map((item) => item.uri);
  assert.ok(uris.includes('file:///new/repo/src/a.ts'));
  assert.ok(uris.includes('file:///old/repo/src/missing.ts'));
  assert.ok(uris.includes('file:///elsewhere/kept.ts'));
});

test('rejects stale preview and established destination without mutation', async () => {
  const { store, detachedId, destination, fs, beforeView } = await establishedDestinationStore();
  await assert.rejects(store.previewRecovery(detachedId, destination, 'salvage', fs), RecoveryConflictError);
  assert.strictEqual(JSON.stringify(store.getView()), beforeView);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm run compile-tests`

Expected: FAIL because lifecycle and recovery methods are absent.

- [ ] **Step 4: Implement deterministic reconciliation**

Within one queued mutation: calculate collisions, detach missing roots, auto-reattach exactly one
identity match, create replacement-eligible partitions only for unmatched available roots, and leave
ambiguous identities unavailable. Do not move any item or collection during reconciliation. Update
the in-memory current-root labels/order and emit one `onDidChangePartitions` event even when the
persisted ownership snapshot is unchanged; persist and emit one content event only when attachment
metadata actually changes.

- [ ] **Step 5: Implement tokenized recovery**

Store pending recovery drafts in memory with the current store revision:

```ts
interface PendingRecovery {
  readonly revision: number;
  readonly partitionId: string;
  readonly destination: RootCandidate;
  readonly replacementPartitionId?: string;
  readonly rewrites: ReadonlyMap<string, string>;
}
```

`previewRecovery` checks destination eligibility, calls `rebaseUri`, stats each rebased URI, counts
missing/incompatible entries, and records rewrites only for resolving targets. `commitRecovery`
rejects an unknown token or changed revision, then deletes only the eligible replacement partition,
attaches the detached partition, applies recorded rewrites, and persists once.

- [ ] **Step 6: Run tests**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including add/nest/reorder/remove/return, ambiguous identity, reattach-only,
salvage counts, missing/incompatible preservation, eligible replacement, conflict, and stale-token cases.

- [ ] **Step 7: Commit**

```bash
git add src/workspaceBookmarkStore.ts src/workspacePartitionTypes.ts src/test/suite/workspaceBookmarkStore.test.ts
git commit -m "feat: add detached root recovery and salvage"
```

---

### Task 6: Independent per-root mirror coordination

**Files:**
- Create: `src/workspaceMirrorCoordinator.ts`
- Create: `src/test/suite/workspaceMirrorCoordinator.test.ts`
- Modify: `src/bookmarkStore.ts:27-30,57-78,287-527`
- Modify: `src/test/suite/fixtures.ts:120-148`
- Modify: `src/test/suite/bookmarkStore.test.ts`

**Interfaces:**
- Consumes: `WorkspaceBookmarkStore`, `MirrorPort`, mirror hash/serialization, `Delayer`.
- Produces:

```ts
export interface PartitionMirrorResources extends vscode.Disposable {
  readonly port: MirrorPort;
  readonly onDidChange: vscode.Event<void>;
  readonly onDidCreate: vscode.Event<void>;
  readonly onDidDelete: vscode.Event<void>;
}

export interface WorkspaceMirrorCoordinatorOptions {
  readonly store: WorkspaceBookmarkStore;
  readonly output: OutputSink;
  readonly createResources: (root: vscode.Uri) => PartitionMirrorResources;
  readonly writeDelayMs?: number;
}

export class WorkspaceMirrorCoordinator implements vscode.Disposable {
  constructor(options: WorkspaceMirrorCoordinatorOptions);
  reconcileBindings(): Promise<void>;
  handleRootsChanged(roots: readonly RootCandidate[]): Promise<RootReconcileResult>;
  reloadPartition(partitionId: string): Promise<void>;
  flushPartition(partitionId: string): Promise<void>;
  flushAll(): Promise<void>;
  dispose(): void;
}
```

The store adds narrowly scoped mirror methods:

```ts
getMirrorState(partitionId: string): { data: BookmarkData; hash?: string; dirty: boolean } | undefined;
adoptMirrorData(partitionId: string, data: BookmarkData, hash: string, rewriteRequired: boolean): Promise<void>;
recordMirrorWrite(partitionId: string, hash: string): Promise<void>;
recordMirrorDirty(partitionId: string): Promise<void>;
```

Implements spec §12. Current precedence and queue behavior live in
`src/bookmarkStore.ts:L316-L513`; move that responsibility into the partition coordinator and keep
the existing `BookmarkStore` focused on Global content.

- [ ] **Step 1: Extend mirror fixtures with event emitters and disposal state**

```ts
export class FakePartitionMirrorResources implements PartitionMirrorResources {
  readonly change = new vscode.EventEmitter<void>();
  readonly create = new vscode.EventEmitter<void>();
  readonly delete = new vscode.EventEmitter<void>();
  readonly onDidChange = this.change.event;
  readonly onDidCreate = this.create.event;
  readonly onDidDelete = this.delete.event;
  disposed = false;

  constructor(readonly port: FakeMirror) {}

  dispose(): void {
    this.disposed = true;
    this.change.dispose();
    this.create.dispose();
    this.delete.dispose();
  }
}
```

- [ ] **Step 2: Write failing per-root isolation tests**

```ts
suite('WorkspaceMirrorCoordinator', () => {
  test('binds and seeds one mirror per attached partition', async () => {
    const fixture = await twoRootCoordinator();
    await fixture.coordinator.reconcileBindings();
    assert.strictEqual(fixture.resourcesByRoot.size, 2);
    assert.deepStrictEqual(JSON.parse(fixture.mirrorA.content!).items.map((item: any) => item.uri), ['file:///a/a.ts']);
    assert.deepStrictEqual(JSON.parse(fixture.mirrorB.content!).items.map((item: any) => item.uri), ['file:///b/b.ts']);
  });

  test('isolates a failed write to one dirty partition', async () => {
    const fixture = await twoRootCoordinator();
    fixture.mirrorA.failNextWrite = true;
    await fixture.store.addItem(fixture.ownerA, { type: 'file', uri: 'file:///a/new.ts' });
    await fixture.store.addItem(fixture.ownerB, { type: 'file', uri: 'file:///b/new.ts' });
    await fixture.coordinator.flushAll();
    assert.strictEqual(fixture.store.getMirrorState(fixture.partitionA)!.dirty, true);
    assert.strictEqual(fixture.store.getMirrorState(fixture.partitionB)!.dirty, false);
  });

  test('rejects a cross-root external edit as one payload', async () => {
    const fixture = await twoRootCoordinator();
    const before = fixture.store.getOwnerData(fixture.ownerA);
    fixture.mirrorA.content = mirrorJson([{ id: 'x', uri: 'file:///b/leak.ts' }]);
    await fixture.coordinator.reloadPartition(fixture.partitionA);
    assert.deepStrictEqual(fixture.store.getOwnerData(fixture.ownerA), before);
  });
});
```

Also add tests for matching hash, watcher echo, invalid/future payload, unchanged existing URI after a
nested-root addition, changed existing URI validation, ID collision regeneration with collection
reference rebinding, removal flush/disposal, and `flushAll`.

- [ ] **Step 3: Run tests to verify failure**

Run: `npm run compile-tests`

Expected: FAIL because the coordinator and store mirror methods do not exist.

- [ ] **Step 4: Implement one binding state machine per partition**

Use a `Map<string, PartitionBinding>` where each binding owns its own operation tail, write tail,
delayer, generation, resources, last scheduled content revision, and disposed flag. Never await one
partition's queue from another partition's reload path. `flushAll` may await all current partitions
with `Promise.allSettled`, log failures by partition ID, and reject only after every partition has
been given a chance to flush.

```ts
interface PartitionBinding {
  readonly partitionId: string;
  readonly generation: number;
  readonly resources: PartitionMirrorResources;
  readonly delayer: Delayer;
  operationTail: Promise<void>;
  writeTail: Promise<void>;
  scheduledRevision: number;
  disposed: boolean;
}
```

Subscribe once to `store.onBookmarksChanged`; after each committed content event, scan attached
partitions and schedule writes only for those whose mirror state is dirty. `recordMirrorWrite`
atomically records the written hash and clears dirty without firing another content event.

`handleRootsChanged` compares current attached identities with the incoming roots, flushes and
disposes bindings for removed roots, calls `store.reconcileRoots(roots)`, then calls
`reconcileBindings()` for the committed attachment set. A failed removed-root flush records that
partition dirty and logs the failure before detachment continues; it never deletes partition data.

- [ ] **Step 5: Implement external isolation and collision repair**

Compare the incoming payload to current partition data by ID. Validate every new item and every
existing item whose URI changed using `resolveAttachedOwner`. Before adoption, regenerate any
incoming non-UUID item or collection ID and any identifier found in another owner; update imported
`collectionId` references via the old-to-new collection map; normalize; atomically adopt; and rewrite
the normalized mirror. Pass `rewriteRequired: true` only when normalization or ID repair changed the
incoming payload; otherwise adoption records the incoming hash and clears dirty in the same update.

- [ ] **Step 6: Remove workspace mirror duties from Global `BookmarkStore`**

Delete `BookmarkStoreOptions.mirror` and its mirror queue/state methods after their behavior is
covered by coordinator tests. Retain `MirrorPort`, `WorkspaceMirrorFile`, serialization, and hash
helpers in `bookmarkMirror.ts`. Update old `bookmarkStore.test.ts` cases so they test Global CRUD
only; migrate mirror behavior assertions to `workspaceMirrorCoordinator.test.ts`.

- [ ] **Step 7: Run tests**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including independent reconcile, write failure isolation, external
validation, ID repair, watcher lifecycle, removal flush, and Global regressions.

- [ ] **Step 8: Commit**

```bash
git add src/bookmarkStore.ts src/workspaceBookmarkStore.ts src/workspaceMirrorCoordinator.ts src/test/suite/bookmarkStore.test.ts src/test/suite/workspaceMirrorCoordinator.test.ts src/test/suite/fixtures.ts
git commit -m "feat: mirror each attached workspace partition"
```

---

### Task 7: Partition-aware tree presentation

**Files:**
- Modify: `src/bookmarksTreeDataProvider.ts`
- Modify: `src/test/suite/bookmarksTreeDataProvider.test.ts`

**Interfaces:**
- Consumes: `WorkspaceBookmarkStore.getView()`, `WorkspaceOwnerRef`, shared `BookmarkContentReader`.
- Produces these additional node variants:

```ts
type OwnerEnvelope =
  | { scope: 'workspace'; owner: WorkspaceOwnerRef }
  | { scope: 'global'; owner?: never };

type BookmarkNode =
  | { kind: 'workspaceRoot'; partitionId: string; label: string }
  | { kind: 'unassignedRoot' }
  | { kind: 'detachedRoot' }
  | { kind: 'detachedPartition'; partitionId: string; label: string }
  | { kind: 'workspaceDiagnostic'; message: string }
  | ({ kind: 'collection'; collection: BookmarkCollection; repoLabel?: string; repoKey?: string } & OwnerEnvelope)
  | ({ kind: 'item'; item: BookmarkItem } & OwnerEnvelope)
  | ({ kind: 'repoGroup'; label: string; repoKey: string } & OwnerEnvelope)
  | { kind: 'globalRoot' }
  | { kind: 'suggestedRoot' }
  | { kind: 'suggestion'; recentItem: RecentItem }
  | { kind: 'recentRoot' }
  | { kind: 'recentItem'; uri: string };

interface DragEnvelope {
  readonly scope: BookmarkScope;
  readonly owner?: WorkspaceOwnerRef;
  readonly ids: string[];
}
```

Implements spec §10 and the consumer boundary in spec §13.

- [ ] **Step 1: Write failing topology and node-ownership tests**

```ts
test('keeps one attached root flat', async () => {
  const provider = providerFor(workspaceView({ attached: [partition('a', 'Root A', oneItem())] }));
  const roots = await provider.getChildren();
  assert.strictEqual(roots.some((node) => node.kind === 'workspaceRoot'), false);
  assert.strictEqual(roots.some((node) => node.kind === 'item' && node.owner?.kind === 'partition'), true);
});

test('shows each attached root in multi-root and carries partition ids', async () => {
  const provider = providerFor(workspaceView({ attached: [partition('a', 'Root A'), partition('b', 'Root B')] }));
  const roots = await provider.getChildren();
  assert.deepStrictEqual(
    roots.filter((node) => node.kind === 'workspaceRoot').map((node: any) => node.partitionId),
    ['a', 'b']
  );
});

test('shows Unassigned and Detached only when populated', async () => {
  const provider = providerFor(workspaceView({ unassigned: oneItem(), detached: [partition('old', 'file:///old', oneItem())] }));
  const roots = await provider.getChildren();
  assert.strictEqual(roots.some((node) => node.kind === 'unassignedRoot'), true);
  assert.strictEqual(roots.some((node) => node.kind === 'detachedRoot'), true);
});

test('shows a diagnostic instead of empty workspace content', async () => {
  const roots = await providerFor(unavailableWorkspaceView()).getChildren();
  assert.strictEqual(roots.some((node) => node.kind === 'workspaceDiagnostic'), true);
});

test('rejects a drag whose source and target have different owners', async () => {
  const provider = providerFor(workspaceView({ attached: [partition('a', 'Root A', oneItem()), partition('b', 'Root B', oneItem())] }));
  const transfer = dragTransferFor({ scope: 'workspace', owner: { kind: 'partition', partitionId: 'a' }, ids: ['item-a'] });
  await provider.handleDrop(collectionNodeFor('b'), transfer, cancellationToken());
  assert.deepStrictEqual(recordedWorkspaceMoves(), []);
});
```

- [ ] **Step 2: Compile and run to verify failure**

Run: `npm run compile-tests`

Expected: FAIL because the node union and provider constructor do not accept the workspace store.

- [ ] **Step 3: Implement owner-aware traversal**

Change the provider constructor to accept `WorkspaceBookmarkStore` plus the Global
`BookmarkContentReader`. Factor `getOwnerChildren(owner, node)` so collection and item nodes always
inherit the same `WorkspaceOwnerRef`. Keep Suggested and Recent filtering against
`workspaceStore.getAll()` so Detached and Unassigned bookmarks are not suggested again. In group-by-
repo mode, group independently inside each attached, Unassigned, or Detached owner; never build a
repo group across owners.

- [ ] **Step 4: Implement tree item labels and context values**

Use these stable context values:

```ts
workspaceRoot -> 'bookmarkWorkspaceRoot'
unassignedRoot -> 'bookmarkUnassignedRoot'
detachedRoot -> 'bookmarkDetachedRoot'
detachedPartition -> 'bookmarkDetachedPartition'
workspaceDiagnostic -> 'bookmarkWorkspaceDiagnostic'
```

Give item and collection IDs an owner prefix (`partition:<id>`, `unassigned`, or `global`) so VS Code
tree identity cannot collide across sections. Detached item/collection nodes retain normal edit and
remove commands but their owner prevents create and cross-owner move operations. Add the owner to
`DragEnvelope`, require every dragged item to share it, and accept drops only on the same owner.
Order top-level rows as Global, attached roots in current workspace order, Unassigned, Detached,
Suggested, then Recent; in the single-root flat view, place the root's direct content where attached
root rows would otherwise appear.

- [ ] **Step 5: Run tests**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including flat single-root, multi-root wrappers, conditional preservation
sections, diagnostic mode, unique node IDs, and existing Global/Suggested/Recent behavior.

- [ ] **Step 6: Commit**

```bash
git add src/bookmarksTreeDataProvider.ts src/test/suite/bookmarksTreeDataProvider.test.ts
git commit -m "feat: show workspace partitions in the bookmarks tree"
```

---

### Task 8: Partition-aware commands and recovery UX

**Files:**
- Modify: `src/commands.ts`
- Modify: `src/test/suite/commands.test.ts`
- Modify: `src/test/suite/fixtures.ts:173-232`
- Modify: `package.json:37-103`

**Interfaces:**
- Consumes: owner-carrying tree nodes, store root resolution, recovery preview and commit.
- Produces:

```ts
export const REATTACH_ONLY_LABEL = 'Reattach only';
export const REATTACH_AND_SALVAGE_LABEL = 'Reattach and salvage';
export const RECOVER_CONFIRM_LABEL = 'Recover';

export interface RecoveryCommandDeps {
  readonly store: WorkspaceBookmarkStore;
  readonly prompter: Prompter;
  readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  readonly fs: RecoveryFileSystem;
}

export function createRecoverPartitionHandler(
  deps: RecoveryCommandDeps
): (node?: BookmarkNode) => Promise<void>;
```

Implements spec §§7, 10, and 11. Current command routing is scope-only
(`src/commands.ts:L129-L159`; `src/commands.ts:L220-L330`).

- [ ] **Step 1: Write failing command-routing tests**

Extend `FakePrompter` with `lastInfoMessage` and `lastWarningMessage`; set them in `showInfo` and
`showWarningConfirm` before returning the configured result.

```ts
test('routes an item command through its workspace owner', async () => {
  const fixture = commandFixture();
  await createRemoveHandler(fixture.stores)(workspaceItemNode(fixture.ownerB, fixture.itemB));
  assert.deepStrictEqual(fixture.workspace.removeCalls, [{ owner: fixture.ownerB, id: fixture.itemB.id }]);
});

test('prompts for a root when creating a collection in multi-root', async () => {
  const fixture = multiRootCollectionFixture({ selectedPartitionId: 'b', name: 'Work' });
  await fixture.handler();
  assert.deepStrictEqual(fixture.workspace.addCollectionCalls, [{ owner: { kind: 'partition', partitionId: 'b' }, name: 'Work' }]);
});

test('rejects moving an item to a collection owned elsewhere', async () => {
  const fixture = crossOwnerMoveFixture();
  await fixture.handler(fixture.itemNode);
  assert.deepStrictEqual(fixture.workspace.moveCalls, []);
  assert.strictEqual(fixture.prompter.lastInfoMessage, 'Bookmarks cannot be moved between workspace roots.');
});
```

- [ ] **Step 2: Write failing recovery-flow tests**

```ts
test('previews salvage counts and commits only after confirmation', async () => {
  const fixture = recoveryCommandFixture({ mode: REATTACH_AND_SALVAGE_LABEL, confirmed: true });
  await createRecoverPartitionHandler(fixture.deps)(fixture.detachedNode);
  assert.match(fixture.prompter.lastWarningMessage!, /1 recovered, 2 still missing, 1 incompatible/);
  assert.deepStrictEqual(fixture.store.commitRecoveryCalls, ['recovery-token']);
});

test('cancellation makes no recovery mutation', async () => {
  const fixture = recoveryCommandFixture({ mode: REATTACH_ONLY_LABEL, confirmed: false });
  await createRecoverPartitionHandler(fixture.deps)(fixture.detachedNode);
  assert.deepStrictEqual(fixture.store.commitRecoveryCalls, []);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm run compile-tests`

Expected: FAIL because command store types and the recovery handler are not implemented.

- [ ] **Step 4: Refactor command dependencies to distinguish Global and workspace stores**

Replace `ScopedStores.workspace: BookmarkStore` with `WorkspaceBookmarkStore`. For workspace nodes,
pass `node.owner` into every mutation. For resource-URI adds and suggestion/recent promotion, resolve
the attached owner first and show a non-mutating information message when no root owns the URI.
For resource-URI removal, use `findItemsByUri`: remove the sole workspace match, prompt for its
owner when multiple workspace partitions contain that URI, and fall back to the existing Global
lookup only when no workspace match exists. For a palette collection create, use the single attached
root directly or prompt from attached roots.

- [ ] **Step 5: Implement the recovery handler**

Select the detached partition when no context node was supplied, show old URI and item count, select
a destination root, select a mode, obtain the preview, render exact counts, ask modal confirmation,
then call `commitRecovery(preview.token)`. Catch `RecoveryConflictError` and show its redacted user
message; rethrow unexpected errors for the extension error boundary.

- [ ] **Step 6: Add the command contribution**

Add `bookmarks.recoverPartition` to `contributes.commands`, leave it visible in the Command Palette,
and add it to `view/item/context` when
`view == bookmarksView && viewItem == bookmarkDetachedPartition`. Add `bookmarks.newCollection` to
the `bookmarkWorkspaceRoot` item context menu so a multi-root create can target that root directly;
the view-title and Command Palette invocation prompts only when multiple attached roots exist.
Remove the obsolete warning in `bookmarks.addToWorkspace` that says adding a second root disables
the mirror (`src/commands.ts:L363-L369`).

- [ ] **Step 7: Run tests and manifest validation**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm test`

Expected: all suites PASS, including owner routing, cross-owner rejection, root selection, recovery
confirmation/cancellation/conflict, and manifest command/menu coverage.

- [ ] **Step 8: Commit**

```bash
git add src/commands.ts src/test/suite/commands.test.ts src/test/suite/fixtures.ts package.json
git commit -m "feat: add partition recovery commands"
```

---

### Task 9: Extension integration, documentation, and release verification

**Files:**
- Modify: `src/extension.ts:50-212,417-602`
- Modify: `src/bookmarkDecorationProvider.ts`
- Modify: `src/bookmarkContextKeys.ts`
- Modify: `src/mcpServerProvider.ts:10-56`
- Modify: `src/test/suite/extension.test.ts`
- Modify: `src/test/suite/extension.globalStore.test.ts`
- Modify: `src/test/suite/bookmarkDecorationProvider.test.ts`
- Modify: `src/test/suite/bookmarkContextKeys.test.ts`
- Modify: `src/test/suite/mcpServerProvider.test.ts`
- Modify: `README.md:24-25,61-84,108-127,259-269`
- Add: `docs/superpowers/plans/2026-09-07-multi-root-workspace-partitioning.md`

**Interfaces:**
- Consumes: every prior task's final interfaces.
- Produces: activated multi-root behavior, lifecycle subscriptions, mirror resources, user
  documentation, and a fully persisted implementation plan artifact.

Implements spec §§12-16. Current activation constructs one mirrored workspace `BookmarkStore`, one
Global store, and one single-binding coordinator (`src/extension.ts:L417-L444`;
`src/extension.ts:L560-L590`).

- [ ] **Step 1: Write failing activation integration tests**

```ts
test('activation creates mirrors for every attached root', async () => {
  const fixture = activationFixture({ roots: ['file:///a', 'file:///b'] });
  await activate(fixture.context, fixture.dependencies);
  assert.deepStrictEqual([...fixture.createdMirrorRoots].sort(), ['file:///a', 'file:///b']);
});

test('folder removal flushes, disposes, and preserves the detached partition', async () => {
  const fixture = activationFixture({ roots: ['file:///a', 'file:///b'] });
  await activate(fixture.context, fixture.dependencies);
  await fixture.fireWorkspaceFoldersChanged(['file:///a']);
  assert.strictEqual(fixture.mirrorResources.get('file:///b')!.disposed, true);
  assert.strictEqual(fixture.workspaceStore.getView().detached.length, 1);
});

test('malformed workspace data leaves Global active and does not create mirrors', async () => {
  const fixture = activationFixture({ malformedWorkspaceSnapshot: true, globalItem: true });
  await activate(fixture.context, fixture.dependencies);
  assert.strictEqual(fixture.globalStore.getAll().items.length, 1);
  assert.strictEqual(fixture.createdMirrorRoots.size, 0);
  assert.strictEqual((await fixture.provider.getChildren()).some((node) => node.kind === 'workspaceDiagnostic'), true);
});

test('native MCP exposes one explicitly rooted definition per workspace folder', () => {
  const definitions = buildMcpServerDefinitions(
    [
      { name: 'A', uri: vscode.Uri.file('/work/a') },
      { name: 'B', uri: vscode.Uri.file('/work/b') }
    ],
    vscode.Uri.file('/extension'),
    '1.3.0',
    new FakeOutput()
  );
  assert.strictEqual(definitions.length, 2);
  assert.deepStrictEqual(definitions.map((definition) => definition.args.at(-1)), [
    vscode.Uri.file('/work/a').fsPath,
    vscode.Uri.file('/work/b').fsPath
  ]);
  assert.deepStrictEqual(definitions.map((definition) => definition.label), [
    'Bookmarks Plus (A)',
    'Bookmarks Plus (B)'
  ]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run compile-tests`

Expected: FAIL because `activate` remains synchronous and uses the old workspace store/coordinator.

- [ ] **Step 3: Replace activation wiring**

Make `activate` return `Promise<void>`. Await `WorkspaceBookmarkStore.create` before registering
workspace commands and consumers. Keep `new BookmarkStore(context.globalState, output)` for Global.
Construct filesystem resources per attached root, call `reconcileBindings`, and on folder changes:

```ts
await mirrorCoordinator.handleRootsChanged(toRootCandidates(vscode.workspace.workspaceFolders));
provider.refresh();
applyWorkspaceEnv(context.environmentVariableCollection, vscode.workspace.workspaceFolders);
```

On deactivation, flush all mirrors before disposing the workspace and Global stores. A root flush
failure must be logged while remaining roots still flush.

- [ ] **Step 4: Expose native MCP definitions per attached root**

Replace `McpProviderDependencies.getWorkspaceFolders` with `getAttachedRoots`, sourced from
`workspaceStore.getView().attached`, and replace its raw folder-change subscription with
`workspaceStore.onDidChangePartitions`. Preserve the exact single-root label `Bookmarks Plus`; for
multi-root return one definition per attached partition with that root's filesystem path as the
explicit final argument. Label each `Bookmarks Plus (<folder name>)`; when names repeat, append the
canonical root URI to both colliding labels so they remain distinct without depending on folder
order. Unavailable/colliding roots produce no definition. A detach fires the definition-change event
so VS Code retires that root's native server. Keep no-root behavior unchanged. The current
multi-root rejection is at `src/mcpServerProvider.ts:L35-L40`.

- [ ] **Step 5: Generalize read-only consumers**

Change decoration and context-key constructors from concrete `BookmarkStore[]` to
`BookmarkContentReader[]`. Keep their union-of-item-URIs behavior unchanged; their existing tests
must pass with both a real Global store and a stub workspace reader.

- [ ] **Step 6: Update README behavior**

Replace the multi-root-disabled text with:

```markdown
In a multi-root workspace, each attached folder has its own `.vscode/bookmarks.json`. The file
contains only bookmarks owned by that folder. Adding or reordering workspace folders does not move
existing bookmarks between roots.

Bookmarks whose original root is no longer open appear under **Detached**. Use **Recover Detached
Bookmarks** to reattach them, optionally salvaging bookmark paths after a folder move. Legacy items
that cannot be assigned safely appear under **Unassigned**. Detached, Unassigned, and Global
bookmarks are never written to a root mirror.
```

Document that native MCP exposes one labeled server per workspace root. For the standalone server,
document that an explicit workspace argument selects a root in multi-root use, while the integrated
terminal environment remains `disabled:multi-root` because a window-wide environment variable has
no selected root. Do not claim that #129 or #138 is already implemented.

- [ ] **Step 7: Run focused static verification**

Run: `npm run compile-tests`

Expected: PASS.

Run: `npm run lint`

Expected: PASS with zero ESLint errors.

Run: `npm run compile`

Expected: PASS and produce both extension and MCP bundles.

- [ ] **Step 8: Run the complete automated suite**

Run: `npm test`

Expected: all VS Code extension suites PASS.

Run: `npm run test:mcp-bundle`

Expected: all standalone MCP bundle tests PASS; mirror schema compatibility is unchanged.

- [ ] **Step 9: Verify artifact persistence and scope**

Run:

```bash
git diff main...HEAD --stat
git diff --check
git ls-tree HEAD -- docs/superpowers/specs/2026-09-07-multi-root-workspace-partitioning-design.md
```

Before committing the plan, verify every source/test path in the File map now exists in the working
tree. Confirm the diff contains no #129/#138 public API or bridge implementation.

- [ ] **Step 10: Commit integration, docs, and the now-persistent plan**

```bash
git add src/extension.ts src/bookmarkDecorationProvider.ts src/bookmarkContextKeys.ts src/mcpServerProvider.ts src/test/suite/extension.test.ts src/test/suite/extension.globalStore.test.ts src/test/suite/bookmarkDecorationProvider.test.ts src/test/suite/bookmarkContextKeys.test.ts src/test/suite/mcpServerProvider.test.ts README.md docs/superpowers/plans/2026-09-07-multi-root-workspace-partitioning.md
git commit -m "feat: integrate multi-root workspace partitioning"
```

- [ ] **Step 11: Perform pre-PR verification**

Run:

```bash
npm run lint
npm run compile-tests
npm run compile
npm test
npm run test:mcp-bundle
git diff main...HEAD --check
git diff main...HEAD --stat
```

Expected: every command exits 0; the diff contains the approved #62 implementation, tests, README,
design spec, and plan. Verify the PR body will include `Closes #62` as a standalone closing directive.
