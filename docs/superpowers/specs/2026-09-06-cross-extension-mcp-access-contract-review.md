# Cross-Extension MCP Access Contract Review

**Reviewed specification:** `docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md`  
**Issue:** #137  
**Review outcome:** Revisions required before approval

## Summary

The proposed contract covers the principal #137 requirements for supported extension discovery,
API and descriptor versioning, explicit root requests, workspace/global scope negotiation, typed
request failures, bootstrap and active-session lifecycle, graceful degradation, and packaged
producer/consumer verification. (`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L8-L18`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L42-L60`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L143-L237`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L264-L381`; #137)

The contract should not be approved unchanged. Three gaps can prevent the downstream Claude
Workspaces integration from satisfying its exact-root isolation, failure-isolation, and secret-
handling requirements. Several compatibility and execution details also need to be made explicit
before the API becomes a durable public boundary.

## Blocking findings

### 1. Selected-root workspace ownership is not defined by the prerequisites

The contract says that the `workspace` scope grants access only to bookmark state owned by the
selected workspace folder and that one descriptor binds one root.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L313-L327`)

The current implementation has one workspace `BookmarkStore` backed by the window's
`context.workspaceState`, not one store per workspace folder. (`src/extension.ts:L439-L444`;
`src/bookmarkStore.ts:L57-L80`) `BookmarkData` stores collections and bookmark items whose location
is an absolute URI, but it does not record an owning workspace-folder identity.
(`src/types.ts:L3-L23`) Existing nested-root handling also establishes that a URI can fall under
more than one open root, requiring an explicit most-specific-root rule if URI containment is used
for ownership. (`src/workspaceFolders.ts:L23-L49`; `src/test/suite/workspaceFolders.test.ts:L165-L182`)

Issue #62 currently tracks choosing a stable mirror location for multi-root workspaces; it does not
define the store partitioning and migration semantics required by this contract. (#62)

Before approval, #62 or this contract must decide and document:

- whether workspace data becomes per-folder state or remains window-wide state filtered by URI;
- which root owns an item when roots are nested;
- how items outside all current roots are treated;
- whether collections may span roots and what a root-scoped session sees or may mutate;
- how existing workspace data migrates without loss; and
- how every MCP mutation is routed to the selected root without exposing another open or imported
  root.

Without those decisions, the advertised selected-root scope cannot be implemented or tested
deterministically, and the Claude Workspaces requirement that imported roots receive no implicit
bookmark access is not guaranteed. (#137; glitchwerks/vscode-claude-workspaces#50)

### 2. The consumer flow does not guarantee failure isolation

The design requires the primary launch to survive an absent, incompatible, or unavailable producer,
but it also permits unexpected failures from `requestMcpConnection()` to reject.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L54-L55`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L172-L176`)
The consumer example awaits both `extension.activate()` and
`requestMcpConnection()` without an exception boundary or deadline.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L193-L232`)

A rejected or never-settling activation/request can therefore prevent the primary Claude process
from launching, contrary to #137 R7 and the downstream consumer acceptance criteria. (#137;
glitchwerks/vscode-claude-workspaces#50)

Revise the contract and example to require a consumer-owned, bounded optional-integration adapter:

- catch activation and request rejection;
- impose a finite deadline across discovery/activation/request work;
- abandon late results without launching their descriptors;
- emit only a concise, redacted diagnostic; and
- continue immediately with the primary launch when the optional path fails.

Add tests for activation rejection, request rejection, and promises that never settle, in addition
to the typed-result cases already listed.

### 3. Sensitive bootstrap transport is not safe end to end

The contract classifies `command`, `args`, and `env` as potentially sensitive and forbids consumers
from persisting or logging their values.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L59-L60`)
Claude Workspaces currently records the complete launch argument array in its output channel.
(`https://github.com/glitchwerks/vscode-claude-workspaces/blob/main/src/logging/outputLogger.ts#L15-L23`,
fetched 2026-09-06)

Claude Code accepts `--mcp-config` as either inline JSON or a file. An inline descriptor can expose
bootstrap data through process arguments and the current launch log; a file needs explicitly secure,
ephemeral creation and deletion semantics to avoid becoming persisted credential material.
(https://code.claude.com/docs/en/cli-reference, fetched 2026-09-06)

The producer/consumer handoff must specify a safe carrier rather than leaving this to an opaque
translation step. At minimum it must define:

- which descriptor fields may contain authorization material;
- how Claude Workspaces passes that material without logging it;
- how launch diagnostics redact MCP configuration values;
- whether a secure temporary file or environment-variable indirection is used;
- cleanup behavior after success, failure, cancellation, and extension shutdown; and
- tests proving bootstrap data never appears in logs or durable workspace/project configuration.

## Required contract corrections

### Descriptor evolution

The prose permits API v1 to negotiate a future descriptor version and transport without requiring a
new API major. The declared result, however, can return only `McpStdioDescriptorV1`, and the
capability type declares exactly the tuple `['stdio']`.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L56-L58`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L77-L83`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L103-L117`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L143-L154`)

