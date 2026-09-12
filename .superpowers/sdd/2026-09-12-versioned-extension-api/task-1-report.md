# Task 1 report

## Implementation summary

Added typed `LiveMcpBridgeGrantError` issuance failures, the read-only activation generation accessor, and exact immutable 60-second expiry metadata on issued grants and pending grants. Added tests for metadata and typed failures, and updated the existing provider fixture for the expanded grant interface.

## Files changed

- `src/liveMcpBridgeService.ts`
- `src/test/suite/liveMcpBridgeService.test.ts`
- `src/test/suite/mcpServerProvider.test.ts`

## RED command/output

`npm --prefix I:/apps/vscode/bookmarks/.worktrees/codex/issue-138-versioned-extension-api run compile-tests`

Failed as expected with missing `LiveMcpBridgeGrantError`, `activationGeneration`, and `expiresAt` TypeScript errors (plus sandbox `TS5033 EPERM` writes to generated `out/` files).

## GREEN/full-suite commands/results

`npm --prefix I:/apps/vscode/bookmarks/.worktrees/codex/issue-138-versioned-extension-api run compile-tests` — exit 0 under escalated worktree permissions.

The direct focused Mocha invocation could not load `vscode` outside the extension-host harness. `npm --prefix I:/apps/vscode/bookmarks/.worktrees/codex/issue-138-versioned-extension-api test` — exit 0; compile, bundle, and VS Code test runner completed successfully.

## Self-review

Expiry is calculated once and reused in pending and returned frozen metadata. All expected issuance failures use the dedicated class, and unrelated errors do not satisfy `instanceof`. The accessor is read-only and no bridge object is exposed.

## Concerns

Focused direct Mocha is unavailable without the VS Code harness; full `npm test` passed. The I: worktree required escalated execution because generated output files were ACL-protected.

## Fix Round 1

Changed the empty-scope issuance assertion in `src/test/suite/liveMcpBridgeService.test.ts` to require `error instanceof LiveMcpBridgeGrantError` and `error.code === 'scope-unavailable'`. This specifically fails if the production branch regresses to a generic `new Error('scope-unavailable')`; the remaining invalid-scope cases retain message checks for breadth.

Covering test and verification commands:

- `npm --prefix I:/apps/vscode/bookmarks/.worktrees/codex/issue-138-versioned-extension-api run compile-tests` — exit 0.
- `npm --prefix I:/apps/vscode/bookmarks/.worktrees/codex/issue-138-versioned-extension-api test` — exit 0; compile, bundle, and extension-host runner completed successfully.

The direct Mocha focused path remains unavailable because it cannot resolve the VS Code runtime module outside the extension-host harness.
