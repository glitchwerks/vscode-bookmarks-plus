# Changelog

All notable changes to the "Bookmarks Plus" extension are documented in this file.

## [Unreleased]

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

### Changed

- The stored bookmark schema is now version 2. Existing version 1 data loads unchanged, with
  descriptions absent.

## [1.0.0] — 2026-07-26

### Added

- Bookmark files and folders (not just lines) per workspace, for single-root and multi-root workspaces.
- Collections: group bookmarks, rename and delete collections (deleting ungroups rather than deletes items).
- Drag-and-drop reordering and cross-collection moves.
- Group-by-repo view, with an "Unknown" bucket for items with no resolvable repo.
- Broken-bookmark detection (missing path) with a warning icon; no auto-fix, remove manually.
- Repo-name badges resolved live via the built-in `vscode.git` extension (soft dependency — omitted silently if unavailable).
