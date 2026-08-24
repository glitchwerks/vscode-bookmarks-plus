import * as vscode from 'vscode';
import { Prompter } from '../../commands';
import { MirrorPort } from '../../bookmarkMirror';

export class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();
  updateCallCount = 0;
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
}

export function createFakeExtensionContext(): FakeExtensionContext {
  return {
    subscriptions: [],
    workspaceState: new FakeMemento(),
    globalState: new FakeMemento(),
    environmentVariableCollection: new FakeEnvironmentVariableCollection()
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

  showWarningConfirm(): Thenable<boolean> {
    return Promise.resolve(this.warningConfirmResult);
  }

  showInfo(): Thenable<unknown> {
    return Promise.resolve(this.infoResult);
  }

  showActionPrompt(message: string, actions: string[]): Thenable<string | undefined> {
    this.actionPromptCallCount++;
    this.lastActionPromptArgs = { message, actions };
    return Promise.resolve(this.actionPromptResult);
  }
}
