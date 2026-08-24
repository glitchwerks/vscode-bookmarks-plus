# Changelog

All notable changes to the "Bookmarks Plus" extension are documented in this file.

## [Unreleased]

## [1.2.0] — 2026-08-24

### Added

- Optional descriptions on bookmarks and collections, set via the **Set Description** context-menu
  command and shown in the tree view's hover tooltip.
- `.vscode/bookmarks.json`: bookmarks are mirrored to a plain JSON file in the workspace, so
  external tools can read and change them. External edits are picked up live; edits made while
  VS Code is closed are picked up on the next activation. Single-folder workspaces only.
- A JSON schema for `.vscode/bookmarks.json`, giving completion and validation when the file is
  edited in VS Code.
- `mcp-server/`: a standalone MCP server exposing bookmarks to Claude Desktop and Claude Code,
  with `list_bookmarks` (read) and `add_bookmark` (append) tools. Built from source; see the
  README's "Using bookmarks from Claude (MCP server)" section for configuration and limitations.
- `mcp-server`: the workspace path no longer needs to be named explicitly when running under
  Claude Code. The server now reads `CLAUDE_PROJECT_DIR`, which Claude Code sets automatically
  for any MCP server it spawns for a project, letting a project-scoped `.mcp.json` entry carry
  no workspace path at all. See the README's "Recommended: project-scoped, path-free" section.
- Global bookmarks (#55): a new scope, backed by a second `BookmarkStore` over
  `context.globalState`, available in every workspace rather than just the one it was added from.
  No cross-machine sync — `setKeysForSync` is never called on it.
- A pinned "Global" row in the tree view, always shown first, with the same collection,
  reorder, and drag-and-drop support as workspace bookmarks.
- New commands to bookmark a file or folder into the global scope from the Explorer context
  menu, and to create a global collection from the Global row.
- Drag-and-drop now refuses cross-scope moves — a workspace bookmark can't be dropped into the
  Global row's section, and a global bookmark can't be dropped into a workspace collection.
  Reordering and moving within a single scope is unchanged.
- Global bookmarks are not mirrored to `.vscode/bookmarks.json` and are therefore not visible to
  the MCP server; only workspace bookmarks are.
- Add to Workspace (#56): a global folder bookmark that is outside the current workspace gets an
  "Add to Workspace" action, promoting it to a new workspace root via
  `vscode.workspace.updateWorkspaceFolders`. This may restart the extension host regardless of
  the starting folder count, but a confirm prompt naming the restart and mirror-disabling
  consequences only appears when the add turns a single-folder workspace into a multi-folder one
  — the transition that also disables the `.vscode/bookmarks.json` mirror; an empty window or an
  already multi-root workspace proceeds without a prompt.
- `BOOKMARKS_PLUS_WORKSPACE` terminal variable (#58): the extension now injects this environment
  variable into every integrated terminal it launches, so the MCP server (#57) can resolve the
  correct workspace without per-project registration config. A single-folder window sets the
  folder's absolute path; two or more folders sets `disabled:multi-root`; no folder open sets
  `disabled:no-folder`. See the README's "Configure" section for the full resolution order.

### Changed

- The stored bookmark schema is now version 2. Existing version 1 data loads unchanged, with
  descriptions absent.
- `mcp-server`: `BOOKMARKS_MCP_WORKSPACE` is now checked *after* the new `CLAUDE_PROJECT_DIR`
  auto-detection instead of being the primary fallback. Anyone who configured the server by
  setting `BOOKMARKS_MCP_WORKSPACE` in the registration's `env` block (or a shell profile) will
  now find that value **silently overridden** under Claude Code whenever a project directory is
  auto-detected — it is no longer a reliable way to pin a workspace there. Switch to the
  path-free registration form, or use the explicit `args` path override if you need a fixed
  workspace Claude Code's detection cannot override. See the README's "Legacy:
  `BOOKMARKS_MCP_WORKSPACE` — behavior change" section for the full migration note.
- The extension now activates on VS Code startup (`onStartupFinished`), in addition to the
  existing implicit activation when the Bookmarks view is first revealed. This is earlier
  activation, not a fix — it ensures a terminal opened right at startup, before the view is ever
  touched, still receives `BOOKMARKS_PLUS_WORKSPACE` (#58, above).

## [1.0.0] — 2026-07-26

### Added

- Bookmark files and folders (not just lines) per workspace, for single-root and multi-root workspaces.
- Collections: group bookmarks, rename and delete collections (deleting ungroups rather than deletes items).
- Drag-and-drop reordering and cross-collection moves.
- Group-by-repo view, with an "Unknown" bucket for items with no resolvable repo.
- Broken-bookmark detection (missing path) with a warning icon; no auto-fix, remove manually.
- Repo-name badges resolved live via the built-in `vscode.git` extension (soft dependency — omitted silently if unavailable).
