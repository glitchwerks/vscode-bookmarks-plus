import * as vscode from 'vscode';
import { Prompter } from '../../commands';
import { MirrorPort } from '../../bookmarkMirror';
import type { PartitionMirrorResources } from '../../workspaceMirrorCoordinator';

export class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();
  updateCallCount = 0;
  failUpdateForKey: string | undefined;
  /**
   * Counts every call to `get()`, regardless of key. Used by tests that need to prove a
   * `Memento` was actually read from (e.g. that a store was constructed against it) without
   * coupling to the specific storage key the constructor happens to use.
   */
  getCallCount = 0;

  constructor(initial?: Record<string, unknown>) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.store.set(key, value);
      }
    }
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    this.getCallCount++;
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (this.failUpdateForKey === key) {
      this.failUpdateForKey = undefined;
      return Promise.reject(new Error(`simulated update failure: ${key}`));
    }
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
    this.updateCallCount++;
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  setKeysForSync(): void {
    // Not used by BookmarkStore; present only to satisfy vscode.Memento's shape if extended later.
  }
}

export class FakeOutput {
  lines: string[] = [];
  appendLine(value: string): void {
    this.lines.push(value);
  }
}

/**
 * One recorded call to `FakeEnvironmentVariableCollection.replace()`. `persistentAtCall` is a
 * snapshot of `persistent` taken at the moment `replace()` ran (not a live reference to the
 * collection), because later tests assert ordering — e.g. that `persistent` was already set to
 * `false` before `replace()` was invoked (T3).
 */
export interface FakeEnvironmentVariableCollectionCall {
  variable: string;
  value: string;
  optionsPassed: boolean;
  persistentAtCall: boolean;
}

/**
 * A minimal fake of the subset of `vscode.GlobalEnvironmentVariableCollection` that
 * `workspaceEnv.ts` uses: `persistent`, `description`, and `replace()`. Every `replace()` call is
 * recorded in `calls` so tests can assert what was written, how many times, and in what order
 * relative to `persistent`/`description` mutations.
 */
export class FakeEnvironmentVariableCollection {
  persistent = true;
  description = '';
  calls: FakeEnvironmentVariableCollectionCall[] = [];

  replace(variable: string, value: string, options?: unknown): void {
    this.calls.push({
      variable,
      value,
      optionsPassed: options !== undefined,
      persistentAtCall: this.persistent
    });
  }
}

/**
 * The subset of `vscode.ExtensionContext` that `activate()`/`deactivate()` read from. Kept as a
 * plain shape (not `vscode.ExtensionContext` itself) so tests can pass it to `activate()` via an
 * `as unknown as vscode.ExtensionContext` cast, matching the fixture pattern already used for
 * `registerViewCommands` in commands.test.ts.
 */
export interface FakeExtensionContext {
  subscriptions: vscode.Disposable[];
  workspaceState: FakeMemento;
  globalState: FakeMemento;
  environmentVariableCollection: FakeEnvironmentVariableCollection;
  extensionUri: vscode.Uri;
  extension: { packageJSON: { version: string } };
}

export function createFakeExtensionContext(): FakeExtensionContext {
  return {
    subscriptions: [],
    workspaceState: new FakeMemento(),
    globalState: new FakeMemento(),
    environmentVariableCollection: new FakeEnvironmentVariableCollection(),
    extensionUri: vscode.Uri.file('/extensions/bookmarks-plus'),
    extension: { packageJSON: { version: '1.3.0' } }
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeMirror implements MirrorPort {
  content: string | undefined;
  writeCount = 0;
  readCount = 0;
  failNextWrite = false;
  failNextRead = false;

  constructor(initialContent?: string) {
    this.content = initialContent;
  }

  async read(): Promise<string | undefined> {
    this.readCount++;
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('simulated read failure');
    }
    return this.content;
  }

  async write(content: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated write failure');
    }
    this.content = content;
    this.writeCount++;
  }
}

