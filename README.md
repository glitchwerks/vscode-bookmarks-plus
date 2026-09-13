# vscode-bookmarks-plus

VSCode extension to bookmark files and folders (not just lines) in a workspace, with collections and git-repo awareness.

See `docs/superpowers/specs/` for the design spec.

## Features

- Bookmark whole files and folders — not just lines — per workspace.
- Global bookmarks: a pinned "Global" row in the tree holds bookmarks that are available in every
  workspace, with the same collection, reorder, and drag-and-drop support as workspace bookmarks.
  Moves and reordering stay within whichever scope you're in — dragging a bookmark across scopes
  is refused.
- Organize bookmarks into collections; drag and drop to reorder or move between collections in the same root or Global scope.
- Group the view by git repository, with a dedicated "Unknown" group for anything unresolved.
- **Toggle Show Full Path:** a view-title-bar button switches each bookmark's label between
  filename-only (the default) and its path relative to the workspace root, using `/` separators.
  Combines cleanly with Group by Repo — the relative path doesn't repeat the repo-name prefix the
  grouping already shows. A bookmark outside every workspace folder (including global bookmarks
  with no matching workspace root) falls back to filename-only. The toggle state persists across
  window reloads.
- Broken bookmarks (moved/deleted targets) show a warning icon instead of erroring.
- Add an optional description to any bookmark or collection — shown on hover.
- Each attached workspace root has its own `.vscode/bookmarks.json` mirror. Global, Detached, and
  Unassigned bookmarks are never mirrored — see "The `.vscode/bookmarks.json` mirror" below.
- Bookmarked files and folders show a `★` badge and a "Bookmarked" tooltip directly in VS Code's
  built-in Explorer tree, so you can spot what's bookmarked without opening the Bookmarks Plus
  panel. Covers both workspace and global bookmarks, and updates live as bookmarks change. On by
  default; turn it off with the `bookmarksPlus.explorerDecoration.enabled` setting.
- Right-clicking an already-bookmarked file — in the Explorer or the editor tab/title context
  menu — shows **Remove Bookmark** instead of **Add Bookmark**, and removes the bookmark directly
  from its workspace owner, or from Global if no workspace bookmark matches. When several workspace
  owners contain the resource, select which owner to remove it from. A non-bookmarked file still shows
  **Add Bookmark** as before. Folders keep the existing **Add Bookmark** behavior either way.
- **Add to Workspace:** a global folder bookmark that isn't already inside the current workspace
  gets an inline "Add to Workspace" action, which adds it as a new workspace root. This is VS
  Code's own `updateWorkspaceFolders`, so it may restart the extension host — most likely when
  adding to an empty window, but also when a single-folder workspace becomes multi-folder. Pending
  mirror writes are flushed before adding the folder. Each attached root keeps its own mirror.
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

Workspace bookmarks live in a versioned partition snapshot in VS Code's per-workspace storage.
Each bookmark and collection has a stable root owner. In a multi-root workspace, each attached
folder has its own `.vscode/bookmarks.json`, containing only that folder's bookmarks. Adding,
nesting, or reordering workspace folders does not move existing bookmarks between roots; new
bookmarks use the deepest attached root containing their URI. New collections belong to the
selected root, and creating one from the Command Palette prompts for a root when needed.

Bookmarks whose original root is no longer open appear under **Detached**. Reopening the exact
same root reattaches them automatically when its identity is unambiguous. After a folder move,
use **Bookmarks Plus: Recover Detached Workspace** from the Command Palette or a detached
partition's context menu. Choose **Reattach only** to keep paths unchanged, or **Reattach and
salvage** to preview rebased paths. Only rebased targets that resolve are rewritten; missing and
incompatible entries remain unchanged. Recovery cannot replace an established destination.

Legacy items that cannot be assigned safely, and empty legacy collections, appear under
**Unassigned**. Detached and Unassigned contents remain editable and removable, but cannot receive
new bookmarks or collections. Detached, Unassigned, and Global bookmarks are never written to a
root mirror. A malformed workspace snapshot remains untouched and displays **Workspace data
unavailable**; select that row to open the output channel. Global remains usable.

- **Location:** `.vscode/bookmarks.json`, relative to each attached workspace folder.
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
- **Root isolation:** an external payload with new or changed bookmark URIs outside its owning
  root is rejected as a whole. Existing unchanged bookmarks retain their owner when a nested root
  is added. A failed mirror write affects only that root and is retried from workspace storage.
- **Source control is your choice.** The extension neither commits nor ignores the file. Commit
  it to share a bookmark set with your team, or add `.vscode/bookmarks.json` to `.gitignore` to
  keep it private — bookmarks were private-per-user before this file existed.

