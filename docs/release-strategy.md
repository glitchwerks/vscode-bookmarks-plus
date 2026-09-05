# Release Strategy

## Why this convention exists

The VS Code Marketplace does not support semver pre-release suffixes (`1.2.0-beta.1`).
Versions must be plain `MAJOR.MINOR.PATCH`. The channel (stable vs pre-release) is
signalled at publish time via a flag — not encoded in the version string itself.

To make the channel unambiguous from the version number alone, we adopt Microsoft's
own odd/even minor convention.

## The odd/even minor rule

| Minor is… | Example  | Channel     | Publish command             |
|-----------|----------|-------------|-----------------------------|
| Even      | `1.0.x`  | Stable      | `npm run publish:stable`    |
| Odd       | `1.1.x`  | Pre-release | `npm run publish:prerelease` |

Examples of the parallel lanes:

```
1.0.x  stable      1.1.x  pre-release
1.2.x  stable      1.3.x  pre-release
1.4.x  stable      1.5.x  pre-release
2.0.x  stable      2.1.x  pre-release
```

## User opt-in mechanics

Stable-channel users **never** receive pre-release versions automatically.
Pre-release users must explicitly opt in via the Marketplace UI or the
`--pre-release` flag when installing. This means a pre-release publish cannot
accidentally break stable users.

## Monotonic version rule

Published versions must be monotonically increasing across **both** channels
combined. The marketplace enforces this globally — you cannot publish `1.1.0`
if `1.2.0` has already been published, regardless of channel. Plan your lane
jumps accordingly: always move forward.

## Versioning within a channel (same as semver)

| Change type      | What to bump          | Example               |
|------------------|-----------------------|-----------------------|
| Breaking change  | Major (reset minor/patch) | `1.0.2` → `2.0.0` |
| New feature      | Minor (stay in lane)  | `1.0.0` → `1.0.1` *(or bump to next even minor for a new stable cycle: `1.2.0`)* |
| Bug / patch fix  | Patch                 | `1.0.0` → `1.0.1`    |

When promoting a pre-release cycle to stable, increment to the next even minor:
`1.1.x` (pre-release) → `1.2.0` (stable).

## Publish commands

Never run `vsce publish` directly — always use the npm scripts, which run the
channel guard first:

```bash
npm run publish:stable      # even minor required
npm run publish:prerelease  # odd minor required
```

Both commands are defined in `package.json`:

```json
"publish:stable":    "node scripts/guard-channel.js stable && vsce publish",
"publish:prerelease":"node scripts/guard-channel.js prerelease && vsce publish --pre-release"
```

## The channel guard

`scripts/guard-channel.js` enforces parity before every publish.

It reads `version` from `package.json`, checks the minor parity, and:

- Exits **0** silently on match.
- Exits **1** with a descriptive error on mismatch, e.g.:

  ```
  Version 1.0.0 has EVEN minor (0) — cannot publish as pre-release.
  Bump to 1.1.0 first, or use `npm run publish:stable`.
  ```

- Exits **2** for an unknown channel argument.
- Exits **3** if `package.json` is missing or has no `version` field.

Unit tests live in `src/test/suite/guardChannel.test.ts` and run with
`npm test` (Mocha, via `node ./out/test/runTest.js`, which discovers all
`**/*.test.js` files under the compiled `out/test/suite/` directory). Lint
the codebase with `npm run lint` (eslint) before publishing.

## See also

[VS Code docs — Pre-release extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions)

