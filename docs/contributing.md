# Contributing to Bookmarks Plus

Contributions are welcome, including bug reports, documentation improvements, tests, and code.

## Before starting

1. Search the repository's issues and pull requests for overlapping work.
2. Open or update a GitHub issue describing the problem, expected outcome, and scope.
3. Discuss substantial behavior or API changes before implementation.

## Development workflow

1. Branch from an up-to-date `main` checkout.
2. Install dependencies with `npm install`.
3. Make a focused change and add or update tests for code behavior.
4. Run `npm run lint` and `npm test`.
5. Run the MCP packaging checks when changing MCP behavior, public API behavior, bundling, or release
   infrastructure. See the [development guide](development.md) for the commands.
6. Open a pull request that explains the change, its verification, and the issue it closes.

Keep pull requests focused. Update the README or the relevant guide whenever a change affects user,
consumer, development, or release instructions.

## Releases

Maintainers should follow the [release strategy](release-strategy.md). Contribution pull requests
should not publish Marketplace or npm packages.

## Credits

See [CONTRIBUTORS.md](../CONTRIBUTORS.md) for project credits.
