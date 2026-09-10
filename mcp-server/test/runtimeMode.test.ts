import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LiveBridgeStartupError } from '../src/liveBridgeClient.js';

const live = {
  BOOKMARKS_PLUS_LIVE_MODE: '1',
  BOOKMARKS_PLUS_ROOT_URI: 'file:///workspace',
  BOOKMARKS_PLUS_BRIDGE_ENDPOINT: 'test-endpoint',
  BOOKMARKS_PLUS_BRIDGE_PROTOCOL: '1',
  BOOKMARKS_PLUS_BRIDGE_GENERATION: 'generation',
  BOOKMARKS_PLUS_BRIDGE_TOKEN: 'secret-token',
};

/** Imports optionally so a missing implementation is an explicit RED assertion. */
async function resolver() {
  const modulePath = '../src/runtimeMode.js';
  const module = await import(modulePath).catch(() => undefined);
  assert.equal(typeof module?.resolveRuntimeMode, 'function', 'runtime selection must exist');
  return module.resolveRuntimeMode as (
    argv: readonly string[], env: NodeJS.ProcessEnv,
  ) => { kind: string; config?: unknown; reason?: string };
}

test('complete live configuration bypasses every mirror resolver input', async () => {
  const resolve = await resolver();
  const env = new Proxy(live, {
    get(target, key) {
      assert.ok(String(key) in target, `mirror input ${String(key)} must not be read`);
      return Reflect.get(target, key);
    },
  });
  assert.deepEqual(resolve(['node', 'index', 'ignored'], env), {
    kind: 'live', config: {
      endpoint: 'test-endpoint', protocolVersion: 1, generation: 'generation',
      token: 'secret-token', workspaceFolderUri: 'file:///workspace',
    },
  });
});

test('zero live fields preserve mirror resolution and disabled state', async () => {
  const resolve = await resolver();
  assert.deepEqual(resolve(['node', 'index', '/workspace'], {}), {
    kind: 'mirror', config: {
      workspacePath: path.resolve('/workspace'),
      mirrorPath: path.join(path.resolve('/workspace'), '.vscode', 'bookmarks.json'),
      verifyDelayMs: 400,
    },
  });
  assert.deepEqual(resolve(['node', 'index'], { BOOKMARKS_PLUS_WORKSPACE: 'disabled:no-folder' }), {
    kind: 'disabled', reason: 'No workspace folder is open in this VS Code window.',
  });
});

test('every partial live field subset fails closed before mirror resolution', async () => {
  const resolve = await resolver();
  const entries = Object.entries(live);
  for (let mask = 1; mask < 63; mask++) {
    const values = Object.fromEntries(entries.filter((_, index) => mask & (1 << index)));
    const env = new Proxy(values, {
      get(target, key) {
        assert.ok(String(key) in live, `mirror input ${String(key)} must not be read`);
        return Reflect.get(target, key);
      },
    });
    assert.throws(() => resolve(['node', 'index', '/workspace'], env),
      (error: unknown) => error instanceof LiveBridgeStartupError && error.code === 'bridge-unavailable');
  }
});

test('empty live values and malformed marker, protocol, or root are safe startup errors', async () => {
  const resolve = await resolver();
  const invalid = [
    ...Object.keys(live).flatMap((key) => [{ [key]: '' }, { [key]: '   ' }]),
    { BOOKMARKS_PLUS_LIVE_MODE: 'true' },
    { BOOKMARKS_PLUS_BRIDGE_PROTOCOL: '2' },
    { BOOKMARKS_PLUS_BRIDGE_PROTOCOL: '01' },
    ...['relative/root', 'not a uri', 'file:', 'file:relative', 'file:///bad%ZZ'].map(
      (root) => ({ BOOKMARKS_PLUS_ROOT_URI: root }),
    ),
  ];
  for (const override of invalid) {
    assert.throws(() => resolve(['node', 'index'], { ...live, ...override }),
      (error: unknown) => error instanceof LiveBridgeStartupError &&
        error.code === 'bridge-unavailable' && !error.message.includes('secret-token'));
  }
});
