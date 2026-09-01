import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { execSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Issue #66 / T3 (plan `docs/superpowers/plans/2026-08-30-publish-mcp-server-to-npm.md`,
// §6 T3, §4 E2): the automated form of E2, "the highest-severity check in this
// plan". E2 was already run manually and passed (real `npm pack` -> real
// `npm install` into a scratch dir -> npm's real generated shim -> `npx
// bookmarks-plus-mcp <workspace>` -> `initialize` + `tools/list` over stdin ->
// both tools came back). This file codifies that same procedure as a
// permanent regression guard so a future change to `isEntrypoint()`
// (`src/index.ts`), to the `bin` mapping, or to npm's shim generation can
// never again regress into "the process starts, exits cleanly, and the MCP
// client shows zero tools with no error" (E2's own description of the
// failure mode) without CI catching it.
//
// PLACEMENT DECISION (required by T3: "If runtime cost is too high for the
// default `npm test`, make it a separate script invoked only by CI -- record
// which"):
//
//   Chosen: (b) -- excluded from the default `npm test` run; wired to a
//   dedicated `npm run test:packaging` script (see mcp-server/package.json).
//
//   Reasoning: this file is the only test in the suite whose critical path
//   requires a REAL registry network call. `npm pack` and the pack-content
//   assertions in verifyPack.test.ts are network-free (they build from the
//   already-installed local node_modules); this file additionally runs `npm
//   install <tarball>` into a bare scratch directory with no pre-existing
//   node_modules, which must fetch the package's own production
//   dependencies (@modelcontextprotocol/sdk, zod, and their own transitive
//   trees) from the registry. That is a categorically different -- and
//   categorically less reliable in a sandboxed/offline/CI-network-restricted
//   environment -- cost than the rest of the suite's 100+ fast, hermetic
//   tests. Folding a multi-second, network-dependent smoke test into every
//   local `npm test` invocation would make the default dev loop flaky and
//   slow for no benefit to the tests that make up that loop; the value this
//   test provides (permanent E2 regression coverage) is exactly the kind
//   that belongs in CI, not in the fast inner loop.
//
//   Mechanism: the test below is gated on `process.env.npm_lifecycle_event
//   === 'test:packaging'` and self-skips (via node:test's `{ skip }` option,
//   not a hard failure) otherwise. This is a zero-configuration signal --
//   npm itself sets `npm_lifecycle_event` to the name of whichever script it
//   is currently running, on every platform, with no shell-specific syntax
//   and no extra dependency (unlike setting a custom env var portably from
//   inside a package.json script string, which differs between cmd.exe and
//   POSIX shells and would otherwise require a `cross-env`-style
//   dependency). The compiled file still lands at `dist/test/packaging.test.js`
//   and is still matched by the default `test` script's
//   `"dist/test/**/*.test.js"` glob (Node's test runner CLI has no exclude-glob
//   syntax -- confirmed empirically while authoring this file: a `!`-prefixed
//   negation pattern passed alongside the positive glob was silently ignored
//   and the negated file still ran), so the self-skip guard -- not the glob
//   -- is what keeps it out of the default run. Running it via
//   `npm run test:packaging` (or, for manual/local verification, via
//   `npm_lifecycle_event=test:packaging node --test dist/test/packaging.test.js`)
//   sets the flag and lets it run for real.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
// dist/test -> dist -> mcp-server (same convention as verifyPack.test.ts /
// index.test.ts's `here`-derivation comments).
const mcpServerRoot = join(here, '..', '..');

// `npm`/`npx` are `.cmd` shims on Windows, and Node's `child_process` cannot
// spawn a `.cmd` file directly without going through a shell (confirmed
// empirically while authoring this file: a direct
// `execFileSync('npm.cmd', [...])` fails with `EINVAL`). `execSync` (single
// command string, always shell-routed) is used for the two blocking pack/
// install steps below -- the same choice scripts/verify-pack.mjs documents
// and for the same reason -- and `spawn(..., { shell: true })` with a single
// command string (no separate `args` array) for the long-lived npx child, to
// avoid Node's DEP0190 warning about combining `shell: true` with an `args`
// array. Every interpolated path below is wrapped in double quotes to
// survive spaces in a temp-dir path on either platform.
function quoted(path: string): string {
  return `"${path}"`;
}

const DEDICATED_SCRIPT_NAME = 'test:packaging';
const RUN_VIA_DEDICATED_SCRIPT = process.env.npm_lifecycle_event === DEDICATED_SCRIPT_NAME;
const SKIP_REASON =
  'This is a real npm pack + npm install (registry network call) smoke test -- ' +
  `it only runs via \`npm run ${DEDICATED_SCRIPT_NAME}\` (or with npm_lifecycle_event=${DEDICATED_SCRIPT_NAME} ` +
  'set manually), never as part of the default `npm test` run. See this file\'s header comment.';

// Mirrors mcp-server/test/fixtures/v1-basic.json's shape exactly (same
// version/items/collections contract asserted by mirrorFile.test.ts /
// contract.test.ts). Inlined as a literal rather than read from
// dist/test/fixtures/v1-basic.json at runtime: this test's own `npm pack`
// call below runs the real `prepack` -> `build` -> `clean` chain against the
// live mcp-server/dist directory, which deletes dist/test/** (including
// whatever this very test file's own compiled fixtures copy would have been)
// partway through the test. Inlining removes any dependency on that
// directory surviving until this point.
const MIRROR_FIXTURE = {
  version: 1,
  items: [
    {
      id: 'item-1',
      type: 'file',
      uri: 'file:///workspace/src/index.ts',
      collectionId: 'collection-1',
      order: 0,
    },
    {
      id: 'item-2',
      type: 'folder',
      uri: 'file:///workspace/src/utils',
      collectionId: null,
      order: 0,
    },
  ],
  collections: [{ id: 'collection-1', name: 'Core', order: 0 }],
};

interface PackEntry {
  filename: string;
  files: Array<{ path: string }>;
}

/** Locates and parses the JSON payload from `npm pack --json` output, which
 * some npm versions/configurations prefix with warning lines on stdout
 * (same defensive convention as scripts/verify-pack.mjs). */
function parsePackJson(stdout: string): PackEntry {
  const jsonStart = stdout.search(/[[{]/);
  const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
  const parsed = JSON.parse(jsonText) as PackEntry | PackEntry[];
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/**
 * Buffers `child`'s stdout, splitting on newlines (the MCP stdio transport's
 * framing), and resolves with the first parsed JSON-RPC message whose `id`
 * matches, or `undefined` if the child exits first without ever producing
 * one. Adapted from test/index.test.ts's `collectJsonRpcResponse` (not
 * imported -- that helper is private to that file) for the same
 * newline-delimited JSON-RPC framing this test also needs.
 */
function collectJsonRpcResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;

    const finish = (value: Record<string, unknown> | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      resolve(value);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === id) {
            finish(parsed);
            return;
          }
        } catch {
          // Non-JSON stdout noise -- ignore rather than fail on a stray line.
        }
      }
    };
    const onExit = (): void => finish(undefined);

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function waitFor<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Removes a directory, retrying once after a short delay on failure.
 * Windows-specific gotcha: deleting a scratch dir immediately after
 * `child.kill()` can throw EPERM/EBUSY if the killed process's file handles
 * (e.g. into its own node_modules) have not yet released -- one retry after
 * a brief pause covers that without failing the test over a cleanup race. */
async function removeDirWithRetry(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`packaging.test.ts: failed to remove scratch dir ${dir} after retry:`, err);
    }
  }
}

