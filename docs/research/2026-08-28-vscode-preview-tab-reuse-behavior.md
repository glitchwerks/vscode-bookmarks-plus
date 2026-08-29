# VS Code preview-tab reuse behavior vs. `TabGroups.onDidChangeTabs` (issue #101)

## Idea

Determine, from VS Code's own source (not an interactive smoke test), whether reusing a preview
tab for a different file — the thing that happens every time a user single-clicks a second file in
Explorer while a preview tab is already open — surfaces to extensions via `TabChangeEvent.opened`,
`.closed`, `.changed`, or some combination, so `src/recentItems.ts`'s / `src/extension.ts`'s
preview-promotion counter (issue #95, `PREVIEW_PROMOTION_THRESHOLD = 3`) can be confirmed correct
or shown to need a `changed` listener.

## Requirements

A candidate answer must, to be useful to `debugger`/`code-writer`:

1. State definitively whether `opened` fires when an existing preview tab is replaced by a
   different file's preview.
2. State whether `changed` fires in that same scenario, and if so, for what.
3. State what happens when the *same* file is re-clicked while it is already the open/active
   preview tab (no-op vs. re-fire).
4. Be grounded in a verifiable source (production code, not conjecture), since the extension's own
   code comment (`src/extension.ts` lines 137–141, `.worktrees/95-suggested-bookmarks/src/extension.ts`)
   already states a doc-based assumption that could not be confirmed interactively.
5. Tell the implementer plainly whether `src/extension.ts` needs a `changed`-array listener added,
   and flag any risk in doing so.

## Search axes used

- **VS Code extension API surface** — `TabChangeEvent`, `TabGroups.onDidChangeTabs`, `Tab.isPreview`,
  `workbench.editor.enablePreview` (found: official docs page is a single enormous document that
  truncates before the Tabs API section in both `WebFetch` and the raw `vscode.d.ts` fetch; abandoned
  in favor of source-of-truth code, per requirement 4).
- **VS Code internals — editor-group model** — the layer that actually decides preview-tab reuse
  (`EditorGroupModel.openEditor`, `preview` field, `replaceEditor`).
- **VS Code internals — main↔ext-host IPC bridge** — the two files that translate internal
  `GroupModelChangeKind` events into the extension-visible `TabModelOperationKind` / `TabChangeEvent`
  shape (`mainThreadEditorTabs.ts`, `extHostEditorTabs.ts`).
- **Community / maintainer reports** — GitHub issues on `microsoft/vscode` describing observed
  `onDidChangeTabs` firing counts for Explorer clicks, to cross-check the source-level trace against
  an independent, empirical, maintainer-confirmed account.
- **Third-party extension prior art** — other extensions that consume `TabChangeEvent.changed`
  specifically, to establish what `changed` is actually used for in practice (as opposed to what the
  docs vaguely gesture at).
- **Negative axis** — this is not a question about `onDidChangeActiveTextEditor` or
  `onDidChangeVisibleTextEditors` (older, editor-level APIs); the extension already correctly scopes
  to the newer `window.tabGroups.onDidChangeTabs` Tabs API, so those were not investigated.

## Direct findings

### Q1 — Does `opened` or `changed` fire when an existing preview tab is reused for a different file?

**Both `opened` and `changed` fire, in separate event deliveries, plus a `closed` delivery for the
vacated tab.** Concretely, one Explorer single-click on file B while file A's preview tab is open and
active produces **three** separate `onDidChangeTabs` firings, in this order:

1. `{ closed: [A], opened: [], changed: [] }`
2. `{ closed: [], opened: [B], changed: [] }`
3. `{ closed: [], opened: [], changed: [B] }` — B again, this time because it just became the
   *active* tab (an `isActive` flip, unrelated to its preview status)

If there was no existing preview tab to displace (e.g. B is the first tab opened, or the previously
active tab was pinned), only firings 2 and 3 happen — **two** deliveries, `opened` then `changed`,
both referencing B.

**`extractTabUri`+`recordOpen` in `src/recentItems.ts` only consumes `opened`, so this is safe for
the case #101 is worried about** — B's preview open is recorded exactly once, in delivery 2. See
"Risk" below for why *also* listening to `changed` would be actively harmful, not merely redundant.

### Q2 — Does re-previewing the SAME file re-fire either event, or is it a no-op?

Depends on whether the file is still the *current* preview tab at click time:

- **If the file is already the open, active preview tab** (the literal "click the same file you're
  already looking at" case): **true no-op.** Neither `opened`, `closed`, nor `changed` fires — zero
  `onDidChangeTabs` deliveries. Traced below.
- **If the file was previously previewed but has since been evicted** (the realistic "click A, click
  B, click A again" browsing pattern that `PREVIEW_PROMOTION_THRESHOLD = 3` is actually designed to
  count): re-clicking A is **not** a no-op. Because B's preview replaced A, A no longer exists in the
  editor group's model at all (it was fully closed, not just deactivated) — so re-opening A hits the
  exact same three/two-firing sequence as Q1, with A now in the `opened`/`changed` role. `opened` sees
  it correctly, once, same as any other distinct-file preview.

So the scenario the counter cares about (repeated, interleaved preview visits to the same file) is
covered correctly by `opened` alone. The only genuine no-op is the degenerate, low-value case of
clicking a file that's already the exact tab you're on.

### Q3 — Confidence level

**High on the mechanism, not verified interactively.** This is grounded in three layers of matching
production source (workbench model → main-thread IPC bridge → ext-host IPC bridge), not
documentation — the official docs page and `vscode.d.ts` were both too large to fetch in full and,
per the issue's own framing, are silent on these exact mechanics anyway. No live Extension
Development Host session was run (out of scope for this task, per the router's brief).

Independent corroboration:

- `microsoft/vscode#146786` ("`onDidChangeTabs()` firing multiple times for some add tabs"), filed
  against the same code path, reports **exactly** the counts this trace predicts: "add a tab by
  single clicking on its explorer name ⇐ fires two times", "double clicking ⇐ fires two or three
  times." It was closed `*as-designed*` by `lramos15`, the VS Code team member who authored
  `mainThreadEditorTabs.ts` and `extHostEditorTabs.ts` (both cited below). The reporter's repro had no
  competing preview tab to displace, which is why they saw 2 firings, not 3 — consistent with the "no
  prior preview to close" branch above.
- `robertpiosik/CodeWebChat`'s `open-editors-provider.ts` (a real, unrelated extension) reads
  `TabChangeEvent.changed` specifically to catch `tab.isPreview` toggling on an *already-tracked* tab
  path — i.e. pin/unpin — not to catch a tab's content being swapped to a different file. That is
  independent evidence that `changed`, in practice, means "metadata changed on a stable tab identity,"
  not "content replaced," matching the source trace's `EDITOR_PIN`/`EDITOR_ACTIVE` → `changed` mapping
  and its `EDITOR_CLOSE`+`EDITOR_OPEN` → `closed`+`opened` mapping for content swaps.
- This mechanism (`EditorGroupModel.openEditor`'s `replaceEditor` call when a preview tab is reused)
  has been present in `#146786`'s 2022 report and is unchanged in the `main` branch fetched for this
  report (2026-08-28) — i.e. stable for roughly four years, not a recent or fragile implementation
  detail.

### Q4 — Recommendation

**`opened` alone is correct and sufficient for the preview-promotion counter as currently designed.
Do not add a `changed` listener for this purpose — it would not fix anything and, if added naively,
would actively break the threshold.**

The reasoning is not merely "`changed` doesn't help" — it's that a naive `changed` listener processing
the same way as the existing `opened` loop would **double-count every preview open**. As shown in Q1,
a single Explorer click that opens a new preview tab fires `opened: [B]` *and*, moments later in a
separate delivery, `changed: [B]` (from the active-tab-flip event, since B's `isActive` becomes true).
`recordOpen`'s dedup keys on `uri` per call, not across event deliveries — so a `changed`-listener
that ran the same `recordOpen(list, { uri, isPreview: tab.isPreview }, ...)` logic would see B a
second time on the same click and increment `previewCount` twice, cutting the effective promotion
threshold from 3 clicks to ~1.5 (2 clicks: 4 increments crosses a threshold of 3 on the second click).
If a future change ever does need to consume `changed`, it must dedupe against the same-tick `opened`
array (e.g. skip any URI already seen in `event.opened` during that callback invocation) — this is a
design note, not an instruction to `debugger`/`code-writer`, who should own the actual implementation
if they choose to touch this.

## Evidence trace (source, cited to a fixed commit)

All three files fetched from `microsoft/vscode` at commit
`a39698f7e6ecc255f6e9cf752d1c6d01faf308da` (tree SHA returned by GitHub code search on 2026-08-28;
content fetched from `main` on 2026-08-28, which resolved to this same commit at fetch time).

1. **`src/vs/workbench/common/editor/editorGroupModel.ts`**
   (`https://github.com/microsoft/vscode/blob/a39698f7e6ecc255f6e9cf752d1c6d01faf308da/src/vs/workbench/common/editor/editorGroupModel.ts`,
   blob `1e0507653bd3bb051f8f85e0998ecb23523dab39`) — `openEditor(candidate, options)`:
   - **"New editor" branch** (candidate not found via `findEditor`, i.e. a genuinely different file):
     if not pinned (preview open) and `this.preview` is set, calls
     `this.replaceEditor(this.preview, newEditor, targetIndex, !makeActive)`, which internally calls
     `doCloseEditor(toReplace=oldPreview, EditorCloseContext.REPLACE, openNext)` and then fires an
     `EDITOR_CLOSE` event for the old preview *before* the function returns. `this.preview = newEditor`
     is assigned next (so `isPinned`/`isPreview` on the new tab is already correct at this point).
     The function then unconditionally fires `EDITOR_OPEN` for `newEditor`, and finally calls
     `this.setSelection(makeActive ? newEditor : this.activeEditor, ...)`, which — because the
     previously active editor (the old preview) differs from the new one — fires `EDITOR_ACTIVE`.
     Three internal `_onDidModelChange` events: `EDITOR_CLOSE`, `EDITOR_OPEN`, `EDITOR_ACTIVE`.
   - **"Existing editor" branch** (candidate found via `findEditor`, i.e. re-clicking a file still
     present in the model): no `EDITOR_OPEN` and no `replaceEditor` call at all. It calls
     `this.setSelection(makeActive ? existingEditor : this.activeEditor, ...)` →
     `doSetSelection(...)`; if `existingEditor` is already the active editor, `activeEditorChanged`
     evaluates false and the selection-array comparison also finds no change, so **`_onDidModelChange`
     never fires** — a true no-op at the model level.

2. **`src/vs/workbench/api/browser/mainThreadEditorTabs.ts`**
   (`https://github.com/microsoft/vscode/blob/a39698f7e6ecc255f6e9cf752d1c6d01faf308da/src/vs/workbench/api/browser/mainThreadEditorTabs.ts`,
   blob `5e16316044a2cf5f068bb52c909a4f7a0c2543e2`) — `_updateTabsModel(changeEvent)` switches on
   `GroupModelChangeKind`:
   - `EDITOR_OPEN` → `_onDidTabOpen` → `$acceptTabOperation({..., kind: TAB_OPEN})`
   - `EDITOR_CLOSE` → `_onDidTabClose` → `$acceptTabOperation({..., kind: TAB_CLOSE})`
   - `EDITOR_ACTIVE` → `_onDidTabActiveChange` → `$acceptTabOperation({..., kind: TAB_UPDATE})`
     (mutates `isActive` on the tab's cached DTO and re-sends it)
   - `EDITOR_PIN` (fired by `doPin`/`doUnpin`, i.e. converting a preview tab to pinned or back) →
     `_onDidTabPreviewChange` → `$acceptTabOperation({..., kind: TAB_UPDATE})`
   - `EDITOR_MOVE` → `_onDidTabMove` → `$acceptTabOperation({..., kind: TAB_MOVE})`
   - Anything unhandled falls through to `default: this._createTabsModel()`, which rebuilds the whole
     model and notifies via a *different* channel (`$acceptEditorTabModel` → `onDidChangeTabGroups`,
     not `onDidChangeTabs` — see "Known limitation" below).

3. **`src/vs/workbench/api/common/extHostEditorTabs.ts`**
   (`https://github.com/microsoft/vscode/blob/a39698f7e6ecc255f6e9cf752d1c6d01faf308da/src/vs/workbench/api/common/extHostEditorTabs.ts`,
   blob `510f5b21547d47812e8251ed49df16309eb87644`) — `$acceptTabOperation(operation)`:
   ```
   case TabModelOperationKind.TAB_OPEN:   fires onDidChangeTabs({ opened: [tab], closed: [], changed: [] })
   case TabModelOperationKind.TAB_CLOSE:  fires onDidChangeTabs({ opened: [], closed: [tab], changed: [] })
   case TabModelOperationKind.TAB_MOVE:
   case TabModelOperationKind.TAB_UPDATE: fires onDidChangeTabs({ opened: [], closed: [], changed: [tab] })
   ```
   This is the authoritative mapping from internal model events to the public `TabChangeEvent` shape
   extensions see.

## Known limitation (secondary to #101, worth flagging)

`mainThreadEditorTabs.ts`'s `_onDidTabOpen` early-returns into a full `_createTabsModel()` rebuild
when the tab's group isn't yet known to the tabs model (`!group || !groupInModel`) — e.g. the first
editor opened into a brand-new editor group (a split, or the very first tab in the window). A full
rebuild notifies via `$acceptEditorTabModel` → `_onDidChangeTabGroups`, **not**
`_onDidChangeTabs` — so that specific open is invisible to any `onDidChangeTabs` listener, including
the existing `opened`-only one. This is an edge case (new-group creation, not a same-group preview
swap) and does not affect the#101 question directly, but it means "`opened` alone already sees every
preview selection" (the extension's own code comment) has this one narrow exception worth knowing
about if the counter is ever reported as under-counting in a multi-group workspace.

## No prior art found

- **Official documentation wording for this exact mechanic.** Both `code.visualstudio.com/api` and
  the raw `vscode.d.ts` are too large to fetch in full via the available tools and truncated before
  reaching the Tabs API / `TabChangeEvent` sections in every attempt. The doc comments on
  `TabChangeEvent` are, per the issue's own framing, known to be non-specific about preview-tab reuse
  ("changed" is glossed only as covering things like active-state flips) — this report's source trace
  is the closest available substitute for documentation the API itself doesn't provide.

## Recommended handoff

- **`debugger` / `code-writer`** — no code change is required for the concern raised in issue #101;
  `opened`-only, as currently wired in `.worktrees/95-suggested-bookmarks/src/extension.ts`
  (`registerRecentItemsTracker`), is correct for the distinct-file preview-swap case. If a `changed`
  listener is ever added for an unrelated reason, it must dedupe against `event.opened` in the same
  callback invocation to avoid double-counting preview opens (see Q4). This report should be enough
  to close #101 as verified rather than needing a manual EDH smoke test, at the user's discretion.
- **`user`** — decide whether to close #101 on this source-level evidence alone, or still run the
  manual Extension Development Host smoke test originally requested, given no interactive session was
  performed here.

## Open questions

- Whether VS Code's editor-opening call site for an Explorer single-click always passes
  `active: true` explicitly, or relies on the `(!makePinned && this.preview === this.activeEditor)`
  fallback in `makeActive`'s computation — both paths were traced to the same three-firing outcome for
  the common case, so this doesn't change the answer, but it wasn't independently confirmed against
  the Explorer-click command handler itself (out of scope: that call site lives in
  `src/vs/workbench/contrib/files/browser/fileActions.ts` / the Explorer's `TreeViewsWelcomeHandler`-
  adjacent open logic, not fetched for this report).
- No interactive Extension Development Host verification was performed (explicitly out of scope per
  the task brief). The recommendation rests on source tracing plus one maintainer-labeled `*as-designed*`
  issue with matching firing counts, not a live reproduction.