## Using bookmarks in VS Code chat (native MCP)

With VS Code 1.101.0 or later, installing Bookmarks Plus also makes its bundled MCP server
available to VS Code automatically. You also need VS Code Chat with Agent mode enabled and an
account and organization policy that permit AI agents and MCP tools. You do not need an
`mcp.json` file, a separate npm package, or a server command: the extension registers a server
named **Bookmarks Plus** for one attached root, or **Bookmarks Plus (<folder name>)** for each
attached root in a multi-root workspace. Repeated folder names include their canonical root URIs.

To find and use it:

1. Open one or more workspace folders in VS Code.
2. Run **MCP: List Servers** from the Command Palette and select **Bookmarks Plus**, or the server
   labeled for your intended root. In VS Code
   1.102 or later, the server also appears under **MCP SERVERS - INSTALLED** in the Extensions
   view.
3. Open Chat in Agent mode, select the tools button, and search for **Bookmarks Plus**. Its
   `list_bookmarks` and `add_bookmark` tools are available to the agent.

VS Code-native definitions use a live bridge to the extension-owned workspace and global stores.
`list_bookmarks` reads current committed state and `add_bookmark` commits through those stores;
the native server does not read or write the mirror directly. Workspace changes are still mirrored
by the extension as described above.

- Each attached root exposes one server bound to that root. It lists the selected root's workspace
  bookmarks followed by global bookmarks, preserving each store's order. Every item and collection
  includes `scope: "workspace"` or `scope: "global"`.
- `add_bookmark` accepts optional `scope`. When both scopes are granted, omission defaults to
  workspace; with one granted scope, omission uses that scope. An ungranted scope is rejected.
  Collections are resolved only within the selected scope. Workspace targets must belong to the
  selected root; global targets may be outside it.
- A successful add returns `id`, `scope`, and `collection` (or `null`). A returned collection has
  the same scope as the added bookmark. Live results contain no `mirrorPath` or `workspacePath`.
- Removing the selected root or reloading the extension closes its live sessions. Restart the MCP
  server to obtain a fresh connection. Unrelated root changes leave other sessions active.
  Unavailable or colliding roots expose no server; a no-folder window exposes none.
- Native bridge failure blocks MCP initialization. The server reports an initialization error with
  `data.bookmarksPlusCode`, closes, and exits unsuccessfully; it never falls back to mirror access.
  A bridge that does not become ready within the absolute 10-second startup deadline fails with
  `bridge-unavailable`. Restart the server after the extension and selected root are available.
- Remote extension-host support is not claimed; it requires a real remote integration test.

For example, a native `list_bookmarks` result is:

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

See VS Code's [MCP server documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
for the editor's server-management and trust controls.

## Using Bookmarks Plus from another VS Code extension

Bookmarks Plus exposes an optional, versioned API to other extensions in the same Node workspace
extension host. Discover it with the extension ID `cbeaulieu-gt.vscode-bookmarks-plus`. Do not
declare it as an `extensionDependencies` dependency when your primary feature works without it:
the producer may be absent, incompatible, unavailable, or disabled in Restricted Mode.

Check Workspace Trust before looking up or activating the producer. In Restricted Mode, continue
with the consumer's normal fallback instead of attempting to obtain an MCP connection:

```ts
import * as vscode from 'vscode';

async function startWithOptionalBookmarksMcp(
  selectedRoot: vscode.WorkspaceFolder
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return launchWithoutBookmarks();
  }

  // Example consumer-owned budget, shared by discovery, activation, and the request.
  const timeoutMs = 5_000;
  const deadline = performance.now() + timeoutMs;
  const discoverDescriptor = async (): Promise<McpConnectionDescriptor | undefined> => {
    const extension = vscode.extensions.getExtension<unknown>(
      'cbeaulieu-gt.vscode-bookmarks-plus'
    );
    if (extension === undefined || performance.now() >= deadline) {
      return undefined;
    }

    const candidate = await extension.activate();
    if (performance.now() >= deadline || !isBookmarksPlusApiV1(candidate) ||
        !candidate.capabilities.mcpConnection.transports.includes('stdio') ||
        !candidate.capabilities.mcpConnection.descriptorVersions.includes(1)) {
      return undefined;
    }

    const result = await candidate.requestMcpConnection({
      workspaceFolderUri: selectedRoot.uri.toString(true),
      scopes: ['workspace', 'global'],
      supportedDescriptorVersions: [1]
    });
    return performance.now() < deadline && result.kind === 'success'
      ? result.descriptor : undefined;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const descriptor = await Promise.race([discoverDescriptor(), timedOut])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));

  // Only the race winner selects a launch. Late promises have no launch side effects.
  // Keep launch errors outside the discovery catch so they cannot start a second launch.
  return descriptor === undefined || performance.now() >= deadline
    ? launchWithoutBookmarks()
    : launchWithMcpDescriptor(descriptor);
}
```

