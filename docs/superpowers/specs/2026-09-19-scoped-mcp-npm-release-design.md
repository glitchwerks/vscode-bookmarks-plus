# Scoped MCP npm Release Design

**Issue:** #66

**Status:** Approved in conversation; pending document review

**Date:** 2026-09-19

## 1. Objective

Publish the standalone MCP server as the public npm package
`@glitchwerks/bookmarks-plus-mcp`, so clients can launch it with
`npx -y @glitchwerks/bookmarks-plus-mcp` instead of building the repository and naming an absolute
`dist/index.js` path. Issue #66 already identifies npm publication, a separate release lane, a
compatibility policy, and user documentation as the remaining work.

The package keeps the executable name `bookmarks-plus-mcp`. The manifest already maps that binary to
`dist/index.js`, carries npm metadata, builds during `prepack`, and restricts packed files to runtime
artifacts (`mcp-server/package.json:L2-L32`). PR #113 added and verified that packaging foundation;
this design completes the publication and release-automation work rather than rebuilding it.

## 2. Existing constraints

- The extension and standalone package are already versioned independently: the extension is
  `1.3.0` (`package.json:L2-L6`) while the MCP package is `0.1.0`
  (`mcp-server/package.json:L2-L4`). PR #113 deliberately introduced `0.1.0` for the package.
- Standalone clients use the workspace mirror and do not expose Global, Detached, or Unassigned
  bookmarks (`docs/mcp.md:L78-L85`). Compatibility therefore follows the mirror schema accepted by
  the server, not the extension's UI release number.
- CI already runs MCP lint, unit, build, pack verification, and installed-package smoke checks on
  Linux and Windows with Node 20 (`.github/workflows/ci.yml:L36-L97`).
- The existing extension release workflow owns `vX.Y.Z` tags and resolves an immutable tag commit
  before publishing (`.github/workflows/publish.yml:L3-L43`). The MCP lane must use a distinct tag
  namespace so the two products cannot trigger each other's workflow.