/** Mirror port plus independently fireable watcher events and disposal evidence. */
export class FakePartitionMirrorResources implements PartitionMirrorResources {
  readonly change = new vscode.EventEmitter<void>();
  readonly create = new vscode.EventEmitter<void>();
  readonly delete = new vscode.EventEmitter<void>();
  readonly onDidChange = this.change.event;
  readonly onDidCreate = this.create.event;
  readonly onDidDelete = this.delete.event;
  disposed = false;
  constructor(readonly port: FakeMirror = new FakeMirror()) {}
  dispose(): void {
    this.disposed = true;
    this.change.dispose();
    this.create.dispose();
    this.delete.dispose();
  }
}

/**
 * A minimal `vscode.Tab`-shaped fixture for #95 (suggested bookmarks from recently opened items).
 * `vscode.Tab` is an interface, not a constructible class, so this is a plain object literal cast
 * to the type rather than a real instance — `group` is stubbed since none of `extractTabUri` or
 * `registerRecentItemsTracker` read anything from it. `input` is left as `unknown` so callers can
 * pass any of the real `vscode.TabInput*` classes (`TabInputText`, `TabInputCustom`,
 * `TabInputNotebook`, `TabInputTextDiff`, ...) or a non-instance value for negative-path tests.
 */
export function fakeTab(
  input: unknown,
  options: { isPreview?: boolean; isPinned?: boolean; isActive?: boolean } = {}
): vscode.Tab {
  return {
    label: 'fake-tab',
    group: {} as vscode.TabGroup,
    input,
    isActive: options.isActive ?? false,
    isDirty: false,
    isPinned: options.isPinned ?? false,
    isPreview: options.isPreview ?? false
  } as vscode.Tab;
}

export interface FakePrompterOptions {
  inputBoxResult?: string | undefined;
  quickPickResult?: unknown;
  warningConfirmResult?: boolean;
  infoResult?: unknown;
  actionPromptResult?: string | undefined;
}

/**
 * A configurable fake of the extension's `Prompter` interface.
 *
 * `inputBoxResult` mirrors the real `showInputBox` contract: passing
 * `undefined` simulates the user dismissing the box, and passing `''`
 * simulates the user submitting an empty value. `lastInputBoxOptions` and
 * `inputBoxCallCount` let tests assert what was shown (e.g. the pre-filled
 * `value`) and whether the box was opened at all.
 */
export class FakePrompter implements Prompter {
  lastInfoMessage: string | undefined;
  lastWarningMessage: string | undefined;
  lastInputBoxOptions: vscode.InputBoxOptions | undefined;
  inputBoxCallCount = 0;
  lastActionPromptArgs: { message: string; actions: string[] } | undefined;
  actionPromptCallCount = 0;

  private readonly inputBoxResult: string | undefined;
  private readonly quickPickResult: unknown;
  private readonly warningConfirmResult: boolean;
  private readonly infoResult: unknown;
  private readonly actionPromptResult: string | undefined;

  constructor(options: FakePrompterOptions = {}) {
    this.inputBoxResult = options.inputBoxResult;
    this.quickPickResult = options.quickPickResult;
    this.warningConfirmResult = options.warningConfirmResult ?? false;
    this.infoResult = options.infoResult;
    this.actionPromptResult = options.actionPromptResult;
  }

  showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined> {
    this.inputBoxCallCount++;
    this.lastInputBoxOptions = options;
    return Promise.resolve(this.inputBoxResult);
  }

  showQuickPick<T extends vscode.QuickPickItem>(): Thenable<T | undefined> {
    return Promise.resolve(this.quickPickResult as T | undefined);
  }

  showWarningConfirm(message: string): Thenable<boolean> {
    this.lastWarningMessage = message;
    return Promise.resolve(this.warningConfirmResult);
  }

  showInfo(message: string): Thenable<unknown> {
    this.lastInfoMessage = message;
    return Promise.resolve(this.infoResult);
  }

  showActionPrompt(message: string, actions: string[]): Thenable<string | undefined> {
    this.actionPromptCallCount++;
    this.lastActionPromptArgs = { message, actions };
    return Promise.resolve(this.actionPromptResult);
  }
}