The example uses one finite overall deadline and treats a timeout, rejected promise, or typed
`McpConnectionFailure` as the same graceful fallback. The five-second budget is an example, not an
API requirement; choose a finite budget appropriate for your consumer. A timed-out operation can
still settle later, but its descriptor is discarded. The example's `isBookmarksPlusApiV1` is a
consumer-owned runtime type guard; it must validate `apiVersion.major === 1` and the capabilities
the consumer needs.

The v1 public shapes are:

```ts
export type BookmarkScope = 'workspace' | 'global';

export interface BookmarksPlusApiVersion {
  readonly major: 1;
  readonly minor: number;
}

export type McpTransport = 'stdio';

export interface McpConnectionCapabilities {
  readonly descriptorVersions: readonly number[];
  readonly transports: readonly McpTransport[];
  readonly scopes: readonly BookmarkScope[];
  readonly rootSelection: 'explicit-workspace-folder';
  readonly sessionLifecycle: 'pinned-root';
}

export interface BookmarksPlusCapabilities {
  readonly mcpConnection: McpConnectionCapabilities;
}

export interface BookmarksPlusApiV1 {
  readonly apiVersion: BookmarksPlusApiVersion;
  readonly capabilities: BookmarksPlusCapabilities;
  requestMcpConnection(request: McpConnectionRequest): Promise<McpConnectionResult>;
}

export interface McpConnectionRequest {
  readonly workspaceFolderUri: string;
  readonly scopes: readonly BookmarkScope[];
  readonly supportedDescriptorVersions: readonly number[];
}

export interface McpStdioDescriptorV1 {
  readonly version: 1;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly sensitiveEnvKeys: readonly string[];
  readonly workspaceFolderUri: string;
  readonly grantedScopes: readonly BookmarkScope[];
  readonly bootstrapExpiresAt: string;
}

export type McpConnectionDescriptor = McpStdioDescriptorV1;

export interface McpConnectionSuccess {
  readonly kind: 'success';
  readonly descriptor: McpConnectionDescriptor;
}

export type McpConnectionErrorCode =
  | 'invalid-request'
  | 'unsupported-descriptor-version'
  | 'workspace-folder-not-found'
  | 'workspace-folder-unavailable'
  | 'unsupported-scope'
  | 'stale-request'
  | 'temporarily-unavailable'
  | 'shutting-down';

export interface McpConnectionFailure {
  readonly kind: 'error';
  readonly error: {
    readonly code: McpConnectionErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type McpConnectionResult = McpConnectionSuccess | McpConnectionFailure;
```

### Compatibility and descriptor handling

API major `1` is the compatibility boundary. Minor releases can add optional capabilities or
fields. Consumers and producers negotiate the highest mutually supported descriptor version;
unknown fields are ignored. A field change that an existing descriptor consumer cannot safely
ignore requires a new descriptor version. Breaking a method or result's semantics requires a new
API major.

Treat a successful descriptor as opaque, short-lived launch material. Forward `command`, `args`,
and `env` unchanged to the subprocess. `env` overlays the consumer's inherited environment, with
descriptor values winning on collisions. Do not set a required `cwd`. Redact the value of every key
named in `sensitiveEnvKeys`, and never log or persist the descriptor. Start the process before
`bootstrapExpiresAt`.

Each descriptor names exactly one current workspace root. Its `grantedScopes` use canonical order:
`workspace`, then `global`. Request scopes explicitly; there is no implicit global scope. The
launched process can access workspace-scoped data only from the selected root, excluding other
roots and the unassigned partition. A granted `global` scope exposes the global store, including
bookmarks outside the selected root. Each new process needs a new request and descriptor.

### Trust, lifecycle, and current limitations

After Workspace Trust is granted, any installed extension in the same host may call API v1; the
API does not authenticate an individual calling extension. Both extensions must run in the Node
workspace extension host (`extensionKind` is `"workspace"`). Remote extension-host support is not
claimed.

A bootstrap authorization is single-use. Its expiry applies only before initialization; an active
session has no periodic expiry. Removing the selected root, reloading the producer, or disposing
the producer closes the server. Changes to unrelated roots do not close it. Bookmarks Plus does
not hot-reconnect a running client: a consumer that needs another process or reconnect attempt must
request a fresh descriptor and retain its own fallback behavior.

