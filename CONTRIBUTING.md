# Contributing

Thanks for considering a contribution.

## Reporting bugs

Open an issue with a descriptive title, what happened, steps to reproduce, expected behavior, and any relevant logs. Include the commit or version if you have it.

## Suggesting changes

Open an issue describing the problem and the outcome you want. Keep it on the behavior, not a full implementation plan.

## Pull requests

1. Branch from `main`.
2. Add or update tests for behavior changes.
3. Run `bun test` and `bun run typecheck`.
4. Keep the change to one concern.
5. Describe the behavior change and how you verified it.

## Development

Prerequisites: Bun for install, tests, and config scripts, plus Node.js 20 or newer for Wrangler.

```sh
bun install
bun run typecheck
bun test
bun run dev
```

`bun run sync-config` validates `watchers.yaml` and uploads it to KV. It needs a configured Cloudflare account and the `CONFIG` namespace from `wrangler.jsonc`.

The test suite uses a Map-backed KV fake and a stub `fetch`, so it runs without network access.

## Code style

Match the surrounding code. Add a comment only when the reason for the code is non-obvious. Keep new run-path logic testable without network access.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
