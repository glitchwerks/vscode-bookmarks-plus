import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISABLED_PREFIX, MULTI_ROOT_REASON_SLUG, NO_FOLDER_REASON_SLUG } from '../src/config.js';

// Mirrors the import.meta.url -> directory pattern already established in
// schemaDrift.test.ts, rather than import.meta.dirname (Node >=20.11 only,
// and not a reliably typed ImportMeta property against this project's pinned
// @types/node).
const here = dirname(fileURLToPath(import.meta.url));

// The extension source, reached by walking up from
// dist/test/sentinelDrift.test.js: dist/test -> dist -> mcp-server -> repo
// root -> src/workspaceEnv.ts. Same three-level climb schemaDrift.test.ts
// uses to reach schemas/ from the same compiled location.
//
// readFileSync only -- never `import`. The extension and the MCP server are
// separate packages with no shared build boundary (plan D-D / spec #52 D4);
// importing workspaceEnv.ts here would require a tsconfig.test.json change
// this design deliberately avoids. Reading it as text is what keeps the two
// packages decoupled while still catching drift between their duplicated
// literals.
const extensionSourcePath = join(here, '..', '..', '..', 'src', 'workspaceEnv.ts');
const extensionSource = readFileSync(extensionSourcePath, 'utf8');

// mcp-server's own config.ts, reached by walking up only two levels from
// dist/test (dist/test -> dist -> mcp-server), not three -- this file lives
// inside the mcp-server package itself, unlike workspaceEnv.ts above.
const serverConfigPath = join(here, '..', '..', 'src', 'config.ts');
const serverConfigSource = readFileSync(serverConfigPath, 'utf8');

/**
 * Extracts a `export const NAME = '<value>';` literal from source text in a
 * functional-use context (a quoted string-literal assignment), not via a
 * bare substring scan. A bare substring scan would pass vacuously if the
 * literal only ever appeared inside a comment.
 */
function extractExportedStringConst(source: string, constName: string): string | undefined {
  const pattern = new RegExp(`export const ${constName} = '([^']*)'`);
  return pattern.exec(source)?.[1];
}

// -----------------------------------------------------------------------
// What this file guards against: `src/workspaceEnv.ts` (the extension) and
// `mcp-server/src/config.ts` (this server) each declare their own copy of
// the `disabled:` sentinel prefix and the `multi-root` / `no-folder` reason
// slugs -- deliberately duplicated, not imported across the package
// boundary (plan D-D). If either side renames or reformats one of these
// literals without updating the other, the MCP server would silently stop
// recognizing the extension's disabled-state values: `resolveWorkspaceState`
// (`mcp-server/src/config.ts:L61-L95`) would fall through its
// `disabled:<slug>` branch and try to resolve the extension's un-recognized
// literal as if it were a real workspace path, producing a bogus 'ok' state
// pointed at a nonsensical directory instead of a legible 'disabled' state.
//
// Known fragility (spec `:L262`): these assertions text-scrape
// `src/workspaceEnv.ts` and `mcp-server/src/config.ts` with regexes tied to
// today's exact `export const NAME = '...'` formatting. A future reformat
// (e.g. switching to double quotes, or declaring the constants via an
// object literal instead of individual `export const`s) would make the
// regex stop matching -- which is exactly why every extraction below is
// followed by its own "did the regex match at all" assertion, rather than
// letting a failed extraction fall through into a vacuous `undefined ===
// undefined` comparison.
// -----------------------------------------------------------------------

test('the extension\'s DISABLED_PREFIX literal matches the server\'s DISABLED_PREFIX', () => {
  const extensionValue = extractExportedStringConst(extensionSource, 'DISABLED_PREFIX');

  assert.notEqual(
    extensionValue,
    undefined,
    'could not find `export const DISABLED_PREFIX = \'...\'` in src/workspaceEnv.ts -- ' +
      'update this regex if the constant was legitimately renamed or reformatted',
  );
  assert.equal(extensionValue, DISABLED_PREFIX);
});

test('the extension\'s MULTI_ROOT_SLUG literal matches the server\'s MULTI_ROOT_REASON_SLUG', () => {
  const extensionValue = extractExportedStringConst(extensionSource, 'MULTI_ROOT_SLUG');

  assert.notEqual(
    extensionValue,
    undefined,
    'could not find `export const MULTI_ROOT_SLUG = \'...\'` in src/workspaceEnv.ts -- ' +
      'update this regex if the constant was legitimately renamed or reformatted',
  );
  assert.equal(extensionValue, MULTI_ROOT_REASON_SLUG);
});

test('the extension\'s NO_FOLDER_SLUG literal matches the server\'s NO_FOLDER_REASON_SLUG', () => {
  const extensionValue = extractExportedStringConst(extensionSource, 'NO_FOLDER_SLUG');

  assert.notEqual(
    extensionValue,
    undefined,
    'could not find `export const NO_FOLDER_SLUG = \'...\'` in src/workspaceEnv.ts -- ' +
      'update this regex if the constant was legitimately renamed or reformatted',
  );
  assert.equal(extensionValue, NO_FOLDER_REASON_SLUG);
});

test('the extension\'s WORKSPACE_ENV_VAR name is read by the server in a property-access position', () => {
  // The single most load-bearing string in this feature, and it has no
  // symmetric constant to compare against on the server side: the server
  // reads it as a bare property access, `env.BOOKMARKS_PLUS_WORKSPACE`
  // (mcp-server/src/config.ts:L32,L69), not via an exported constant.
  // Rename WORKSPACE_ENV_VAR on the extension side and the whole feature
  // silently no-ops -- every other assertion in this file would still pass,
  // because they only check the disabled-state sentinel literals, not the
  // variable name itself.
  const extensionVarName = extractExportedStringConst(extensionSource, 'WORKSPACE_ENV_VAR');

  assert.notEqual(
    extensionVarName,
    undefined,
    'could not find `export const WORKSPACE_ENV_VAR = \'...\'` in src/workspaceEnv.ts -- ' +
      'update this regex if the constant was legitimately renamed or reformatted',
  );

  // Anchored to a property-access position (`env.<name>`), not a bare
  // substring scan -- a bare substring scan would pass vacuously if the
  // name only appeared inside a comment (e.g. a "renamed from" note).
  const propertyAccessPattern = new RegExp(`env\\.${extensionVarName}\\b`);
  const matched = propertyAccessPattern.test(serverConfigSource);

  assert.ok(
    matched,
    `expected mcp-server/src/config.ts to read \`env.${extensionVarName}\` -- ` +
      'if this fails, either the extension renamed WORKSPACE_ENV_VAR without updating the server, ' +
      'or the server changed how it reads the variable and this regex needs updating to match',
  );
});