## Using bookmarks from Claude (MCP server)

`mcp-server/` is a standalone Node/TypeScript package that exposes a workspace's
`.vscode/bookmarks.json` mirror to Claude Desktop and Claude Code over the Model Context
Protocol (stdio). It reads and writes the same mirror file described above — it has no other
connection to the extension and works whether or not VS Code is running. Because the mirror only
ever holds workspace-scoped bookmarks, direct npm/Claude launches remain workspace-mirror-only —
global bookmarks are never visible to those launches. The native live bridge above is supplied
by the extension when VS Code resolves its server definition; it is not standalone configuration.

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
   | Single folder open | the folder's absolute OS path |
   | Two or more folders open | `disabled:multi-root` |
   | No folder open | `disabled:no-folder` |

   The multi-root sentinel remains because a window-wide terminal environment has no selected
   root. Use an explicit workspace argument to serve one root; it takes precedence over the sentinel.

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
argument (tier 1, highest precedence). In a multi-root workspace, pass the path of the root whose
mirror you want to serve:

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

Results are returned as both JSON text and MCP `structuredContent`. Standalone list results keep
`workspacePath`, `mirrorPath`, `version` (for a nonempty mirror), `collections`, and `items`, with
additive `scope: "workspace"` on every collection and item. This example reads a version-1 mirror;
version-2 mirrors return `version: 2`:

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

Adding `file:///workspace/README.md` to `collection-1` returns this shape (the ID is generated):

```json
{
  "id": "new-bookmark-id",
  "mirrorPath": "/workspace/.vscode/bookmarks.json",
  "scope": "workspace",
  "collection": { "id": "collection-1", "name": "Core", "order": 0, "scope": "workspace" }
}
```

An uncollected add returns `collection: null`. Standalone adds accept omitted scope or
`scope: "workspace"`; `scope: "global"` is rejected without a write. Live adds use the same
`id`, `scope`, and `collection` fields with the selected scope, and omit `mirrorPath`.

### Limitations

- **Last write wins.** If VS Code is running and changes bookmarks at the same moment as the
  MCP server, one change is lost. `add_bookmark` verifies its own write after a short delay
  (`BOOKMARKS_MCP_VERIFY_DELAY_MS`, default 400ms) and reports when it did not survive — it
  cannot prevent the loss, only detect it.
- **One selected root per standalone server.** In a multi-root terminal, the automatic environment
  value is `disabled:multi-root`; pass an explicit workspace argument to select a root. Without that
  argument, tools refuse the sentinel individually. A no-folder window has no attached mirror.
  Detached, Unassigned, and Global bookmarks are not exposed by this file-based server.
- **Claude Desktop chat has no automatic workspace resolution.** It must use the explicit `args`
  path form described above — see "Explicit workspace path".
- **No push notifications.** The server re-reads the mirror file fresh on every tool call; it
  does not watch the file or notify the client when bookmarks change.

## Requirements

Requires VS Code 1.101.0 or later. The repo-name badge uses the built-in `vscode.git` extension when it's enabled; the extension works without it, just without badges.

## Installation

Install from the VS Code Marketplace: search **Bookmarks Plus** in the Extensions view (`Ctrl+Shift+X`) and click Install.

## Development

- `npm install` — install dependencies
- `npm run compile` — bundle the extension to `dist/extension.js` and the MCP server to
  `dist/bookmarks-plus-mcp.mjs` via esbuild
- `npm test` — compile tests, then run the full suite in a headless VS Code Extension Development Host
- `npm run test:mcp-bundle` — verify the bundled MCP server and packaged VSIX contents
- `npm run test:packaged-mcp` — check the Restricted Mode process deadline, package a real VSIX,
  verify native provider behavior, and exercise a second extension consuming the returned public
  API in trusted, missing, incompatible, and Restricted Mode scenarios
- Marketplace publishes and GitHub Releases are gated on the MCP bundle check plus packaged-VSIX
  validation on Linux and Windows, all pinned to one immutable tag commit; see
  [`docs/release-strategy.md`](docs/release-strategy.md).
- The automated Marketplace publish rewrites README links and images against that same immutable
  release commit, so previously published versions do not follow later changes on `main`.
- Press F5 in VS Code (or use the "Run Extension" launch config) to open an Extension Development Host with the extension loaded
- `mcp-server/` has its own `package.json`, build, and test suite — not run by the commands
  above. See "Using bookmarks from Claude (MCP server)" for its build steps.
