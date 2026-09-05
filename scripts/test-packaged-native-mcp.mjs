import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import vsce from '@vscode/vsce';
import yauzl from 'yauzl';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const suitePath = join(repoRoot, 'scripts', 'packaged-native-mcp-suite.cjs');

async function removeDirWithRetry(directory) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    await rm(directory, { recursive: true, force: true });
  }
}

function openZip(archivePath) {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, archive) => {
      if (error) {
        reject(error);
      } else {
        resolveOpen(archive);
      }
    });
  });
}

function openEntryStream(archive, entry) {
  return new Promise((resolveStream, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
      } else {
        resolveStream(stream);
      }
    });
  });
}

async function extractVsix(archivePath, destination) {
  const archive = await openZip(archivePath);
  const destinationRoot = resolve(destination);

  await new Promise((resolveExtraction, reject) => {
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        archive.close();
        reject(error);
      }
    };

    archive.on('error', fail);
    archive.on('end', () => {
      if (!settled) {
        settled = true;
        resolveExtraction();
      }
    });
    archive.on('entry', (entry) => {
      void (async () => {
        const normalizedName = entry.fileName.replaceAll('\\', '/');
        const targetPath = resolve(destinationRoot, normalizedName);
        if (
          normalizedName.startsWith('/') ||
          normalizedName.split('/').includes('..') ||
          (targetPath !== destinationRoot && !targetPath.startsWith(`${destinationRoot}${sep}`))
        ) {
          throw new Error(`refusing unsafe VSIX entry: ${entry.fileName}`);
        }

        if (normalizedName.endsWith('/')) {
          mkdirSync(targetPath, { recursive: true });
        } else {
          mkdirSync(dirname(targetPath), { recursive: true });
          const stream = await openEntryStream(archive, entry);
          await pipeline(stream, createWriteStream(targetPath));
        }
        archive.readEntry();
      })().catch(fail);
    });
    archive.readEntry();
  });
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bookmarks-plus-packaged-native-mcp-'));
  const packageDir = join(tempRoot, 'package');
  const extractDir = join(tempRoot, 'extracted');
  const workspaceDir = join(tempRoot, 'workspace');
  const vsixPath = join(packageDir, 'bookmarks-plus.vsix');
  const extensionPath = join(extractDir, 'extension');

  try {
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(workspaceDir, '.vscode'), { recursive: true });
    writeFileSync(
      join(workspaceDir, '.vscode', 'bookmarks.json'),
      `${JSON.stringify({ version: 2, items: [], collections: [] }, null, 2)}\n`,
    );

    execFileSync(process.execPath, ['esbuild.js', '--production'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    await vsce.createVSIX({
      cwd: repoRoot,
      packagePath: vsixPath,
      dependencies: false,
    });
    await extractVsix(vsixPath, extractDir);

    assert.equal(existsSync(join(extensionPath, 'package.json')), true);
    assert.equal(existsSync(join(extensionPath, 'dist', 'extension.js')), true);
    assert.equal(existsSync(join(extensionPath, 'dist', 'bookmarks-plus-mcp.mjs')), true);

    const packagedManifest = JSON.parse(readFileSync(join(extensionPath, 'package.json'), 'utf8'));
    const mcpManifest = JSON.parse(readFileSync(join(repoRoot, 'mcp-server', 'package.json'), 'utf8'));
    assert.equal(packagedManifest.name, 'vscode-bookmarks-plus');

    await runTests({
      version: '1.101.0',
      extensionDevelopmentPath: extensionPath,
      extensionTestsPath: suitePath,
      extensionTestsEnv: {
        BOOKMARKS_PACKAGED_EXTENSION_PATH: extensionPath,
        BOOKMARKS_PACKAGED_WORKSPACE_PATH: workspaceDir,
        BOOKMARKS_PACKAGED_MCP_VERSION: mcpManifest.version,
      },
      launchArgs: [
        workspaceDir,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } finally {
    await removeDirWithRetry(tempRoot);
  }
}

main().catch((error) => {
  console.error('Packaged native MCP integration test failed', error);
  process.exitCode = 1;
});