[VS Code docs — Add and manage MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

---

## GitHub Actions secret setup

The publish workflow authenticates to the VS Code Marketplace using a Personal
Access Token stored as a repository secret. Follow these steps before pushing
the first release tag.

### Create an Azure DevOps PAT

1. Sign in to [dev.azure.com](https://dev.azure.com) with the publisher account
   (the account that owns the `cbeaulieu-gt` Marketplace publisher).
2. Open **User settings → Personal access tokens → New Token**.
3. Give the token a descriptive name, e.g. `vscode-marketplace-publish`.
4. Set **Organization** to **"All accessible organizations"** — `vsce` requires
   this; a single-organization PAT will be rejected at publish time.
5. Set an expiry (one year is a reasonable default).
6. Under **Scopes**, select **Marketplace → Publish** (and only that scope).
7. Click **Create** and copy the token immediately — you cannot retrieve it again.

Because the token is scoped to the `cbeaulieu-gt` publisher account rather than
a single repository, the same PAT works across all `cbeaulieu-gt` extensions
(e.g. it is also used to publish `vscode-claude-conductor`). You do not need a
separate PAT per repository — just add the existing token as a repository
secret in each repo that publishes under this publisher.

### Add the secret to the repository

1. In the GitHub repo, go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `VSCE_PAT`
4. Value: the Azure DevOps PAT you copied above (reuse the existing
   `cbeaulieu-gt` token if one is already in use on another extension).
5. Click **Add secret**.

### PAT rotation

Rotate the PAT at least once a year (or immediately if it may have been
exposed). Recommended practice:

- Note the expiry date in a pinned issue or a calendar reminder set one week
  before expiry.
- When rotating: create the new PAT first, update the `VSCE_PAT` secret in
  **every** repository that uses it (not just this one), then revoke the old
  PAT.

If the secret is missing, expired, or invalid the **Publish** step of the
workflow will fail loudly — this is intentional so a bad credential is surfaced
immediately rather than silently skipping the publish.

---

## Cutting a release

Follow these steps every time you publish a new version to the Marketplace.
Substitute the target version number for `X.Y.Z` and select the stable or
pre-release lane using the odd/even minor rule above.

1. **Merge all PRs** targeting the release into `main`.
2. **Pull latest `main`:**
   ```bash
   git pull --ff-only origin main
   ```
3. **Bump `version` in `package.json`:**
   - Even minor (e.g. `1.4.0`) → stable; odd minor
     (e.g. `1.5.0`) → pre-release.
   - If you are staying in the same minor lane, increment the patch instead
     (e.g. `1.0.0` → `1.0.1`).
4. **Update `CHANGELOG.md`:** move the `[Unreleased]` entries into a new
   versioned section with today's date:
   ```markdown
   ## [X.Y.Z] — YYYY-MM-DD
   ```
5. **Run the automated release checks:**
   ```bash
   npm ci
   npm run lint
   npm test
   npm run test:mcp-bundle
   npm run test:packaged-mcp
   ```
   The packaged MCP test creates a real VSIX, loads that exact artifact in a pinned VS Code 1.101
   Extension Host, and exercises both MCP tools on Windows or Linux
   (`package.json:L127-L139`; `scripts/test-packaged-native-mcp.mjs:L102-L149`).
6. **Perform the packaged-VSIX UI smoke check:**
   1. Run `npm run vsce:package` and install the generated VSIX using
      **Extensions: Install from VSIX...** in VS Code 1.101 or later.
   2. Open a single-folder workspace and run **MCP: List Servers**. Confirm that
      **Bookmarks Plus** is listed and starts without an error.
   3. Open Chat in Agent mode, select the tools button, and confirm that
      `list_bookmarks` and `add_bookmark` appear under **Bookmarks Plus**.
   4. Repeat with no folder and with a multi-root workspace. Confirm that the server is not
      advertised and that the **Bookmarks Plus** output channel explains the disabled state
      (`src/mcpServerProvider.ts:L18-L52`).

   The server-management names above follow the
   [VS Code MCP documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
   (fetched 2026-09-05).
7. **Commit:**
   ```bash
   git commit -am "chore: bump to X.Y.Z"
   ```
8. **Push the commit:**
   ```bash
   git push origin main
   ```
9. **Create the tag:**
   ```bash
   git tag vX.Y.Z
   ```
10. **Push the tag:**
   ```bash
   git push origin vX.Y.Z
   ```
11. **Watch the workflow:** go to the **Actions** tab in the GitHub repo and
   open the **Publish** workflow run that triggered on the tag push. On success
   the workflow will:
   - Publish the extension to the VS Code Marketplace (stable or pre-release
     channel, determined automatically from the minor parity).
   - Create a GitHub Release for the tag using the matching CHANGELOG entry as
     the release notes.

### Manual-dispatch retry path

If the tag-triggered run fails due to a transient Marketplace error (e.g.
a momentary 5xx from the VS Code Marketplace API) you can re-trigger the
publish without pushing a new tag:

1. Go to **Actions → Publish workflow → Run workflow**.
2. Enter the existing tag in the **Tag to publish** input (e.g. `v1.0.0`).
3. Click **Run workflow**.

The workflow checks out that tag, runs the full lint/test/compile pipeline, and
publishes exactly as the automatic run would have.
