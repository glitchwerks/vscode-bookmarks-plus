# vscode-bookmarks-plus

VSCode extension to bookmark files and folders (not just lines) in a workspace, with collections and git-repo awareness.

See `docs/superpowers/specs/` for the design spec.

## Features

- Bookmark whole files and folders — not just lines — per workspace.
- Global bookmarks: a pinned "Global" row in the tree holds bookmarks that are available in every
  workspace, with the same collection, reorder, and drag-and-drop support as workspace bookmarks.
  Moves and reordering stay within whichever scope you're in — dragging a bookmark across scopes
  is refused.
- Organize bookmarks into collections; drag and drop to reorder or move between collections.
- Group the view by git repository, with a dedicated "Unknown" group for anything unresolved.
- Broken bookmarks (moved/deleted targets) show a warning icon instead of erroring.
- Add an optional description to any bookmark or collection — shown on hover.
- Workspace bookmarks are mirrored to `.vscode/bookmarks.json` so external tools can read and edit
  them. Global bookmarks are never mirrored — see "The `.vscode/bookmarks.json` mirror" below.
- Bookmarked files and folders show a `★` badge and a "Bookmarked" tooltip directly in VS Code's
  built-in Explorer tree, so you can spot what's bookmarked without opening the Bookmarks Plus
  panel. Covers both workspace and global bookmarks, and updates live as bookmarks change. On by
  default; turn it off with the `bookmarksPlus.explorerDecoration.enabled` setting.
- Right-clicking an already-bookmarked file — in the Explorer or the editor tab/title context
  menu — shows **Remove Bookmark** instead of **Add Bookmark**, and removes the bookmark directly
  from whichever scope (workspace or global) it's bookmarked in. A non-bookmarked file still shows
  **Add Bookmark** as before. Folders keep the existing **Add Bookmark** behavior either way.
- **Add to Workspace:** a global folder bookmark that isn't already inside the current workspace
  gets an inline "Add to Workspace" action, which adds it as a new workspace root. This is VS
  Code's own `updateWorkspaceFolders`, so it may restart the extension host — most likely when
  adding to an empty window, but also when a single-folder workspace becomes multi-folder. You're
  asked to confirm only for the single-folder → multi-folder case, since that's also when it
  disables the `.vscode/bookmarks.json` mirror (see "The `.vscode/bookmarks.json` mirror" below);
  adding to an empty window or an already multi-folder workspace proceeds without a prompt. Full
  caveats, including a command-palette gap tracked as a follow-up, are in
  [the design spec](docs/superpowers/specs/2026-07-22-vscode-bookmarks-plus-design.md#5-commands).
- **Suggested bookmarks:** a "Suggested" row at the bottom of the tree lists recently opened files
  that aren't bookmarked yet, most-recently-promoted first. Reopening a file that's already a
  suggestion does not move it — its position is set once, when it's first promoted into the list.
  Each suggestion opens directly in an editor tab, and a one-click action promotes it into a real
  bookmark. Preview tabs (a single
  click in the Explorer) only turn into a suggestion once the same file has been previewed three
  times, so briefly glancing at a file doesn't clutter the list; opening a file for real (double
  click, or editing it) surfaces it immediately. Controlled by the
  `bookmarksPlus.suggestions.maxItems` setting (default `10`; set to `0` to hide the section).

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
- **Global bookmarks are never mirrored.** The mirror only ever reflects the workspace-scoped
  store — there is no unambiguous single-workspace location to write a global bookmark's mirror
  entry to. Global bookmarks are invisible to `.vscode/bookmarks.json` and, by extension, to
  anything that only reads that file (see "Using bookmarks from Claude (MCP server)" below).
- **Source control is your choice.** The extension neither commits nor ignores the file. Commit
  it to share a bookmark set with your team, or add `.vscode/bookmarks.json` to `.gitignore` to
  keep it private — bookmarks were private-per-user before this file existed.

## Using bookmarks from Claude (MCP server)

`mcp-server/` is a standalone Node/TypeScript package that exposes a workspace's
`.vscode/bookmarks.json` mirror to Claude Desktop and Claude Code over the Model Context
Protocol (stdio). It reads and writes the same mirror file described above — it has no other
connection to the extension and works whether or not VS Code is running. Because the mirror only
ever holds workspace-scoped bookmarks, the MCP server only ever sees those — global bookmarks are
never visible to it.

### Build

From the repo root:

```sh
cd mcp-server
npm ci && npm run build
```

This produces `mcp-server/dist/index.js`, the entry point the server config below points at.

### Configure

The server resolves the workspace it should serve from up to four sources, checked in this
order, stopping at the first one present:

