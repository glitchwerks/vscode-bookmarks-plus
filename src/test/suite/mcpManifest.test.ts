import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface ExtensionManifest {
  engines?: { vscode?: string };
  contributes?: {
    mcpServerDefinitionProviders?: Array<{ id: string; label: string }>;
  };
  devDependencies?: Record<string, string>;
}

function readManifest(): ExtensionManifest {
  const manifestPath = path.resolve(__dirname, '../../../package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
}

suite('MCP provider manifest contract (#126)', () => {
  test('declares the VS Code 1.101 runtime and type floors', () => {
    const manifest = readManifest();

    assert.strictEqual(manifest.engines?.vscode, '^1.101.0');
    assert.strictEqual(manifest.devDependencies?.['@types/vscode'], '1.101.0');
  });

  test('contributes the provider identifier used by Bookmarks Plus', () => {
    const manifest = readManifest();

    assert.deepStrictEqual(manifest.contributes?.mcpServerDefinitionProviders, [
      { id: 'bookmarks-plus.mcp', label: 'Bookmarks Plus' }
    ]);
  });
});
