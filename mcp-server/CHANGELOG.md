# Changelog

All notable changes to `@glitchwerks/bookmarks-plus-mcp` are documented in this file.

## [Unreleased]

## [0.1.0] — 2026-09-19

### Added

- First public release of the standalone Bookmarks Plus MCP server.
- `list_bookmarks` and `add_bookmark` for one workspace's `.vscode/bookmarks.json` mirror.
- Automatic workspace resolution for Bookmarks Plus terminals and Claude Code, plus an explicit
  workspace path for clients such as Claude Desktop.
- Package-content verification and a real installed-package MCP handshake on Linux and Windows.
- Reads mirror schema versions through `2` and refuses newer schemas.

See Issue #66 and PR #113 for the release and packaging history.