const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) {
    await removeDirWithRetry(dir);
  }
});

// ---------------------------------------------------------------------------
// Unconditional, network-free, sub-millisecond guard for the skip mechanism
// itself. The heavy test below silently no-ops (skip, not fail) whenever
// `npm_lifecycle_event !== 'test:packaging'` -- which is exactly what would
// happen if `test:packaging` were ever renamed, pointed at the wrong file, or
// removed from mcp-server/package.json (e.g. by T4's separate CI wiring, or a
// future refactor), all without this file's own default-`npm test` run ever
// turning red. That would defeat the whole point of T3: a permanent guard
// against a *silent* failure mode must not itself have a silent failure mode.
// This test runs every time (never skipped) and asserts the wiring the skip
// mechanism depends on still exists, so a broken/renamed/removed
// `test:packaging` script turns the default `npm test` red instead of just
// quietly never running the real smoke test again.
// ---------------------------------------------------------------------------

test('mcp-server/package.json still wires a `test:packaging` script that targets the compiled packaging smoke test', () => {
  const packageJson = JSON.parse(readFileSync(join(mcpServerRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  const script = packageJson.scripts?.[DEDICATED_SCRIPT_NAME];
  assert.ok(
    typeof script === 'string',
    `expected mcp-server/package.json's "scripts" to declare "${DEDICATED_SCRIPT_NAME}" -- ` +
      'without it, this file\'s skip guard silently never runs the real smoke test in CI.',
  );
  assert.ok(
    script!.includes('dist/test/packaging.test.js'),
    `expected the "${DEDICATED_SCRIPT_NAME}" script to target dist/test/packaging.test.js, got: ${script}`,
  );
});

test(
  'the real, packed, npm-installed tarball starts and answers tools/list with both tools when spawned via npx exactly as an MCP client would (E2, automated)',
  { skip: RUN_VIA_DEDICATED_SCRIPT ? false : SKIP_REASON, timeout: 180_000 },
  async () => {
    // 1. Pack the real tarball. `npm pack`'s `prepack` runs the real build
    // (T1 moved it off `prepublishOnly`), so this is a real, complete,
    // publishable tarball -- not a hand-rolled or `--dry-run` stand-in
    // (forbidden by constraint 3.2 / T2's header). `--pack-destination`
    // writes the .tgz into a scratch dir instead of littering the live
    // mcp-server directory with a build artifact.
    const packDestDir = mkdtempSync(join(tmpdir(), 'bookmarks-mcp-pack-'));
    tempDirs.push(packDestDir);

    const packStdout = execSync(
      `npm pack --json --pack-destination ${quoted(packDestDir)}`,
      {
        cwd: mcpServerRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const packEntry = parsePackJson(packStdout);
    const tarballPath = join(packDestDir, packEntry.filename);

    assert.ok(
      readdirSync(packDestDir).includes(packEntry.filename),
      `expected npm pack to write ${packEntry.filename} into ${packDestDir}`,
    );

    // 2. Install the real tarball into a fresh scratch directory -- a real
    // `npm install`, pulling the package's own runtime dependencies
    // (@modelcontextprotocol/sdk, zod) from the registry, same as any real
    // consumer's first install. A minimal package.json avoids npm treating
    // the bare directory as an ad hoc install target in a way that produces
    // a different dependency-resolution shape than a normal project would.
    const installDir = mkdtempSync(join(tmpdir(), 'bookmarks-mcp-install-'));
    tempDirs.push(installDir);
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({ name: 'packaging-test-scratch', private: true, version: '0.0.0' }, null, 2),
    );

    execSync(`npm install ${quoted(tarballPath)} --no-audit --no-fund`, {
      cwd: installDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    // 3. A temp workspace with a .vscode/bookmarks.json mirror file -- the
    // argument a real MCP client config supplies as the workspace path
    // (README.md's "explicit workspace path" form).
    const workspaceDir = mkdtempSync(join(tmpdir(), 'bookmarks-mcp-workspace-'));
    tempDirs.push(workspaceDir);
    mkdirSync(join(workspaceDir, '.vscode'), { recursive: true });
    writeFileSync(
      join(workspaceDir, '.vscode', 'bookmarks.json'),
      JSON.stringify(MIRROR_FIXTURE, null, 2),
    );

    // 4. Spawn exactly the way a real MCP client would: `npx
    // bookmarks-plus-mcp <workspace>`, cwd = the install scratch dir. npx
    // resolves `bookmarks-plus-mcp` from the local node_modules/.bin
    // shim/symlink the install above just created -- on POSIX a symlink
    // resolved by realpathSync, on Windows a generated .cmd/.ps1 shim -- so
    // this exercises the real isEntrypoint() guard through the real shim
    // mechanics E2 was written to check, without a second registry lookup
    // for bookmarks-plus-mcp itself.
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = spawn(`npx bookmarks-plus-mcp ${quoted(workspaceDir)}`, {
        cwd: installDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      }) as ChildProcessWithoutNullStreams;

      const initializeResponsePromise = collectJsonRpcResponse(child, 1);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'packaging-test-client', version: '0.0.0' },
          },
        })}\n`,
      );

      const initializeResponse = await waitFor(
        initializeResponsePromise,
        60_000,
        'the initialize response from the packaged, npm-installed server',
      );
      assert.ok(
        initializeResponse !== undefined,
        'expected an initialize response over stdout from the real installed tarball spawned via npx -- ' +
          'got none (the process likely exited without starting the server)',
      );

      // The `initialized` notification completes the MCP handshake before
      // any further request is sent -- no `id`, no response expected.
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
      );

      const toolsResponsePromise = collectJsonRpcResponse(child, 2);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
      );

      const toolsResponse = await waitFor(
        toolsResponsePromise,
        30_000,
        'the tools/list response from the packaged, npm-installed server',
      );
      assert.ok(
        toolsResponse !== undefined,
        'expected a tools/list response over stdout -- got none',
      );

      const result = toolsResponse!.result as { tools?: Array<{ name: string }> } | undefined;
      const toolNames = (result?.tools ?? []).map((tool) => tool.name);

      assert.ok(
        toolNames.includes('list_bookmarks'),
        `expected tools/list to include list_bookmarks, got: ${JSON.stringify(toolNames)}`,
      );
      assert.ok(
        toolNames.includes('add_bookmark'),
        `expected tools/list to include add_bookmark, got: ${JSON.stringify(toolNames)}`,
      );
    } finally {
      // `child` is the shell (`shell: true`), not npx/node directly -- npx
      // and the real server process are its grandchildren. Closing stdin
      // first is how a real MCP client shuts the stdio transport down (the
      // server exits on EOF), and reaching that exit before `kill()` avoids
      // `kill()` only terminating the shell and orphaning the still-running
      // node process underneath it.
      child?.stdin.end();
      child?.kill('SIGKILL');
    }
  },
);
