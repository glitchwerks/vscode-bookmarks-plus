import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, disposeStores } from '../../extension';
import { BookmarkStore } from '../../bookmarkStore';
import { createFakeExtensionContext, FakeExtensionContext, FakeMemento, FakeMirror, FakeOutput } from './fixtures';

// The VS Code Extension Development/Test Host (as launched by @vscode/test-electron's
// `extensionDevelopmentPath`) activates this extension for real — registering the actual
// `bookmarks.*` commands against a real `vscode.ExtensionContext` — before any test code runs at
// all. This is confirmed empirically: it happens even when this file is made to sort first
// among all suite files, so it cannot be a side effect of another test or of file ordering.
//
// Because `vscode.commands.registerCommand` is a single, global, non-idempotent registry for the
// whole test process, calling the exported `activate()` a second time (with a fake context, to
// exercise the behavior under test) will always throw once it reaches `registerAddCommands` —
// see extension.ts: store construction happens at the top of `activate()`, well before command
// registration. That means the throw happens *after* the behavior these tests care about has
// already run. Each test below calls `activate()`, asserts the resulting error is exactly this
// known, benign collision (re-throwing anything else as a real failure), and then asserts on the
// state produced before the throw.
function assertKnownActivationCollision(error: unknown): void {
  assert.match(
    String(error),
    /command '.*' already exists/,
    'expected only the known "command already exists" collision from the Extension Test Host ' +
      'having already activated this extension for real — any other error is a genuine failure'
  );
}

function disposeAll(context: FakeExtensionContext): void {
  context.subscriptions.forEach((d) => d.dispose());
  context.subscriptions.length = 0;
}

suite('Extension - global store lifecycle (T2)', () => {
  test('activate constructs a second BookmarkStore backed by context.globalState', () => {
    const context = createFakeExtensionContext();
    try {
      assert.strictEqual(
        context.globalState.getCallCount,
        0,
        'sanity check: globalState must be untouched before activate() runs'
      );

      try {
        activate(context as unknown as vscode.ExtensionContext);
      } catch (error) {
        assertKnownActivationCollision(error);
      }

      assert.ok(
        context.globalState.getCallCount > 0,
        'activate() must construct a BookmarkStore over context.globalState — expected at least ' +
          'one read from globalState to load its persisted bookmark data, the same way the ' +
          'existing workspaceState-backed store loads its data on construction'
      );
    } finally {
      disposeAll(context);
    }
  });

  test('activate never calls setKeysForSync on context.globalState', () => {
    const context = createFakeExtensionContext();
    let setKeysForSyncCallCount = 0;
    context.globalState.setKeysForSync = (): void => {
      setKeysForSyncCallCount++;
    };

    try {
      try {
        activate(context as unknown as vscode.ExtensionContext);
      } catch (error) {
        assertKnownActivationCollision(error);
      }

      assert.strictEqual(
        setKeysForSyncCallCount,
        0,
        'global bookmarks are local-machine data and must never be synced across machines via ' +
          'setKeysForSync'
      );
    } finally {
      disposeAll(context);
    }
  });
});

/**
 * A minimal spy that is structurally cast to `BookmarkStore` for `disposeStores()` — the same
 * `as unknown as X` cast pattern already used above for `FakeExtensionContext`. `BookmarkStore`
 * has private members, so it cannot be satisfied by a plain object literal without the cast; the
 * spy exists purely to record call order and count, independent of the real store's internals.
 */
type StoreSpy = BookmarkStore & {
  disposeCallCount: number;
  flushCallCount: number;
  callOrder: string[];
};

function createStoreSpy(): StoreSpy {
  const callOrder: string[] = [];
  const spy = {
    disposeCallCount: 0,
    flushCallCount: 0,
    callOrder,
    dispose(): void {
      this.disposeCallCount++;
      callOrder.push('dispose');
    },
    async flushMirrorWrites(): Promise<void> {
      this.flushCallCount++;
      callOrder.push('flush');
    }
  };
  return spy as unknown as StoreSpy;
}

suite('Extension - disposeStores (T2)', () => {
  test('flushes mirror writes and disposes every store exactly once, flush before dispose', async () => {
    const storeA = createStoreSpy();
    const storeB = createStoreSpy();

    await disposeStores([storeA, storeB]);

    assert.strictEqual(storeA.flushCallCount, 1, 'storeA.flushMirrorWrites() must be called exactly once');
    assert.strictEqual(storeA.disposeCallCount, 1, 'storeA.dispose() must be called exactly once');
    assert.deepStrictEqual(
      storeA.callOrder,
      ['flush', 'dispose'],
      'storeA must be flushed before it is disposed, so a pending mirror write is not cancelled by dispose'
    );

    assert.strictEqual(storeB.flushCallCount, 1, 'storeB.flushMirrorWrites() must be called exactly once');
    assert.strictEqual(storeB.disposeCallCount, 1, 'storeB.dispose() must be called exactly once');
    assert.deepStrictEqual(storeB.callOrder, ['flush', 'dispose']);
  });

  test('actually flushes a pending mirror write for each real store before returning', async () => {
    const mirrorA = new FakeMirror();
    const storeA = new BookmarkStore(new FakeMemento(), new FakeOutput(), { mirror: mirrorA, writeDelayMs: 5 });
    const mirrorB = new FakeMirror();
    const storeB = new BookmarkStore(new FakeMemento(), new FakeOutput(), { mirror: mirrorB, writeDelayMs: 5 });

    // Schedule a mirror write on each store but do not await flushMirrorWrites() ourselves — the
    // write is still only pending at this point, matching real activate()/dispose() usage where a
    // mutation can happen just before the extension host tears everything down.
    await storeA.addItem({ type: 'file', uri: 'file:///a.txt' });
    await storeB.addItem({ type: 'file', uri: 'file:///b.txt' });
    assert.strictEqual(mirrorA.writeCount, 0, 'sanity check: the write must still be pending, not yet flushed');
    assert.strictEqual(mirrorB.writeCount, 0, 'sanity check: the write must still be pending, not yet flushed');

    await disposeStores([storeA, storeB]);

    assert.strictEqual(
      mirrorA.writeCount,
      1,
      'disposeStores must flush storeA\'s pending mirror write before disposing it, not drop it'
    );
    assert.strictEqual(
      mirrorB.writeCount,
      1,
      'disposeStores must flush storeB\'s pending mirror write before disposing it, not drop it'
    );
  });

  test('silently skips undefined entries without throwing, and still disposes the defined stores', async () => {
    const storeA = createStoreSpy();

    await assert.doesNotReject(
      () => disposeStores([storeA, undefined]),
      'an undefined entry must be skipped the same way today\'s `activeStore?.dispose()` optional ' +
        'chaining silently no-ops on an absent store, not thrown as an error'
    );

    assert.strictEqual(storeA.flushCallCount, 1, 'the defined store must still be flushed');
    assert.strictEqual(storeA.disposeCallCount, 1, 'the defined store must still be disposed');
  });

  test('does not throw when given an empty array', async () => {
    await assert.doesNotReject(() => disposeStores([]));
  });
});
