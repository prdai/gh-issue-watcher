# gh-issue-watcher

Watches a list of GitHub repositories for new issues, shortlists the ones worth reading, and emails a digest on a schedule.

Runs as a single Cloudflare Worker on a Cron Trigger. State lives in Workers KV. Notifications go out through Cloudflare Email Service.

## What it does

Every cron tick, for each watched repo:

1. Reads the last-run cursor from KV and asks GitHub for issues created since then.
2. Matches each issue against that repo's watched labels.
3. Optionally asks an LLM whether an unmatched issue is relevant to the repo's stated interest.
4. Sends one email per run with the shortlist.

An issue notifies when it matches a watched label or the AI marks it relevant.

## Architecture

| Piece | Choice | Why |
| --- | --- | --- |
| Scheduler | Cloudflare Cron Trigger | No server to keep alive, native retry semantics, hourly cadence is free |
| Config | `watchers.yaml` in the repo, synced to KV on deploy | Reviewable in PRs, no dashboard editing, one source of truth |
| State | Workers KV | Cursor per repo plus dedupe keys with TTL |
| GitHub access | Fine-grained PAT stored as a Worker secret | Raises the search API limit from 10 to 30 requests per minute and supports private repos |
| AI gate | AI SDK on the OpenCode Go endpoint | Typed `Output.object` schema, cheap per-token pricing, model selectable per watcher |
| Email | `send_email` binding | Native, free to verified destination addresses, no third-party signup |

## Configuration

`watchers.yaml` is the source of truth. `bun run sync-config` validates it and uploads it to KV under `config:watchers`.

```yaml
defaults:
  ai:
    enabled: true
    model: deepseek-v4.1-flash
    maxPerRun: 25
  notify:
    to: go2ranuga@gmail.com
    from: issues@prdai.dev

watchers:
  - repo: facebook/react
    labels: ["good first issue", "Status: Unconfirmed"]
    interest: |
      Bug reports and feature requests about rendering, hydration, and
      server components. Ignore documentation-only changes.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `repo` | yes | `owner/name` on GitHub |
| `labels` | no | Case-insensitive label names. An issue matching any of them notifies |
| `ai` | no | Per-watcher override of `defaults.ai.enabled` |
| `model` | no | Per-watcher override of `defaults.ai.model` |
| `interest` | no | What counts as relevant. Falls back to `defaults.interest` |
| `notify` | no | Per-watcher override of the recipient and sender |

`defaults.ai.maxPerRun` caps AI checks per repo per run.

The AI gate only runs on issues that did not match a label, because a label hit already notifies. This keeps token spend proportional to unmatched volume. `maxPerRun` bounds the cost of a busy repo; the rest of the window is deferred to the next run instead of being dropped.

## Setup

Prerequisites: a Cloudflare account with a zone on Email Routing, a verified destination address, Node 22.18 or newer for the config scripts, Bun for dependency install, and `wrangler` logged in.

```sh
bun install
wrangler kv namespace create CONFIG
```

Copy the namespace id into `wrangler.jsonc`, then set secrets:

```sh
wrangler secret put GITHUB_TOKEN        # fine-grained PAT, Issues: read
wrangler secret put OPENCODE_API_KEY    # OpenCode Go key
wrangler secret put RUN_TOKEN           # bearer token for manual POST /run
```

Create the `send_email` binding and check that the destination address is verified under Email Routing, then:

```sh
bun run sync-config
wrangler deploy
```

The cron schedule is declared in `wrangler.jsonc`. Change `crons` and redeploy to adjust cadence.

## Operations

| Action | Command |
| --- | --- |
| Validate and upload config | `bun run sync-config` |
| Dry-run the config parser | `bun run check-config` |
| Trigger a run now | `curl -X POST https://<worker-url>/run -H "Authorization: Bearer $RUN_TOKEN"` |
| Inspect KV cursors | `wrangler kv key get cursor:facebook/react --binding CONFIG --remote` |
| Tail logs | `wrangler tail` |

## Limits and behavior

- Cursor semantics are "created since the previous run". Edits and comments to existing issues are not picked up.
- GitHub's issue search returns at most 1000 results per query. A repo producing more than that per hour will be truncated with a note in the digest.
- On GitHub rate limiting the run aborts without advancing the cursor, so the next run retries the same window.
- AI failures are fail-closed: the issue is not reported by the AI branch and the digest carries an error line. The repo cursor does not advance, so the issue is retried next run.
- AI-rejected issues are recorded as processed. They are not re-checked, which keeps spend flat while a cursor is behind.
- Dedupe keys expire after 30 days. The same issue is never emailed twice while the key is live.
- Email is only deliverable to verified destination addresses until a sending domain is fully onboarded.

## OpenCode Go client requirements

OpenCode Go asks clients to identify themselves and send a stable session id for routing. The Worker sends `user-agent: gh-issue-watcher/0.1` and one `x-opencode-session` per repo (`gh-issue-watcher:<owner/name>`).

The plan is intended for coding-agent traffic and is monitored for abuse. This workload is low-volume issue triage, not a coding agent. Confirm that fits the plan terms before relying on it in production; a dedicated inference provider is the fallback if it does not.

## Cost

- Cloudflare Workers and Cron Triggers: hourly execution fits the free plan.
- KV: negligible for this write volume.
- Email to verified destinations: free.
- AI: only unmatched new issues, one short completion each. At `deepseek-v4.1-flash` pricing this is fractions of a cent per run.

## Repository layout

```
src/
  index.ts      scheduled handler and manual trigger
  run.ts        one run: collect, deliver, settle state
  config.ts     watchers.yaml schema and defaults
  state.ts      KV config load, cursors, dedupe keys
  github.ts     issue search client
  match.ts      label matching and window arithmetic
  ai.ts         relevance gate
  digest.ts     email body rendering
  email.ts      send_email wrapper
scripts/
  sync-config.ts
  config-file.ts
test/
.github/workflows/ci.yml
```

Tests use a Map-backed KV fake and a stub `fetch`, so they exercise the real run path without network access.

## License

Unlicensed, private repository.