Represent descriptors as an explicitly extensible discriminated union, and state that a success
must contain one of the descriptor versions advertised by the producer and supplied in the
consumer's `supportedDescriptorVersions`. Make the transport capability an extensible collection
rather than an exact one-element tuple, or state that adding a transport requires a new API major.

### Stdio execution semantics

Descriptor v1 does not say whether `env` replaces the process environment or overlays it, and it
does not carry a working directory or prohibit dependence on one.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L103-L112`)
VS Code's own stdio definition treats `env` as additions/overrides to the extension-host environment
and supports an optional `cwd`.
(https://code.visualstudio.com/api/references/vscode-api, fetched 2026-09-06)

Define the v1 behavior explicitly. Either add a serializable optional `cwd`, or require an absolute
command/all necessary absolute arguments and guarantee that server behavior does not depend on the
consumer's inherited working directory. Define `env` as either a complete environment or an overlay;
the two interpretations must not both be conforming.

### Caller authorization and Workspace Trust

VS Code makes an extension's exported API available to every extension running in the same extension
host. The bootstrap authorization authenticates a spawned server to the private bridge, but the
proposed request contains no authenticated caller identity and therefore does not restrict which
co-hosted extension may request workspace or global access.
(https://code.visualstudio.com/api/advanced-topics/remote-extensions, fetched 2026-09-06;
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L273-L292`)

State the threat model explicitly. If every installed, co-hosted extension is considered an
authorized caller that may request all advertised scopes, document that decision. If that is not
acceptable, the activation-export API needs a separate user-consent or authorization boundary;
adding a caller-supplied extension identifier would not authenticate the caller.

Also specify Restricted Mode behavior. Bookmarks Plus currently relies on VS Code's default
Workspace Trust behavior rather than declaring `capabilities.untrustedWorkspaces` explicitly.
(`package.json:L1-L17`)
VS Code recommends an explicit declaration and disables an undeclared main-entry extension until
Workspace Trust is granted.
(https://code.visualstudio.com/api/extension-guides/workspace-trust, fetched 2026-09-06)

### Extension-host placement

The contract is intentionally same-extension-host only.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L33-L35`,
`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L234-L237`)
Claude Workspaces explicitly declares `"extensionKind": ["workspace"]`, while
Bookmarks Plus currently declares no extension kind.
(`https://github.com/glitchwerks/vscode-claude-workspaces/blob/main/package.json#L28-L31`,
fetched 2026-09-06; `package.json:L1-L17`)

Require Bookmarks Plus to run as a workspace extension, or narrow API v1 support to environments
where both extensions are demonstrably co-located. Add at least a manifest assertion, and include a
remote extension-host packaged test if remote workspaces are intended to be supported. VS Code's
extension-host placement depends on manifest preference, extension capabilities, installation
location, and the available hosts.
(https://code.visualstudio.com/api/advanced-topics/extension-host, fetched 2026-09-06)

### Reconnection limitation

The contract says the companion extension decides whether to obtain a new descriptor and reconnect.
(`docs/superpowers/specs/2026-09-06-cross-extension-mcp-access-contract-design.md:L329-L347`)
For the planned Claude Workspaces `--mcp-config` integration, the configuration is supplied when the
Claude process starts; the extension cannot replace a consumed bootstrap descriptor inside that
already-running process through the documented launch flag.
(https://code.claude.com/docs/en/cli-reference, fetched 2026-09-06;
glitchwerks/vscode-claude-workspaces#50)

Document that Claude Workspaces v1 can obtain a fresh descriptor for New Session, Retry, and Restart
Fresh, but cannot promise transparent MCP reconnection within an existing Claude process. The Claude
session may continue without bookmark tools after the server disconnects.

## Verification additions

Retain the proposed contract, lifecycle, and packaged producer/consumer coverage, and add:

- multi-root tests proving selected-root item, collection, and mutation isolation;
- nested-root and out-of-root ownership tests;
- existing-data migration tests for the chosen #62 storage model;
- activation rejection, request rejection, and request-timeout fallback tests;
- diagnostics tests proving descriptor fields and authorization material are redacted;
- secure-carrier cleanup tests across successful launch, failed launch, cancellation, and disposal;
- API-minor tests using at least two descriptor versions to prove negotiation and result typing; and
- same-host placement and Workspace Trust tests for every environment claimed as supported.

## Approval criteria

Approve #137 after:

1. #62 is updated to own the selected-root storage and migration decisions required by the public
   contract.
2. Failure isolation covers thrown and non-settling activation/request paths.
3. The Claude Workspaces handoff defines a non-logging, non-durable bootstrap carrier.
4. Descriptor evolution and stdio execution semantics are internally consistent.
5. Caller trust, Workspace Trust, extension-host placement, and reconnection limitations are
   documented and testable.