- A trusted publisher can only be configured for a package that already exists on npm. npm also
  requires Node 22.14+ and npm 11.5.1+ for OIDC publishing
  ([npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/), fetched
  2026-09-19; [trusted publishing](https://docs.npmjs.com/trusted-publishers/), fetched 2026-09-19).
- On Windows, current Node 22/24 releases can treat a directory argument to `node --test` as a
  module rather than discovering tests. The repository's current test script passes `dist/test` as
  a directory (`mcp-server/package.json:L25-L32`), matching the upstream failure documented in
  [nodejs/node#64555](https://github.com/nodejs/node/issues/64555) (fetched 2026-09-19).

## 3. Considered release shapes

### A. Manual-only publishing

Every version would be published interactively with 2FA. This has the smallest initial workflow
surface but repeats security-sensitive steps and provides no automatic provenance. Rejected in
favor of a durable release lane; npm recommends trusted publishing over long-lived tokens for CI
([trusted publishing](https://docs.npmjs.com/trusted-publishers/), fetched 2026-09-19).

### B. Separate tag-driven npm lane — selected

The standalone package uses independent SemVer and `mcp-vX.Y.Z` tags. A project-local workflow
validates the tagged source and publishes through npm OIDC. This preserves the extension's existing
`vX.Y.Z` lane while keeping the two products independently releasable.

### C. Combined extension and npm releases

A single version and workflow would publish both artifacts. Rejected because the two manifests
already carry different versions and the standalone compatibility boundary is the mirror schema,
not extension-only UI behavior (`package.json:L2-L6`; `mcp-server/package.json:L2-L4`;
`docs/mcp.md:L78-L85`).

## 4. Package identity and versioning

1. Rename the package from `bookmarks-plus-mcp` to
   `@glitchwerks/bookmarks-plus-mcp` in both `mcp-server/package.json` and its lockfile.
2. Retain the `bookmarks-plus-mcp` binary name and its `dist/index.js` target
   (`mcp-server/package.json:L21-L24`).
3. Publish the scoped package publicly. Scoped packages default to private and require
   `--access public` for the first public publish
   ([npm organization-scoped publishing](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/),
   fetched 2026-09-19).
4. Keep MCP package SemVer independent from extension SemVer. The first release remains `0.1.0`.
5. Express compatibility as the highest supported mirror-schema version in the package README and
   changelog. Do not introduce an extension-to-package version matrix unless the schema contract can
   no longer express a compatibility break.
6. Add `mcp-server/CHANGELOG.md`; standalone package changes go there, while extension changes stay
   in the root `CHANGELOG.md`.

## 5. Two-phase bootstrap

The package must exist before npm can authorize `publish-mcp.yml`, so the initial release and the
automation lane cannot be activated atomically without a temporary publish token
([npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/), fetched 2026-09-19).
The bootstrap therefore uses two focused PRs.

**Open prerequisite:** npm scope availability is unverified. Public registry searches do not prove
that an unpublished organization name is claimable. Before the Phase 1 PR merges, the maintainer
must create an npm user account, enable 2FA, and successfully create the free public `glitchwerks`
organization. npm requires a user account before an organization can be created
([creating an npm organization](https://docs.npmjs.com/creating-an-organization/), fetched
2026-09-19). If `glitchwerks` is unavailable, stop and revise the package identity; do not silently
substitute another scope.

### Phase 1 — package release

The first PR:

- changes the package identity;
- adds the package changelog and public-install documentation;
- adds package metadata and Phase 1 tests described in sections 7 and 8;
- replaces references to the deleted npm implementation plan with durable references to Issue #66
  and PR #113;
- adds a cross-version test launcher that enumerates compiled `*.test.js` files and passes explicit
  paths to `node --test`, avoiding both Node 20's lack of internal glob handling and the Windows
  directory-argument regression in nodejs/node#64555.

After that PR merges, the maintainer:

1. checks out clean `main` at the merged commit and runs the full MCP release verification;
2. runs `npm publish --access public` from `mcp-server/`;
3. verifies registry metadata and performs the real installed-package MCP handshake against
   `@glitchwerks/bookmarks-plus-mcp@0.1.0`;
4. tags that exact commit `mcp-v0.1.0` and pushes the tag.

The automation workflow is intentionally absent during this phase, so the bootstrap tag records the
released source without starting an OIDC workflow that npm cannot yet authorize.

### Phase 2 — trusted publishing

The second PR adds `.github/workflows/publish-mcp.yml`. After it merges, the maintainer configures
the npm package's trusted publisher for:

- GitHub owner: `glitchwerks`
- repository: `vscode-bookmarks-plus`
- workflow filename: `publish-mcp.yml`
- allowed action: direct `npm publish`

The package setting is then changed to require 2FA and disallow traditional publish tokens. npm
documents this as the recommended posture after trusted publishing is enabled
([trusted publishing security guidance](https://docs.npmjs.com/trusted-publishers/), fetched
2026-09-19). `npm trust list @glitchwerks/bookmarks-plus-mcp` verifies the saved relationship. The
first end-to-end OIDC publication naturally occurs with the next MCP package version; `0.1.0` remains
the documented manual bootstrap.

Issue #66 remains open until the public package, `mcp-v0.1.0` tag, documentation, and trusted
publisher configuration have all been verified.

## 6. Automated release workflow

`publish-mcp.yml` is project-local. It does not introduce a shared action because its tag prefix,
package path, manifest checks, and trusted-publisher identity are specific to this repository.

### Triggers and immutable source

- Trigger on pushed stable tags matching `mcp-v*.*.*`.
- Support `workflow_dispatch` with an existing tag input for recovery.
- Resolve and check out the tag's immutable commit, following the established extension-release
  pattern (`.github/workflows/publish.yml:L17-L43`).
- Reject anything except the exact stable form `mcp-vMAJOR.MINOR.PATCH`. Pre-release dist-tags are
  out of scope for the first lane.
- Use a concurrency group keyed by the resolved release tag and do not cancel an in-progress publish.

### Validation

A tested Node script, not embedded shell business logic, validates:

- the exact tag grammar;
- manifest name `@glitchwerks/bookmarks-plus-mcp`;
- manifest version equal to the tag version;
- a matching heading in `mcp-server/CHANGELOG.md`.

The workflow splits lint and test/package verification into separate jobs so failures remain
independently visible. Both jobs check out the resolved commit and run from `mcp-server/`; together
they execute:

1. `npm ci`
2. `npm run lint`
3. `npm test`
4. `npm run build`
5. `npm run verify-pack`
6. `npm run test:packaging`

These preserve the existing package gates already run in CI (`.github/workflows/ci.yml:L61-L97`).
The publish job depends on both validation jobs, checks out the same resolved commit, installs from
the lockfile, reruns the release validator, and lets `prepack` build the exact tarball it publishes.
All release jobs use Node 24 and a current npm 11 to meet npm's OIDC floor. Release builds do not use
a dependency cache, matching npm's current trusted-publishing example
([trusted publishing](https://docs.npmjs.com/trusted-publishers/), fetched 2026-09-19).

### Publish

The publish job declares only:

```yaml
permissions:
  contents: read
  id-token: write
```

It runs on a GitHub-hosted Ubuntu runner and executes `npm publish --access public`. No npm token is
stored. npm automatically emits provenance for public packages published from public GitHub
repositories through trusted publishing
([trusted publishing provenance](https://docs.npmjs.com/trusted-publishers/), fetched 2026-09-19).

The first version does not create a GitHub Release. The immutable Git tag, npm release, and package
changelog are the release record. A GitHub Release can be added later if package-only releases become
hard to discover.

## 7. Documentation changes

- `README.md`: add only the short public `npx` entry point to the existing high-level standalone
  paragraph (`README.md:L49-L61`).
- `docs/mcp.md`: document public package setup, source-build fallback, scope limitations, workspace
  selection, and client-specific examples. This file remains the canonical integration guide
  (`docs/mcp.md:L78-L85`).
- `mcp-server/README.md`: lead with public npm usage because this is the npm listing content; retain
  source-build and detailed workspace-resolution guidance (`mcp-server/README.md:L1-L44`).
- `docs/release-strategy.md`: keep the existing extension odd/even lane intact and add a separate MCP
  section covering independent SemVer, bootstrap, tag validation, trusted publishing, recovery, and
  verification (`docs/release-strategy.md:L1-L90`).
- `mcp-server/CHANGELOG.md`: record `0.1.0` and link durable issue/PR references.

## 8. Tests and acceptance gates

### Phase 1 automated tests

- Manifest test for the scoped package name, independent `0.1.0` version, retained binary name,
  public publish configuration, metadata, and pack allowlist. Existing manifest assertions already
  cover version, metadata, hooks, and pack constraints
  (`mcp-server/test/packageManifest.test.ts:L33-L49`,
  `mcp-server/test/packageManifest.test.ts:L61-L123`).
- Cross-version test-launcher tests: recursive discovery, stable ordering, explicit file arguments,
  zero-test failure, and paths containing spaces.
- Existing tarball guard and installed-package handshake remain green. PR #113 established those
  gates; the current installed-package test documents the real pack/install/bin/MCP handshake
  (`mcp-server/test/packaging.test.ts:L17-L47`).

### Phase 1 manual gates

- `npm view @glitchwerks/bookmarks-plus-mcp@0.1.0 version` returns `0.1.0`.
- A cold temporary install launches the package's generated `bookmarks-plus-mcp` bin and completes
  `initialize` followed by `tools/list`, returning `list_bookmarks` and `add_bookmark`.
- `mcp-v0.1.0` resolves to the exact commit used for publication.

### Phase 2 automated tests

- Release-validator tests cover valid tags and each tag, manifest, package-name, and changelog
  mismatch/failure path.
- Workflow structure test or parser-backed repository test verifies triggers, least-privilege
  permissions, immutable checkout, Node/npm floor, validation ordering, test gates, and publish
  command.
- Existing extension release guards remain green and reject `mcp-v*` tags. PR #113 introduced that
  separation; the current guard is visible at `.github/workflows/publish.yml:L33-L43`.

### Phase 2 manual gates

- npm package settings show the exact trusted publisher tuple and direct-publish permission.
- Traditional publish tokens are disallowed.
- `npm trust list @glitchwerks/bookmarks-plus-mcp` reports `publish-mcp.yml`.

## 9. Failure behavior and recovery

- A malformed tag, version mismatch, wrong package name, or missing changelog entry fails before any
  publish attempt.
- A validation failure publishes nothing; fix the source, create a new version/tag when package
  contents change, and do not move a published tag.
- A transient failure before `npm publish` can be retried through `workflow_dispatch` with the same
  tag.
- npm versions are immutable once published; a rerun after a successful publish may report an
  already-published version and must not be treated as permission to alter or replace it
  ([npm publish](https://docs.npmjs.com/commands/npm-publish/), fetched 2026-09-19).
- OIDC authentication failures direct the maintainer to compare the case-sensitive npm trusted
  publisher owner, repository, and workflow filename with the committed workflow
  ([trusted publishing troubleshooting](https://docs.npmjs.com/trusted-publishers/), fetched
  2026-09-19).

## 10. Out of scope

- Lockstep extension/package versions.
- MCP pre-release dist-tags or a `next` channel.
- A shared action in `glitchwerks/github-actions`.
- A package-specific GitHub Release.
- Publishing the first version through a temporary npm automation token.
- Changing standalone MCP capabilities, mirror semantics, or the extension's native MCP behavior.
