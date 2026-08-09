# vscode-bookmarks-plus

VSCode extension to bookmark files and folders (not just lines) in a workspace, with collections and git-repo awareness.

See `docs/superpowers/specs/` for the design spec.

## Features

- Bookmark whole files and folders — not just lines — per workspace.
- Organize bookmarks into collections; drag and drop to reorder or move between collections.
- Group the view by git repository, with a dedicated "Unknown" group for anything unresolved.
- Broken bookmarks (moved/deleted targets) show a warning icon instead of erroring.
- Add an optional description to any bookmark or collection — shown on hover.
- Bookmarks are mirrored to `.vscode/bookmarks.json` so external tools can read and edit them.

![Bookmarks Plus screenshot](images/screenshot.png)

## Descriptions

Right-click a bookmark or a collection and choose **Set Description** to attach a free-text
note. The note appears in the hover tooltip. To remove a note, open **Set Description** again,
clear the input box, and submit an empty value.

## The `.vscode/bookmarks.json` mirror

Bookmarks live in VS Code's per-workspace storage. The extension also mirrors them to
`.vscode/bookmarks.json` in your workspace so that other tools — scripts, editors, or an MCP
server — can read and change them.

- **Location:** `.vscode/bookmarks.json`, relative to the workspace folder.
- **When it is written:** shortly after any bookmark change (writes are batched, so a burst of
  drag-and-drop reordering produces one write).
- **External edits are picked up live.** Edit the file in any editor and the Bookmarks view
  updates. Edits made while VS Code is closed are picked up the next time the window opens.
- **Its shape is a semi-public contract.** The file is schema version 2, described by the JSON
  schema shipped with the extension — you get completion and validation when editing it in
  VS Code. Fields may be added in a future schema version; existing fields will not change
  meaning without a version bump.
- **Last write wins.** There is no locking or merging. If the extension and an external tool
  write at the same moment, the later write survives. Malformed or unreadable content is never
  adopted — the extension keeps the bookmarks it already had, logs a line to the
  "Bookmarks Plus" output channel, and leaves your file untouched until your next bookmark change.
- **Single-folder workspaces only.** In a multi-root workspace there is no unambiguous place to
  put the file (the folder order is user-changeable), so the mirror is disabled and a line is
  logged to the output channel. Bookmarks and descriptions work normally.
- **Source control is your choice.** The extension neither commits nor ignores the file. Commit
  it to share a bookmark set with your team, or add `.vscode/bookmarks.json` to `.gitignore` to
  keep it private — bookmarks were private-per-user before this file existed.

## Using bookmarks from Claude (MCP server)

`mcp-server/` is a standalone Node/TypeScript package that exposes a workspace's
`.vscode/bookmarks.json` mirror to Claude Desktop and Claude Code over the Model Context
Protocol (stdio). It reads and writes the same mirror file described above — it has no other
connection to the extension and works whether or not VS Code is running.

### Build

From the repo root:

```
cd mcp-server
npm ci && npm run build
```

This produces `mcp-server/dist/index.js`, the entry point the server config below points at.

### Configure

The server takes the workspace path as either a positional argument or the
`BOOKMARKS_MCP_WORKSPACE` environment variable (the positional argument wins if both are set).
There is no auto-discovery — you must name the workspace explicitly. Use an absolute path to
`mcp-server/dist/index.js` and an absolute path to the workspace.

**Claude Desktop** (`claude_desktop_config.json`):

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

**Claude Code** uses the same `mcpServers` shape (e.g. a project-scoped `.mcp.json`, or a server
added with `claude mcp add`):

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

To use the environment-variable form instead of the positional argument, drop the workspace
path from `args` and set `BOOKMARKS_MCP_WORKSPACE` in the entry's `env` block.

### Tools

- **`list_bookmarks`** — read-only. Lists the workspace's collections and bookmarked
  files/folders, including descriptions.
- **`add_bookmark`** — appends a new bookmark, optionally into an existing collection. Rejects
  an exact duplicate `(uri, collection)` pair and assigns `order` the same way the extension
  does. It **cannot edit or remove** existing bookmarks or collections — that is out of scope
  for this server.

### Limitations

- **Last write wins.** If VS Code is running and changes bookmarks at the same moment as the
  MCP server, one change is lost. `add_bookmark` verifies its own write after a short delay
  (`BOOKMARKS_MCP_VERIFY_DELAY_MS`, default 400ms) and reports when it did not survive — it
  cannot prevent the loss, only detect it.
- **Single-folder workspaces only.** In a multi-root workspace the extension disables the mirror
  file entirely, so the MCP server's writes are never picked up.
- **One workspace per server config entry.** A single tool call never searches across
  workspaces; configure a separate server entry for each workspace you want to reach.
- **No push notifications.** The server re-reads the mirror file fresh on every tool call; it
  does not watch the file or notify the client when bookmarks change.

## Requirements

Requires VS Code 1.85.0 or later. The repo-name badge uses the built-in `vscode.git` extension when it's enabled; the extension works without it, just without badges.

## Installation

Install from the VS Code Marketplace: search **Bookmarks Plus** in the Extensions view (`Ctrl+Shift+X`) and click Install.

## Development

- `npm install` — install dependencies
- `npm run compile` — bundle `src/extension.ts` to `dist/extension.js` via esbuild
- `npm test` — compile tests, then run the full suite in a headless VS Code Extension Development Host
- Press F5 in VS Code (or use the "Run Extension" launch config) to open an Extension Development Host with the extension loaded
- `mcp-server/` has its own `package.json`, build, and test suite — not run by the commands
  above. See "Using bookmarks from Claude (MCP server)" for its build steps.
