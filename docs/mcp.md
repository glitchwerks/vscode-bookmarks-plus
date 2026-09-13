# MCP integrations

Bookmarks Plus supports two MCP connection models:

| Integration | Data source | Available scopes | Best for |
| --- | --- | --- | --- |
| VS Code native | Live extension stores | Selected workspace root and optionally Global | VS Code Chat and extensions in the same workspace host |
| Standalone server | `.vscode/bookmarks.json` | One workspace root | Claude Code, Claude Desktop, and other external MCP clients |

Both models expose `list_bookmarks` and `add_bookmark`.

## VS Code Chat

With VS Code 1.101.0 or later, installing Bookmarks Plus automatically makes its bundled MCP server
available to VS Code. VS Code Chat must have Agent mode enabled, and your account and organization
policy must permit AI agents and MCP tools. No `mcp.json`, separate package, or server command is
required.

To enable the tools:

1. Open one or more workspace folders.
2. Run **MCP: List Servers** from the Command Palette and select **Bookmarks Plus**, or the server
   labeled for the intended root. In VS Code 1.102 or later, installed servers also appear under
   **MCP SERVERS - INSTALLED** in the Extensions view.
3. Open Chat in Agent mode, select the tools button, and search for **Bookmarks Plus**.

A single-root workspace exposes **Bookmarks Plus**. A multi-root workspace exposes one server per
root named **Bookmarks Plus (<folder name>)**; repeated folder names include their canonical root
URIs. A no-folder window exposes no server.

### Native scopes and results

Each native server is bound to one workspace root. `list_bookmarks` returns that root's workspace
bookmarks followed by global bookmarks, preserving each store's order. Items and collections
include `scope: "workspace"` or `scope: "global"`.

`add_bookmark` accepts an optional `scope`. When both scopes are granted, omission defaults to
workspace; with one granted scope, omission selects that scope. An ungranted scope is rejected.
Collections are resolved only within the selected scope. Workspace targets must belong to the
selected root; global targets may be outside it.

A successful add returns `id`, `scope`, and `collection` (or `null`). Native results contain no
`mirrorPath` or `workspacePath` because mutations commit through extension-owned stores rather
than the mirror.

Example list result:

```json
{
  "version": 2,
  "workspaceFolderUri": "file:///workspace",
  "grantedScopes": ["workspace", "global"],
  "collections": [],
  "items": [
    { "id": "workspace-id", "type": "file", "uri": "file:///workspace/README.md", "collectionId": null, "order": 0, "scope": "workspace" },
    { "id": "global-id", "type": "folder", "uri": "file:///shared", "collectionId": null, "order": 0, "scope": "global" }
  ]
}
```

### Native lifecycle and limitations

Removing the selected root or reloading or disposing the extension closes its live sessions.
Restart the MCP server to obtain a fresh connection. Changes to unrelated roots leave other
sessions active.

Native bridge failure blocks MCP initialization. The server reports an initialization error with
`data.bookmarksPlusCode`, closes, and exits unsuccessfully; it never falls back to mirror access.
A bridge that does not become ready within the absolute 10-second startup deadline fails with
`bridge-unavailable`. Restart after the extension and selected root are available.

Unavailable or colliding roots expose no server. Remote extension-host support is not currently
claimed because it requires a real remote integration test.

See VS Code's [MCP server documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
for server-management and trust controls.

## Standalone MCP clients

The standalone server under [`mcp-server/`](../mcp-server/) reads and writes one workspace root's
`.vscode/bookmarks.json` mirror. It works whether or not VS Code is running. Because Global,
Detached, and Unassigned data is not mirrored, those scopes are unavailable to standalone clients.

See the [standalone server README](../mcp-server/README.md) for source builds, workspace resolution,
Claude Code and Claude Desktop configuration, tool results, and concurrency limitations.

## Integrating another VS Code extension

Another extension running in the same Node workspace extension host can request a short-lived
descriptor for the live server. See the [extension API guide](extension-api.md) for discovery,
compatibility, trust, descriptor handling, and lifecycle requirements.
