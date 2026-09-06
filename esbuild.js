const esbuild = require('esbuild');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const MCP_RUNTIME_DEPENDENCIES = ['@modelcontextprotocol/sdk', 'zod'];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(__dirname, relativePath), 'utf8'));
}

function lockedVersion(lockfile, dependency) {
  return lockfile.packages?.[`node_modules/${dependency}`]?.version;
}

function assertMcpBuildDependencies(rootPackage, rootLockfile, mcpLockfile) {
  for (const dependency of MCP_RUNTIME_DEPENDENCIES) {
    const expectedVersion = lockedVersion(mcpLockfile, dependency);
    const declaredVersion = rootPackage.devDependencies?.[dependency];
    const lockedRootVersion = lockedVersion(rootLockfile, dependency);
    const installedPackage = readJson(`node_modules/${dependency}/package.json`);

    if (
      expectedVersion === undefined ||
      declaredVersion !== expectedVersion ||
      lockedRootVersion !== expectedVersion ||
      installedPackage.version !== expectedVersion
    ) {
      throw new Error(
        `MCP build dependency ${dependency} must match the standalone lockfile version ` +
          `${expectedVersion ?? '(missing)'}; root declaration=${declaredVersion ?? '(missing)'}, ` +
          `root lock=${lockedRootVersion ?? '(missing)'}, installed=${installedPackage.version}`,
      );
    }
  }
}

function rootMcpDependenciesPlugin() {
  return {
    name: 'root-mcp-dependencies',
    setup(build) {
      build.onResolve(
        { filter: /^(?:@modelcontextprotocol\/sdk|zod)(?:\/.*)?$/ },
        async (args) => {
          if (args.pluginData?.resolvingFromRoot) {
            return undefined;
          }

          return build.resolve(args.path, {
            importer: args.importer,
            kind: args.kind,
            namespace: args.namespace,
            pluginData: { ...args.pluginData, resolvingFromRoot: true },
            resolveDir: __dirname,
          });
        },
      );
    },
  };
}

async function main() {
  const rootPackage = readJson('package.json');
  const rootLockfile = readJson('package-lock.json');
  const mcpPackage = readJson('mcp-server/package.json');
  const mcpLockfile = readJson('mcp-server/package-lock.json');
  assertMcpBuildDependencies(rootPackage, rootLockfile, mcpLockfile);

  const sharedConfig = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    logLevel: 'info',
  };
  const buildConfigs = [
    {
      ...sharedConfig,
      entryPoints: ['src/extension.ts'],
      format: 'cjs',
      outfile: 'dist/extension.js',
      external: ['vscode'],
    },
    {
      ...sharedConfig,
      entryPoints: ['mcp-server/src/index.ts'],
      format: 'esm',
      outfile: 'dist/bookmarks-plus-mcp.mjs',
      plugins: [rootMcpDependenciesPlugin()],
      define: {
        __BOOKMARKS_PLUS_MCP_VERSION__: JSON.stringify(mcpPackage.version),
      },
    },
  ];
  const contexts = await Promise.all(buildConfigs.map((config) => esbuild.context(config)));

  if (watch) {
    await Promise.all(contexts.map((context) => context.rebuild()));
    await Promise.all(contexts.map((context) => context.watch()));
  } else {
    try {
      await Promise.all(contexts.map((context) => context.rebuild()));
    } finally {
      await Promise.all(contexts.map((context) => context.dispose()));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
