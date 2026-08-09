#!/usr/bin/env node
// Placeholder entry point for `bookmarks-plus-mcp` (issue #52).
//
// The real stdio server bootstrap and tool registration land in Task 7 of
// docs/superpowers/plans/2026-08-08-mcp-server-bookmarks.md. This stub exists
// only so the build produces `dist/index.js` at the package's `bin` target
// and the two-tsconfig scaffold has a source file to compile against.
//
// Global Constraint 1: the server must never write to stdout — it is the
// JSON-RPC channel. Use stderr (console.error/console.warn) for all
// logging, here and in every later task.
console.error('bookmarks-plus-mcp: not yet implemented (see issue #52)');
process.exitCode = 1;
