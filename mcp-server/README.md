# bookmarks-plus-mcp

An MCP (Model Context Protocol) server that exposes the workspace bookmarks
managed by the [Bookmarks Plus](https://github.com/glitchwerks/vscode-bookmarks-plus)
VS Code extension to MCP clients such as Claude Desktop and Claude Code. It
reads the workspace's `.vscode/bookmarks.json` mirror file and provides two
tools: listing bookmarks and adding a new bookmark.

This package is a companion to the extension, not a replacement for it — the
extension is what creates and maintains `.vscode/bookmarks.json`.

Direct npm/Claude launches remain workspace-mirror-only and work whether or not VS Code is
running. Global, Detached, and Unassigned bookmarks are not exposed. Concurrent external writes
retain the mirror's last-write-wins behavior.

VS Code-native definitions instead use the bundled server with the extension's live workspace
and global stores. Each returned item and collection includes `scope: "workspace"` or
`scope: "global"`. Native adds default to workspace when both scopes are granted, or to the sole
granted scope; explicit ungranted scopes are rejected. A native bridge failure blocks MCP
initialization and never falls back to the mirror. Failure reports `data.bookmarksPlusCode` and
exits unsuccessfully; readiness has an absolute 10-second deadline (`bridge-unavailable` on expiry).
Restart the server after the extension and selected root are available. Remote extension-host
support is not claimed. See the root README's native MCP section for setup and lifecycle details.

## Usage

Configure your MCP client to run the server with `npx`:

```json
{ "mcpServers": { "bookmarks-plus": { "command": "npx", "args": ["-y", "bookmarks-plus-mcp"] } } }
```

Claude Code supplies its project directory automatically. For Claude Desktop, append an explicit
absolute workspace path to `args`, after `"bookmarks-plus-mcp"`. An explicit path also selects one
root in a multi-root workspace. Without a resolvable workspace, startup fails; a VS Code terminal
`disabled:` sentinel instead starts the standalone server with tools that refuse each call.

## Tool results

Both tools return JSON text and MCP `structuredContent`. Existing standalone list fields remain;
`scope: "workspace"` is additive on every item and collection. For a version-1 mirror:

```json
{
  "workspacePath": "/workspace",
  "mirrorPath": "/workspace/.vscode/bookmarks.json",
  "version": 1,
  "collections": [{ "id": "collection-1", "name": "Core", "order": 0, "scope": "workspace" }],
  "items": [
    { "id": "item-1", "type": "file", "uri": "file:///workspace/src/index.ts", "collectionId": "collection-1", "order": 0, "scope": "workspace" },
    { "id": "item-2", "type": "folder", "uri": "file:///workspace/src/utils", "collectionId": null, "order": 0, "scope": "workspace" }
  ]
}
```

Version-2 mirrors return `version: 2`; an absent or empty mirror omits `version`. Optional
descriptions remain available. Adding `file:///workspace/README.md` to `collection-1` returns
this shape (the ID is generated):

```json
{
  "id": "new-bookmark-id",
  "mirrorPath": "/workspace/.vscode/bookmarks.json",
  "scope": "workspace",
  "collection": { "id": "collection-1", "name": "Core", "order": 0, "scope": "workspace" }
}
```

An uncollected add returns `collection: null`. Standalone adds accept omitted scope or
`scope: "workspace"`; `scope: "global"` is rejected without a write. A returned collection's
scope matches the added bookmark's scope.

Native live list results contain `version`, `workspaceFolderUri`, `grantedScopes`, `collections`,
and `items`, with workspace records before global records. They omit `workspacePath` and
`mirrorPath`. Live add results contain only `id`, `scope`, and `collection`, using the selected
scope; collection lookup stays within that scope. Workspace targets must belong to the selected
root, while global targets may be outside it. Live mutations commit through extension-owned stores.

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
