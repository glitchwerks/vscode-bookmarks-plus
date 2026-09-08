# Multi-root workspace partitioning and mirror support

**Issue:** #62

**Milestone:** Cross-extension MCP access

**Status:** Approved design; implementation not started

## 1. Purpose

Bookmarks Plus needs a stable logical owner for every workspace bookmark and collection. That
ownership must survive workspace-folder removal, addition, nesting, and reordering so a future
root-scoped MCP session cannot expose another root's data. The same ownership model must support
one independent `.vscode/bookmarks.json` mirror per attached root. (#62;
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L493-L583`)

This design replaces the current window-wide workspace `BookmarkStore` with a partition-aware
workspace store. The existing global store and its `bookmarks.data` payload remain unchanged.
Today both stores are instances of `BookmarkStore`, backed by `workspaceState` and `globalState`
respectively, and the shared payload is a flat `BookmarkData` value. (`src/extension.ts:L439-L444`;
`src/types.ts:L19-L28`)

Issue #62 is the source of truth for the required ownership, migration, lifecycle, mirror,
verification, and documentation outcomes. The public API and authenticated bridge remain separate
work under #138 and #129. (#62)

## 2. Goals

1. Give every workspace item and collection exactly one stable owner: an identified root partition
   or the `unassigned` preservation bucket. (#62)
2. Keep ownership stable when roots are added, nested, or reordered. (#62)
3. Preserve data losslessly when a root disappears or legacy data cannot be assigned safely. (#62)
4. Maintain one isolated mirror per attached root while preserving the existing single-folder
   mirror payload. (#62; `src/bookmarkMirror.ts:L5-L15`)
5. Provide explicit, atomic recovery when a root URI changes, including a deterministic salvage
   option for rebasing bookmark URIs. (#62)
6. Establish the storage foundation required by the root-scoped MCP contract without implementing
   the public API or live bridge in this issue. (#62; #129; #138)

## 3. Non-goals

- Implementing the public cross-extension API from #138. (#62)
- Implementing the authenticated live MCP bridge from #129. (#62)
- Modifying Claude Workspaces or imported `--add-dir` roots. (#62)
- Automatically repartitioning existing data after workspace topology changes. (#62)
- Searching the filesystem or guessing a moved root from display names, basenames, path suffixes,
  or bookmark contents. (#62)
- Merging established partitions implicitly.
- Mirroring Global, Detached, or Unassigned data.

## 4. Current constraints

- `BookmarkData` schema version 2 contains flat `items` and `collections`; item URIs are stored as
  absolute URI strings. (`src/types.ts:L3-L28`)
- The workspace store persists under `bookmarks.data`; the global store uses the same key in a
  different `Memento`. (`src/bookmarkStore.ts:L18-L20`; `src/extension.ts:L439-L444`)
- The current mirror is enabled only for exactly one folder and is explicitly disabled for
  multi-root workspaces. (`src/bookmarkMirror.ts:L22-L44`)
- The mirror payload is serialized `BookmarkData`, and writes use a temporary file followed by an
  overwrite rename. (`src/bookmarkMirror.ts:L14-L19`; `src/bookmarkMirror.ts:L55-L90`)
- Current workspace helpers already choose the deepest matching root for nested folders in an
  order-independent way. (`src/workspaceFolders.ts:L72-L94`;
  `src/test/suite/workspaceFolders.test.ts:L165-L184`)
- Current reconciliation distinguishes local dirty state, the last successful mirror hash, and an
  externally changed file. It also ignores watcher echoes of its own writes.
  (`src/bookmarkStore.ts:L316-L395`; `src/bookmarkStore.ts:L423-L491`)
- The current tree combines one workspace store with an optional global store, while commands route
  mutations by scope rather than by workspace partition. (`src/bookmarksTreeDataProvider.ts:L72-L92`;
  `src/bookmarksTreeDataProvider.ts:L327-L363`; `src/commands.ts:L394-L437`)

## 5. Chosen architecture

### 5.1 One atomic nested workspace snapshot

Workspace data moves to one versioned value under the new `bookmarks.workspacePartitions` key.
The snapshot directly contains each partition's items and collections, plus Unassigned content.
One-key persistence makes a mutation that moves attachment state and rewrites item URIs observable
as one state transition. This is the required atomicity boundary for migration and recovery. (#62)

Conceptual types:

```ts
interface WorkspacePartitionSnapshot {
  version: 1;
  partitions: WorkspacePartition[];
  unassigned: BookmarkData;
}

interface WorkspacePartition {
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
```

The persisted `BookmarkData` nested inside each owner retains its own existing content schema
version. The outer snapshot version controls partition metadata and layout; the inner version
controls the existing mirror-compatible item and collection representation. This separation keeps
mirror evolution independent from workspace ownership evolution. The current content version is
defined by `CURRENT_SCHEMA_VERSION`. (`src/types.ts:L19-L28`; `src/migrations.ts:L27-L47`)

All partition, item, and collection identifiers are UUIDs and are unique across the entire workspace
snapshot, including Unassigned. Uniqueness across owners makes accidental cross-partition references
detectable before a mutation is committed. Item `collectionId` values may reference only a collection
inside the same owner. (#62)

`replacementEligible` starts as `true` only on a newly auto-created empty partition. The first
content mutation in that partition, including adoption of external mirror content, sets it to
`false` in the same persisted update. It never returns to `true`, even if the user later deletes all
content. This prevents recovery from deleting a destination that has user history merely because it
happens to be empty at recovery time. (#62)

### 5.2 Rejected storage alternatives

**Flat content with owner IDs** was rejected. Every read, reference traversal, normalization pass,
and mirror write would have to remember an owner filter, making an omission a data-leak boundary.
The root-scoped contract requires isolation by construction. (#62;
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L497-L550`)

**Separate `Memento` keys per partition** was rejected. Attachment changes, destination replacement,
and salvaged URI rewrites must commit as one logical update; distributing them across keys would
introduce partial states that require a transaction protocol. (#62)

**One aggregate mirror** was rejected. A window-wide file has no stable single-root location and
would expose data belonging to roots other than the selected root. The existing README documents
this ambiguity as the reason multi-root mirroring is disabled today. (`README.md:L61-L84`; #62)

## 6. Root URI identity

One pure canonicalization function is the only source of URI equality and containment decisions.
It is used for persisted identity metadata, attachment, deepest-root selection, migration,
destination validation, mirror validation, and future exact-root MCP requests. (#62)

Canonicalization:

1. Parse the value as a URI and reject relative values, non-empty query components, and non-empty
   fragments for workspace-root identity.
2. Lowercase the scheme and authority.
3. Compare VS Code's already-decoded path components without decoding them again. Literal percent
   names such as `%61`, `%7e`, and `%2F` remain literal names, distinct from decoded characters or
   structural separators. (`src/test/suite/rootUri.test.ts:L116-L143`)
4. Remove trailing path separators except when the path is the URI root.
5. Preserve path-component case: normalize only Windows file-URI drive-letter case to survive VS Code URI parse/serialization round trips; all remaining path components retain their case. (`src/test/suite/rootUri.test.ts:L22-L34`; `src/test/suite/workspaceFolders.test.ts:L85-L102`)
6. Serialize path components with URI-safe escaping, including literal percent, space, `#`, and `?`,
   while retaining structural separators and the established `file:///c:/...` drive-colon spelling.
   Parsing the canonical identity and canonicalizing again is idempotent.
   (`src/test/suite/rootUri.test.ts:L22-L34`; `src/test/suite/rootUri.test.ts:L116-L143`)

Containment compares scheme and authority identity first, then complete path components. Raw string
prefixes are never used. The deepest containing root is the candidate with the greatest number of
path components. Equal-depth canonical collisions are not broken by workspace-folder order. This
extends the existing segment-boundary and deepest-root behavior while removing its unconditional
path lowercasing. (`src/workspaceFolders.ts:L3-L20`; `src/workspaceFolders.ts:L30-L49`;
`src/workspaceFolders.ts:L69-L94`; #62)

Except for the file-URI drive letter, roots whose paths differ only by case remain distinct identities.
On a case-insensitive filesystem, a case-only folder move can therefore require explicit recovery.
This avoids silently collapsing distinct paths used by case-sensitive local or remote providers.
(#62)

If two simultaneously open workspace folders canonicalize to the same identity, neither may be
chosen by array order. The later reconciliation reports a canonical collision, leaves that root
unavailable, and makes no attachment or ownership changes until the collision is resolved. (#62)

## 7. Ownership and mutation rules

1. A newly created item belongs to the attached partition of the deepest current root containing
   its URI. If no attached root contains it, a workspace-scoped create fails without mutation.
   (#62)
2. A new collection created from a partition node belongs to that partition. In a multi-root
   workspace, a Command Palette collection create prompts for an attached root; in a single-root
   workspace it uses that root without prompting. Detached and Unassigned owners do not permit new
   collections. (#62)
3. Existing ownership never changes merely because roots are added, nested, or reordered. Only
   future items use the new deepest-root topology. (#62;
   `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L508-L540`)
4. Every workspace mutation carries a partition ID. Item and collection lookup occurs only inside
   that partition; an identifier found elsewhere is treated as absent for the operation. (#62)
5. URI-changing operations revalidate the proposed URI against the selected partition. A URI whose
   deepest current owner is another attached root, or no root, is rejected without mutation. (#62)
6. Collections never span owners. An item can reference only a collection in its current partition.
   (#62)
7. Drag-and-drop and command moves across partitions are rejected in this version. Whole-partition
   recovery is the only ownership-changing operation defined here; no implicit merge or individual
   reassignment is introduced.
8. Global behavior remains unchanged and independent of workspace partitions.

## 8. Legacy migration

Migration runs before the new workspace store accepts mutations.

1. If a valid `bookmarks.workspacePartitions` snapshot exists, use it and ignore any remaining
   legacy workspace `bookmarks.data` value. This makes cleanup failure after a successful migration
   safe on the next activation.
2. Otherwise, read and migrate the legacy workspace `bookmarks.data` payload through the existing
   content-schema migration ladder. Future or unsupported content versions remain errors and must
   not be rewritten. (`src/migrations.ts:L27-L47`)
3. Create one stable partition for every non-colliding current root.
4. Assign each legacy item to its deepest matching root. Put unmatched items in Unassigned. (#62)
5. For each non-empty collection:
   - if all member items have one owner, create it once in that owner;
   - if members span owners, create one independent collection per represented owner, preserve its
     name and description, preserve relative item order, issue a distinct collection UUID for each
     copy, and bind only that owner's items;
   - if all members are unmatched, keep one collection in Unassigned.
6. Keep empty legacy collections in Unassigned because their intended root cannot be inferred. (#62)
7. Preserve ungrouped items as ungrouped within their resolved owner.
8. Normalize ordering independently inside each resulting owner using the existing content
   normalization rules. (`src/normalize.ts:L107-L147`)
9. Validate global identifier uniqueness and same-owner references.
10. Write the complete versioned snapshot once. Only after that update succeeds, delete the legacy
    workspace `bookmarks.data` key.

If snapshot persistence fails, the legacy key remains authoritative and no partial partition state
is published. If legacy-key deletion fails after the snapshot succeeds, both keys may remain, but
the valid new snapshot wins on retry and migration is not repeated. These ordering rules make the
migration lossless and idempotent without a separate mutable migration flag. (#62)

Migration diagnostics contain counts only: source items and collections, resulting partitions,
split collections, and Unassigned totals. They never include bookmark URIs, names, descriptions,
or descriptor data. (#62)

## 9. Root lifecycle

On activation and each workspace-folder change, reconciliation canonicalizes the complete current
root set, checks collisions, and then processes each available root:

1. If exactly one detached partition has the same canonical last-known root identity and no attached
   partition claims it, reattach that partition automatically.
2. If no detached partition matches, create a new empty, replacement-eligible partition.
3. If multiple detached partitions match, attach none, create no replacement, and mark the root
   unavailable until explicit user selection.
4. If an attached root disappears, flush its pending mirror write, dispose its watcher, clear its
   attachment, and retain its content and last-known identity as a Detached partition.
5. Root display-name changes and workspace-folder reordering do not affect attachment or ownership.
6. Adding a nested root never reassigns existing items or splits existing collections. Future
   creates use the new deepest-root topology.

These rules implement the stable-ownership and ambiguous-reattachment requirements in #62 and the
folder-change lifecycle required by the approved MCP contract.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L508-L583`)

The store emits one consolidated lifecycle change after an atomic reconciliation update. Tree,
mirror, decoration, context-key, and future MCP consumers observe the same committed snapshot; they
do not infer ownership independently.

## 10. Unassigned and Detached presentation

### 10.1 Unassigned

Unassigned is a lossless workspace preservation bucket, not another root and not Global. It holds:

- migrated items that no current root safely owns;
- collections represented only by those items; and
- empty legacy collections whose root cannot be inferred. (#62)

Unassigned appears as a top-level tree section only while non-empty. Its contents remain inspectable,
editable, and removable in the Bookmarks Plus UI, but users cannot create new content there. It has
no mirror and is excluded from root-scoped MCP access. Adding a root around an Unassigned item's URI
does not claim it. (#62;
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L519-L530`)

### 10.2 Detached

Detached appears as a top-level tree section only while at least one detached partition exists.
Each child partition is labeled from its last-known root URI and is expandable so its bookmarks and
collections remain inspectable. Existing entries can be edited or removed, but new entries and
collections cannot be created in a detached partition. (#62)

The recovery command is available on a detached partition's context menu and from the Command
Palette. The palette flow first selects the detached partition when more than one exists.

### 10.3 Attached roots and Global

With one attached root, workspace content retains today's flat presentation; the root does not add
an otherwise redundant wrapper. With multiple attached roots, each root is a top-level section.
Global remains the existing top-level section and is not nested under a workspace root. The current
provider already presents Global separately from workspace content. (`src/bookmarksTreeDataProvider.ts:L211-L220`;
`src/bookmarksTreeDataProvider.ts:L327-L363`)

## 11. Explicit recovery and salvage

Exact-identity returns reattach automatically. A changed URI requires the user to invoke recovery
for a Detached partition. No display name, basename, suffix, or bookmark-content matching is used.
(#62)

The command performs this flow:

1. Show the detached partition's old root URI and item count.
2. Let the user select a current destination root.
3. Verify that the destination is either unattached or represented only by its automatically
   created, still-replacement-eligible empty partition.
4. Offer **Reattach only** and **Reattach and salvage**.
5. For salvage, preview counts for:
   - bookmark URIs that rebase and currently resolve through the workspace filesystem;
   - bookmark URIs that can be rebased structurally but whose destination targets remain missing;
     and
   - items that cannot be rebased because their URIs are outside or incompatible with the old root.
6. Ask for confirmation.
7. Commit attachment replacement and every valid URI rewrite in one snapshot update.
8. Refresh the tree and establish the destination's mirror binding.

**Reattach only** changes the partition attachment but leaves every bookmark URI unchanged.

**Reattach and salvage** replaces the old root URI prefix with the destination root URI for every
bookmark structurally contained by the old root whose rebased destination currently resolves,
preserving its relative path and URI path-component case. Missing-target, incompatible, and
outside-old-root entries remain unchanged and visible as broken. There is no recursive search,
basename guessing, or partial selection UI.

If the destination is attached to an established partition, is non-empty, or has ever contained
content, recovery returns a conflict and makes no changes. Cancellation and preview failure also
make no changes. An eligible empty destination partition is replaced, not merged. (#62)

When multiple detached partitions share the returning root's canonical identity, explicit selection
attaches only the chosen partition; the other candidates remain Detached. (#62)

## 12. Per-root mirrors

Every attached partition owns one mirror binding at `<root>/.vscode/bookmarks.json` and one watcher.
The file contains only that partition's existing `BookmarkData` shape; partition IDs, attachment
metadata, Unassigned content, Detached content, and Global content are never serialized into it.
This preserves the current single-folder mirror contract. (`src/bookmarkMirror.ts:L5-L15`;
`README.md:L61-L84`; #62)

Reconciliation runs independently per partition and preserves the current precedence rules:

- A missing mirror is seeded from that partition.
- A mirror whose hash matches the last successful write is a no-op.
- A valid differing mirror is treated as an external edit and adopted only into that partition.
- A failed local write marks only that partition dirty; its workspace state wins the next reconcile.
- An invalid or unsupported mirror payload is rejected as a whole while the partition state remains
  authoritative.
- A watcher echo of the coordinator's own write is ignored.
- Failure for one root does not disable or delay other root bindings.

The existing implementation supplies the first five single-store behaviors and write serialization;
the new coordinator applies them per partition rather than to one window-wide binding.
(`src/bookmarkStore.ts:L316-L395`; `src/bookmarkStore.ts:L401-L513`)

External mirror isolation rules:

1. Existing item IDs whose URIs are unchanged retain their partition, even if a nested root was
   added later.
2. A new item, or an existing item whose URI changed externally, must resolve to the mirror's
   attached partition under the current deepest-root rule.
3. If any such URI resolves to another partition or no attached partition, reject the complete
   external payload and retain the current snapshot.
4. If an imported item or collection ID collides with any identifier outside the partition,
   generate a new UUID. Rebind item `collectionId` references when their imported collection ID is
   regenerated, then write the normalized payload back to that root's mirror.
5. A mirror cannot refer to a collection outside its own payload.

Removing a root flushes that partition's pending write before its watcher is disposed and the
partition detaches. Deactivation flushes all partition write queues. The current extension already
flushes pending mirror writes on deactivation; this design generalizes that invariant to every
binding. (`src/extension.ts:L598-L602`)

## 13. Component boundaries

### Workspace partition types

Defines the outer snapshot, partition metadata, attachment records, recovery previews, and
partition-aware result DTOs. Existing mirror content types stay in `src/types.ts`.

### Root URI service

Owns canonicalization, equality, segment-boundary containment, deepest-root resolution, collision
detection, and safe prefix rebasing. No other component compares root URI strings directly.

### Workspace partition migration

Implements legacy-to-partition migration as pure transformations plus an explicit persistence
orchestrator. Pure output makes split behavior and idempotency testable without VS Code storage.
The existing content migration ladder remains responsible for `BookmarkData` versions.
(`src/migrations.ts:L12-L47`)

### Workspace bookmark store

Is the sole owner of the workspace snapshot. It serializes state transitions and exposes
partition-aware reads, CRUD, root reconciliation, recovery, salvage preview, and change events.
Malformed-state safety and invariant validation live at this boundary.

### Workspace mirror coordinator

Binds mirror ports and watchers to attached partition IDs, serializes per-partition reconciliation,
and translates valid external files into store operations. Filesystem access remains behind the
existing `MirrorPort` abstraction. (`src/bookmarkMirror.ts:L46-L90`)

### Existing consumers

`BookmarksTreeDataProvider`, commands, decorations, and context-key management consume a small
read/change interface shared by global and workspace adapters. Workspace tree nodes carry a
partition ID so later commands cannot fall back to a window-wide lookup. Activation constructs one
global `BookmarkStore`, one `WorkspaceBookmarkStore`, and one multi-binding mirror coordinator.
The current wiring points that must change are centralized in `activate()`.
(`src/extension.ts:L417-L444`; `src/extension.ts:L469-L489`;
`src/extension.ts:L512-L590`)

The existing `BookmarkStore` is not expanded into a conditional global/workspace/partition hybrid.
It remains the Global implementation and may share pure content helpers with the new workspace
store.

## 14. Failure behavior

### Persisted workspace snapshot

If the new snapshot is missing and no legacy workspace data exists, initialize a valid empty
snapshot. If the new key exists but is malformed, violates ownership invariants, or has an
unsupported outer version, do not replace it with empty data. Keep the raw value untouched, disable
workspace mutations and mirrors, leave Global operational, show a `Workspace data unavailable`
diagnostic tree node, and log a redacted reason with an action to open the output channel. The
current store starts empty for malformed state; partitioned storage deliberately changes that
behavior to prevent silent loss. (`src/bookmarkStore.ts:L82-L103`)

### Migration

A parse, content migration, canonicalization, invariant, or persistence failure leaves the legacy
key authoritative. No mirror starts until a valid snapshot is available. Logs contain counts and
error categories, not bookmark content. (#62)

### Mirrors

Read, validation, write, and watcher failures are recorded against one partition. Other partitions
continue reconciling. A local write failure sets only that partition's dirty bit. Invalid external
content never partially updates a partition.

### Recovery

Eligibility conflicts, invalid destination or root selections, failed previews, and cancellation do
not alter the snapshot. Individual missing-target or incompatible bookmarks are preview results,
not operation failures; they remain unchanged while successful salvages proceed. The confirmed
attachment and all applicable rewrites are one serialized store mutation. Mirror binding begins only
after that mutation succeeds.

### Events

Each successful atomic store mutation persists once and emits one consolidated change event after
persistence succeeds. Failed or no-op operations emit nothing. Consumers refresh from the committed
snapshot rather than applying their own speculative changes.

## 15. Verification strategy

Implementation follows test-driven development. Tests are organized by the boundary that owns the
behavior.

### URI identity tests

- scheme and authority case;
- path-component case preservation;
- decoded-component identity and URI-safe serialization, including literal percent names and encoded-separator safety (`src/test/suite/rootUri.test.ts:L116-L143`);
- trailing separators and URI roots;
- query, fragment, and relative-URI rejection;
- segment-boundary containment;
- deepest nested root independent of folder order;
- canonical collisions; and
- safe old-root-to-new-root rebasing.

### Migration tests

- one-root and multi-root assignment;
- deepest-root assignment;
- unmatched items and empty collections in Unassigned;
- single-owner collection preservation;
- mixed-owner collection splitting and reference rebinding;
- distinct, globally unique IDs;
- relative order preservation;
- unsupported legacy versions;
- snapshot-write failure leaves legacy state untouched;
- cleanup failure leaves the new snapshot authoritative; and
- retry does not duplicate partitions or split collections.

### Store and lifecycle tests

- isolated CRUD by partition ID;
- cross-root and outside-root create/update rejection with no mutation;
- root add, nested add, reorder, removal, and return;
- stable ownership across topology changes;
- same-identity automatic reattachment;
- ambiguous identity leaves the root unavailable;
- first mutation permanently clears replacement eligibility;
- malformed snapshot disables only workspace behavior; and
- exactly one persistence and event emission per successful mutation.

### Recovery tests

- exact-root selection among ambiguous candidates;
- reattach-only leaves URIs unchanged;
- salvage preview counts resolving, missing, and incompatible entries;
- salvage rebases all structurally valid entries whose destination targets resolve;
- incompatible entries remain unchanged and visible;
- eligible empty-destination replacement;
- established-destination conflict;
- cancellation and preview failure are no-ops; and
- store update precedes mirror binding.

### Mirror tests

- one mirror and watcher per attached root;
- missing-file seed, matching-hash no-op, external adoption, dirty local precedence, and self-write
  echo suppression for each partition;
- one-root failure isolation;
- Detached and Unassigned exclusion;
- unchanged existing ownership after nested-root addition;
- cross-root/outside-root external rejection;
- cross-partition ID collision regeneration and reference rebinding;
- removal flush and watcher disposal; and
- deactivation flushes all partitions.

### UI and integration tests

- flat single-root presentation;
- one section per root in multi-root workspaces;
- conditional Unassigned and Detached sections;
- detached inspection and mutation restrictions;
- partition-aware command routing and collection-root selection;
- recovery command flows and conflicts;
- unchanged Global behavior;
- extension activation and folder-change integration; and
- the complete pre-existing regression suite.

`README.md` is updated in the implementing PR to describe per-root mirrors, stable ownership,
Unassigned, Detached, and recovery. This replaces its current statement that multi-root disables
the mirror. (`README.md:L61-L84`; #62)

## 16. Delivery boundaries

Issue #62 is complete when the partition store, migration, lifecycle, tree/recovery experience,
per-root mirrors, tests, and README changes above ship together. The implementation must not expose
the public cross-extension API or authenticated live transport; those remain sequenced as #138 and
#129 on top of this storage foundation. (#62; #129; #138)
