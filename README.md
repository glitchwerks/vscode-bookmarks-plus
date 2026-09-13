# Bookmarks Plus

Bookmark files and folders—not just lines—and keep the parts of a VS Code workspace that matter
close at hand. Bookmarks Plus supports collections, workspace and global bookmarks, multi-root
workspaces, Git-aware grouping, and optional AI-tool access.

![Bookmarks Plus screenshot](images/screenshot.png)

## Highlights

- Bookmark whole files and folders from the Explorer, and bookmark open files from editor tabs.
- Organize bookmarks into collections and reorder them with drag and drop.
- Keep bookmarks with one workspace or place them in **Global** so they appear everywhere.
- Work naturally with multi-root workspaces: each root owns its bookmarks, while removed roots can
  be recovered later.
- Group bookmarks by Git repository or show paths relative to the workspace root.
- See bookmarked resources directly in the Explorer through a `★` decoration.
- Add descriptions to bookmarks and collections, and spot missing targets through warning icons.
- Promote recently opened files from the optional **Suggested** section.
- Let VS Code Chat, Claude, and other MCP clients list or add bookmarks.

## Getting started

1. In VS Code, open the Extensions view (`Ctrl+Shift+X`).
2. Search for **Bookmarks Plus** and select **Install**.
3. Open the **Bookmarks Plus** view from the Activity Bar.
4. Right-click a file, folder, or editor tab and select **Add Bookmark**. Use **Add Bookmark
   (Global)** when the bookmark should be available in every workspace.
5. Create collections from the view title bar, then drag bookmarks to organize them.

Additional management commands, including collection creation and workspace recovery, are
available from the Command Palette under **Bookmarks Plus**.

## Workspace and global bookmarks

Workspace bookmarks belong to a specific workspace root. In a multi-root window, Bookmarks Plus
keeps each root independent and assigns new bookmarks to the deepest root containing the target.
Global bookmarks are available in every workspace.

Each attached root also receives a `.vscode/bookmarks.json` mirror. You can commit that file to
share workspace bookmarks with a team or ignore it to keep them private. Global bookmarks and
recovery-only data are not written to the mirror.

If a workspace root is removed, its bookmarks appear under **Detached** and can be reattached or
salvaged after the folder moves. Legacy data that cannot be assigned safely appears under
**Unassigned**. See the [user guide](docs/user-guide.md) for storage, recovery, suggestions, display
options, and other advanced behavior.

## AI integrations

With VS Code 1.101 or later, Bookmarks Plus automatically registers a native MCP server for each
available workspace root. VS Code Chat agents can use `list_bookmarks` and `add_bookmark` against
the extension's live workspace and global stores.

The repository also includes a standalone MCP server for clients such as Claude Code and Claude
Desktop. It reads the selected workspace's `.vscode/bookmarks.json` mirror, so it works without VS
Code running but does not expose global bookmarks.

See [MCP integrations](docs/mcp.md) for setup, scope, lifecycle, and client-specific guidance.
Developers building another VS Code extension can use the optional
[versioned extension API](docs/extension-api.md) to request a live MCP connection.

## Requirements

- VS Code 1.101.0 or later.
- Git-repository grouping uses VS Code's built-in Git extension when available. Bookmarks Plus
  otherwise works normally and shows unresolved items under **Unknown**.

## Documentation

- [User guide](docs/user-guide.md) — collections, display options, suggestions, storage, and
  workspace recovery.
- [MCP integrations](docs/mcp.md) — VS Code Chat and standalone MCP clients.
- [Extension API](docs/extension-api.md) — consuming the versioned MCP connection API from another
  VS Code extension.
- [Development](docs/development.md) — build, test, and local debugging commands.
- [Contributing](docs/contributing.md) — how to propose and submit changes.
- [Release strategy](docs/release-strategy.md) — version lanes, validation, and publishing.
- [Changelog](CHANGELOG.md) — released changes.

## Contributing

Contributions are welcome. Start with the [contribution guide](docs/contributing.md), and see
[CONTRIBUTORS.md](CONTRIBUTORS.md) for project credits.
