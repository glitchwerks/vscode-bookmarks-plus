# Bookmarks Plus user guide

This guide covers Bookmarks Plus behavior beyond the quick start in the
[README](../README.md).

## Adding and organizing bookmarks

Right-click a file, folder, or editor tab and choose **Add Bookmark** to add it to its workspace
owner. Choose **Add Bookmark (Global)** when it should be available in every workspace.

The Bookmarks Plus view keeps global bookmarks in a pinned **Global** row. Workspace roots and the
Global scope each have their own collections and ordering. Drag bookmarks to reorder them or move
them between collections in the same scope. Cross-scope dragging is refused so a reordering action
cannot silently change ownership.

Right-clicking an already-bookmarked file shows **Remove Bookmark** instead of **Add Bookmark**.
When several workspace owners contain the same resource, Bookmarks Plus asks which owner to remove
it from. Folders retain the normal **Add Bookmark** action.

Broken bookmarks—targets that were moved or deleted—remain visible with a warning icon instead of
causing an error.

## Descriptions

Right-click a bookmark or collection and choose **Set Description** to attach a free-text note. The
note appears in the hover tooltip. To remove it, open **Set Description** again, clear the input,
and submit the empty value.

## Display options

The view title bar includes two display toggles:

- **Group by Repo** groups bookmarks by Git repository. Anything VS Code's Git extension cannot
  resolve appears under **Unknown**.
- **Show Full Path** switches labels between filename-only and paths relative to the workspace
  root, using `/` separators. With repository grouping enabled, the path does not repeat the
  repository name. Targets outside every attached root fall back to filename-only. The setting
  persists across window reloads.

## Explorer decorations

Bookmarked files and folders receive a `★` badge and a **Bookmarked** tooltip in VS Code's Explorer.
Decorations cover workspace and global bookmarks and update as bookmarks change. They are enabled
by default; set `bookmarksPlus.explorerDecoration.enabled` to `false` to turn them off.

## Suggested bookmarks

The **Suggested** row lists recently opened files that are not already bookmarked. Suggestions are
ordered by when they first become eligible; reopening an existing suggestion does not move it.
Select a suggestion to open it, or use its inline action to turn it into a bookmark.

Opening a file for editing surfaces it immediately. Previewing a file with a single Explorer click
must happen three times before it becomes a suggestion, which avoids filling the list with files
you only glanced at. Set `bookmarksPlus.suggestions.maxItems` to control the list size (default
`10`), or set it to `0` to hide the section.

## Adding a global folder to the workspace

A global folder bookmark outside the current workspace has an inline **Add to Workspace** action.
It uses VS Code's workspace-folder update operation and may restart the extension host, especially
when an empty or single-folder window becomes a multi-root workspace. Bookmarks Plus flushes
pending mirror writes before adding the folder.

## Workspace ownership

Workspace bookmarks live in a versioned partition snapshot in VS Code's per-workspace storage.
Each bookmark and collection has a stable root owner.

In a multi-root workspace, adding, nesting, or reordering roots does not move existing bookmarks.
New bookmarks use the deepest attached root containing their URI. New collections belong to the
selected root; creating one from the Command Palette prompts for a root when the choice is
ambiguous.

## Detached workspaces and recovery

When a workspace root is removed, its bookmarks appear under **Detached**. Reopening the exact same
root automatically reattaches them when its identity is unambiguous.

After a folder moves, run **Bookmarks Plus: Recover Detached Workspace** from the Command Palette or
the detached partition's context menu. Recovery offers two modes:

- **Reattach only** associates the partition with the selected root without changing saved paths.
- **Reattach and salvage** previews paths rebased from the old root to the new one. Only targets
  that resolve are rewritten; missing or incompatible entries remain unchanged.

Recovery cannot replace a destination that already has established bookmark data.

## Unassigned and unavailable data

Legacy items that cannot be assigned to a root safely, along with empty legacy collections, appear
under **Unassigned**. Detached and Unassigned content remains editable and removable, but cannot
receive new bookmarks or collections.

A malformed or unsupported workspace snapshot is preserved rather than replaced. The view shows
**Workspace data unavailable**; select that row to open the Bookmarks Plus output channel. Global
bookmarks remain usable.

## The `.vscode/bookmarks.json` mirror

Each attached workspace root has its own `.vscode/bookmarks.json`, containing only that root's
bookmarks. Detached, Unassigned, and Global data is never mirrored.

- **Writes are batched.** A burst of changes such as drag-and-drop reordering normally produces one
  write.
- **External edits are picked up live.** Changes made while VS Code is closed are loaded when the
  window next opens.
- **The shape is a semi-public contract.** The current mirror uses schema version 2 and is described
  by the JSON schema shipped with the extension, enabling completion and validation in VS Code.
  Fields may be added in a future schema version; existing meanings require a version bump to
  change.
- **Last write wins.** There is no locking or merge operation. If the extension and another tool
  write concurrently, the later write survives.
- **Invalid content is preserved.** Malformed or unreadable content is not adopted. Bookmarks Plus
  keeps its committed state, logs to the output channel, and leaves the file untouched until the
  next bookmark change.
- **Root isolation is enforced.** A payload containing new or changed bookmark URIs outside its
  owning root is rejected as a whole. Existing unchanged bookmarks retain their owner when a nested
  root is added. A failed write affects only that root and is retried from workspace storage.
- **Source control is optional.** Commit the mirror to share bookmarks with a team, or add it to
  `.gitignore` to keep bookmarks private.