1. **An explicit path** — the `args` positional argument in the registration entry.
2. **`BOOKMARKS_PLUS_WORKSPACE`** — set automatically by the Bookmarks Plus VS Code extension in
   every integrated terminal it launches, provided the extension is installed and active in that
   window:

   | Window state | `BOOKMARKS_PLUS_WORKSPACE` value |
   | --- | --- |
   | Single folder open (mirror enabled) | the folder's absolute OS path |
   | Two or more folders open | `disabled:multi-root` |
   | No folder open | `disabled:no-folder` |

   A terminal opened before the extension activated, or before the workspace folders last
   changed, keeps its original value — reopen the terminal to pick up a change. A `disabled:`
   value stops resolution here — tiers 3 and 4 below are **not** consulted, even if
   `CLAUDE_PROJECT_DIR` would otherwise resolve. The server still starts in that case; it refuses
   each tool call individually instead (see "Limitations" below) — a different failure mode from
   "none of the four resolve," which refuses to start at all.
3. **`CLAUDE_PROJECT_DIR`** — set automatically by Claude Code in the environment of any MCP
   server it spawns for a project (an integrated VS Code terminal, or `claude` run from inside a
   project directory). This is what lets the recommended registration below carry no workspace
   path at all.
4. **`BOOKMARKS_MCP_WORKSPACE`** — a legacy environment variable, checked last. See the
   migration note below if you configured the server this way previously.

If none of the four resolve, the server refuses to start.

#### Recommended: project-scoped, path-free (Claude Code)

Register the server per-project in a committed `.mcp.json`, with **no workspace path in
`args`** — tier 3 above resolves it automatically:

```json
{
  "mcpServers": {
    "bookmarks-plus": {
      "command": "node",
      "args": ["${BOOKMARKS_PLUS_MCP:-/absolute/fallback/path/to/mcp-server/dist/index.js}"]
    }
  }
}
```

The entry is byte-identical across every project that wants it, so it can be committed and
shared. Each developer sets `BOOKMARKS_PLUS_MCP` once per machine, to the absolute path of their
local `mcp-server/dist/index.js`; the `${VAR:-default}` form keeps the file loadable even for a
developer who hasn't set it, falling back to the given default path. `claude mcp add --scope
project` can generate the same `.mcp.json` entry for you instead of hand-writing it.

**First use prompts for approval.** Claude Code asks for one-time approval before using a
project-scoped server defined in `.mcp.json`. This is expected, not a bug — reset your choices
with `claude mcp reset-project-choices` if needed.

**Don't register the same server name at both project and user scope.** If `bookmarks-plus` is
defined in both `.mcp.json` (project scope) and `~/.claude.json` (user scope), the CLI and
Claude Desktop's Code tab can resolve to different definitions: the Code tab uses the
`~/.claude.json` (user-scope) entry, departing from the CLI's own scope precedence. If you
previously tried a user-scope entry and are switching to the project-scoped form above, remove
the old one — otherwise the CLI and the Code tab will silently point at different workspaces.

#### Explicit workspace path

To pin a specific workspace regardless of auto-detection, pass it as the `args` positional
argument (tier 1, highest precedence — this is unchanged from before):

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

**This is the only supported form for Claude Desktop's standalone chat interface.** Desktop
chat has no per-session project concept — it never spawns from a VS Code terminal, so none of
the automatic resolution above applies there. This is a permanent limitation of the design, not
a gap to be closed later; Desktop chat users must always configure an explicit workspace path.

#### Legacy: `BOOKMARKS_MCP_WORKSPACE` — behavior change

`BOOKMARKS_MCP_WORKSPACE` used to be the documented way to configure the server without an
`args` path: set it in the entry's `env` block, or export it from a shell profile. It still
works, but it is now checked *after* `CLAUDE_PROJECT_DIR` (tier 4 of 4, not tier 2). Under
Claude Code, that means a `BOOKMARKS_MCP_WORKSPACE` value is now **silently overridden** by the
auto-detected project directory whenever one is available — the two only agree by coincidence.

If you configured the server this way before, switch to the path-free entry above. If you
specifically need a fixed workspace that Claude Code's own project detection cannot override,
use the explicit `args` path form instead — `BOOKMARKS_MCP_WORKSPACE` is no longer a reliable
way to pin a workspace under Claude Code.

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
- **Single-folder workspaces only.** In a multi-root workspace, or in a window with no folder
  open, the extension does not maintain the `.vscode/bookmarks.json` mirror. If the extension is
  installed and active in that window, it also reports the state to the MCP server via
  `BOOKMARKS_PLUS_WORKSPACE` (see "Configure" above), so every tool call — `list_bookmarks`,
  `add_bookmark` — refuses individually with a message explaining why. If the extension is not
  installed or not active, nothing sets that variable, resolution falls through to
  `CLAUDE_PROJECT_DIR` or the legacy variable, and the server has no way to know the mirror is
  unavailable — `add_bookmark` writes still succeed, but the extension never picks them up.
- **Claude Desktop chat has no automatic workspace resolution.** It must use the explicit `args`
  path form described above — see "Explicit workspace path".
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
