# Development guide

## Prerequisites

- Node.js and npm
- VS Code 1.101.0 or later

Install dependencies from the repository root:

```sh
npm install
```

## Build and debug

- `npm run compile` bundles the extension to `dist/extension.js` and the native MCP server to
  `dist/bookmarks-plus-mcp.mjs` with esbuild.
- Press `F5` in VS Code, or use the **Run Extension** launch configuration, to open an Extension
  Development Host.

## Validation

- `npm run lint` runs ESLint.
- `npm test` compiles the extension and tests, then runs the full suite in a headless VS Code
  Extension Development Host.
- `npm run test:mcp-bundle` verifies the bundled MCP server and packaged VSIX contents.
- `npm run test:packaged-mcp` packages a real VSIX and checks the Restricted Mode deadline, native
  provider behavior, and a second extension consuming the public API in trusted, missing,
  incompatible, and Restricted Mode scenarios.

Marketplace publishing and GitHub Releases are gated on the bundle and packaged-VSIX validation on
Linux and Windows. See the [release strategy](release-strategy.md) for the complete release process.

## Standalone MCP server

The standalone server under `mcp-server/` has its own `package.json`, build, and test suite. See its
[README](../mcp-server/README.md) for source-build and configuration instructions. Its tests are not
included in the root `npm test` command.

## Documentation map

- [User guide](user-guide.md)
- [MCP integrations](mcp.md)
- [Extension API consumer guide](extension-api.md)
- [Contributing](contributing.md)
- [Release strategy](release-strategy.md)
