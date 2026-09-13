# bookmarks-plus-mcp

The standalone MCP server exposes workspace bookmarks managed by the
[Bookmarks Plus](https://github.com/glitchwerks/vscode-bookmarks-plus) VS Code extension to clients
such as Claude Code and Claude Desktop. It reads and writes one workspace's
`.vscode/bookmarks.json` mirror and provides `list_bookmarks` and `add_bookmark`.

The extension creates and maintains the mirror, but the server works whether or not VS Code is
running. Global, Detached, and Unassigned bookmarks are not mirrored and therefore are not exposed
by standalone launches. See
[MCP integrations](https://github.com/glitchwerks/vscode-bookmarks-plus/blob/main/docs/mcp.md)
for the difference between this server and VS Code's live native integration.

## Build from source

From this directory:

```sh
npm ci
npm run build
```

This produces `dist/index.js`, which the configurations below use as the server entry point.

## Workspace resolution

The server resolves its workspace from four sources, stopping at the first one present:

1. **An explicit path** supplied as the positional argument after `dist/index.js`.
2. **`BOOKMARKS_PLUS_WORKSPACE`**, set by Bookmarks Plus in integrated terminals:

   | Window state | Value |
   | --- | --- |
   | Single folder | The folder's absolute OS path |
   | Multiple folders | `disabled:multi-root` |
   | No folder | `disabled:no-folder` |

   A terminal keeps the value it received when it opened; reopen it after workspace changes. A
   `disabled:` value stops resolution and makes individual tool calls fail. An explicit path takes
   precedence and can select one root from a multi-root workspace.
3. **`CLAUDE_PROJECT_DIR`**, supplied by Claude Code for the current project.
4. **`BOOKMARKS_MCP_WORKSPACE`**, retained as a legacy fallback.

If none of these resolves, the server refuses to start.

## Claude Code

For a source checkout, register the server per project in `.mcp.json` and omit the workspace path.
Claude Code supplies `CLAUDE_PROJECT_DIR` automatically:

```json
{
  "mcpServers": {
    "bookmarks-plus": {
      "command": "node",
      "args": ["${BOOKMARKS_PLUS_MCP:-/absolute/path/to/mcp-server/dist/index.js}"]
    }
  }
}
```

Set `BOOKMARKS_PLUS_MCP` once per machine to the absolute path of the built `dist/index.js`. The
fallback keeps the project file loadable before that environment variable is configured.

Claude Code asks for one-time approval before using a project-scoped server from `.mcp.json`. Reset
that choice with `claude mcp reset-project-choices` when needed.

Do not register the same `bookmarks-plus` name at both project and user scope. The CLI and Claude
Desktop's Code tab can select different definitions when both exist, making them point at different
workspaces.

## Explicit workspace path

Pass a workspace path after the server entry point to pin a specific root regardless of automatic
resolution:

```json
{
  "mcpServers": {
    "bookmarks-plus": {
      "command": "node",
      "args": [
        "/absolute/path/to/vscode-bookmarks-plus/mcp-server/dist/index.js",
        "/absolute/path/to/your/workspace"
      ]
    }
  }
}
```

This is the supported form for Claude Desktop's standalone chat interface, which has no per-session
project directory. It is also the way to select one root in a multi-root workspace.

## Migrating from `BOOKMARKS_MCP_WORKSPACE`

`BOOKMARKS_MCP_WORKSPACE` is checked after `CLAUDE_PROJECT_DIR`. Under Claude Code, an automatically
detected project therefore overrides the legacy variable. Use the path-free project entry above
for normal project resolution, or an explicit positional path when a fixed workspace must win.

## Tools

- **`list_bookmarks`** lists collections and bookmarked files and folders, including descriptions.
- **`add_bookmark`** appends a bookmark, optionally to an existing collection. It rejects an exact
  duplicate `(uri, collection)` pair. It cannot edit or remove bookmarks or collections.

Both return JSON text and MCP `structuredContent`. Records include additive
`scope: "workspace"`. A list result for a version-2 mirror has this shape:

```json
{
  "workspacePath": "/workspace",
  "mirrorPath": "/workspace/.vscode/bookmarks.json",
  "version": 2,
  "collections": [
    { "id": "collection-1", "name": "Core", "order": 0, "scope": "workspace" }
  ],
  "items": [
    { "id": "item-1", "type": "file", "uri": "file:///workspace/src/index.ts", "collectionId": "collection-1", "order": 0, "scope": "workspace" }
  ]
}
```

An absent or empty mirror omits `version`. The server accepts mirrors through schema version 2 and
refuses newer schemas rather than silently misreading them.

A successful add returns:

```json
{
  "id": "new-bookmark-id",
  "mirrorPath": "/workspace/.vscode/bookmarks.json",
  "scope": "workspace",
  "collection": { "id": "collection-1", "name": "Core", "order": 0, "scope": "workspace" }
}
```

An uncollected add returns `collection: null`. Omitted scope and `scope: "workspace"` are accepted;
`scope: "global"` is rejected without a write.

## Limitations

- **Last write wins.** If VS Code and the server change bookmarks concurrently, one change can be
  lost. `add_bookmark` verifies its write after a short delay (`BOOKMARKS_MCP_VERIFY_DELAY_MS`,
  default 400 ms) and reports when it did not survive, but cannot prevent the race.
- **One root per process.** Automatic resolution is disabled in multi-root terminals. Supply an
  explicit path to select a root.
- **No Global, Detached, or Unassigned data.** These scopes do not exist in the mirror.
- **Claude Desktop needs an explicit path.** Its standalone chat has no automatic project
  resolution.
- **No push notifications.** The server rereads the mirror for every tool call and does not watch
  the file or notify clients when bookmarks change.
