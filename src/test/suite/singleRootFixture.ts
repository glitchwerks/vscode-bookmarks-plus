import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { BookmarkStore } from '../../bookmarkStore';
import { WorkspaceBookmarkStore } from '../../workspaceBookmarkStore';
import { WorkspaceOwnerRef } from '../../workspacePartitionTypes';
import { FakeMemento, FakeOutput } from './fixtures';

export const SINGLE_ROOT_OWNER: Extract<WorkspaceOwnerRef, { kind: 'partition' }> = {
  kind: 'partition', partitionId: '11111111-1111-4111-8111-111111111111'
};

type FixtureContentMethods = Pick<BookmarkStore,
  'addItem' | 'addCollection' | 'removeItem' | 'renameCollection' | 'deleteCollection' |
  'setItemDescription' | 'setCollectionDescription' | 'moveItem'>;

export type SingleRootFixtureStore = WorkspaceBookmarkStore & FixtureContentMethods;

/**
 * Runs existing single-root UI cases against the real partition store. Test setup may omit
 * the fixed owner; production consumers still call the real owner-aware signatures.
 */
export async function createSingleRootFixtureStore(state = new FakeMemento()): Promise<SingleRootFixtureStore> {
  let firstId = true;
  const store = await WorkspaceBookmarkStore.create({
    state, output: new FakeOutput(),
    roots: [{ id: 'test-root', label: 'Test root', uri: vscode.Uri.parse('file:///') }],
    createId: () => {
      if (firstId) { firstId = false; return SINGLE_ROOT_OWNER.partitionId; }
      return randomUUID();
    }
  });
  const arities: Record<string, number> = {
    addItem: 1, addCollection: 1, removeItem: 1, renameCollection: 2, deleteCollection: 1,
    setItemDescription: 2, setCollectionDescription: 2, moveItem: 3
  };
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => Reflect.apply(value, target,
        typeof property === 'string' && args.length === arities[property] ? [SINGLE_ROOT_OWNER, ...args] : args);
    }
  }) as SingleRootFixtureStore;
}
