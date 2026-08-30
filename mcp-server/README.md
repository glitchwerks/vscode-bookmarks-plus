# bookmarks-plus-mcp

An MCP (Model Context Protocol) server that exposes the workspace bookmarks
managed by the [Bookmarks Plus](https://github.com/glitchwerks/vscode-bookmarks-plus)
VS Code extension to MCP clients such as Claude Desktop and Claude Code. It
reads the workspace's `.vscode/bookmarks.json` mirror file and provides two
tools: listing bookmarks and adding a new bookmark.

This package is a companion to the extension, not a replacement for it — the
extension is what creates and maintains `.vscode/bookmarks.json`.

## Usage

Configure your MCP client to run the server with `npx`:

```json
{ "mcpServers": { "bookmarks-plus": { "command": "npx", "args": ["-y", "bookmarks-plus-mcp"] } } }
```

## Compatibility

| Server version | Supports mirror schema version |
| --- | --- |
| >= 0.1.0 | <= 2 |

The server refuses to read a mirror file written by a newer schema version
than it supports, rather than silently misreading it.

## Documentation

See the [root README](https://github.com/glitchwerks/vscode-bookmarks-plus#readme)
for the full configuration reference, development setup, and build-from-source
instructions.
