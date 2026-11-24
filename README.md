# gh-issue-watcher

Watches a list of GitHub repositories for new issues, shortlists the ones worth reading, and emails a digest on a schedule.

Runs as a single Cloudflare Worker on a Cron Trigger. State lives in Workers KV. Notifications go out through Cloudflare Email Service.

## What it does

Every cron tick, for each watched repo:

1. Reads the shared last-run cursor from KV and asks each repo for issues created since then.
2. Matches each issue against that repo's watched labels.
3. Optionally asks an LLM whether an unmatched issue is relevant to the repo's stated interest.
4. Sends one email per run with the shortlist.

An issue notifies when it matches a watched label or the AI marks it relevant.

## Architecture

| Piece | Choice | Why |
| --- | --- | --- |
| Scheduler | Cloudflare Cron Trigger | No server to keep alive, native retry semantics, hourly cadence is free |
| Config | `watchers.yaml` in the repo, synced to KV on deploy | Reviewable in PRs, no dashboard editing, one source of truth |
| State | Workers KV | One shared cursor, nothing else |
| GitHub access | Octokit with a PAT in a Worker secret | Typed client, pagination, and errors; raises the search limit from 10 to 30 requests per minute |
| AI gate | AI SDK on the OpenCode Go endpoint | Typed `Output.object` schema, cheap per-token pricing, model selectable per watcher |
| Email | `send_email` binding | Native, free to verified destination addresses, no third-party signup |

## Configuration

`watchers.yaml` is the source of truth. `bun run sync-config` validates it and uploads it to KV under `config:watchers`.

```yaml
defaults:
  ai:
    enabled: true
    model: deepseek-v4.1-flash
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

The AI gate only runs on issues that did not match a label, because a label hit already notifies. All unmatched issues in the window go to the model in one batched request per repo, split into batches of 20 when the window is larger.

## Setup

Prerequisites: a Cloudflare account with a zone on Email Routing, a verified destination address, Bun for install and the config scripts, and `wrangler` logged in.

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
| Trigger a run now | `curl -X POST https://<worker-url>/run -H "Authorization: Bearer $RUN_TOKEN"` |
| Inspect the cursor | `wrangler kv key get cursor --binding CONFIG --remote` |
| Tail logs | `wrangler tail` |

## Limits and behavior

- Cursor semantics are strictly "created since the previous successful check". Edits and comments to existing issues are not picked up. The first run looks back one hour.
- One cursor covers every watched repo. It advances to the run start when at least one repo search succeeded, even if an AI batch failed.
- If every repo search fails, the cursor stays put and the same window is retried. If only some fail, their window for that run is skipped; the failure is named in the digest.
- The next window starts one second after the cursor, so an issue is never fetched twice and no per-issue state is stored.
- GitHub's issue search returns at most 1000 results per query. A repo producing more than that per hour will be truncated with a note in the digest.
- On GitHub rate limiting the run aborts without advancing the cursor, so the next run retries the same window.
- AI failures are fail-closed: the issue is not reported by the AI branch and the digest carries an error line naming the issue number. The window still advances, so the issue is not revisited.
- Email is only deliverable to verified destination addresses until a sending domain is fully onboarded.

## OpenCode Go client requirements

OpenCode Go asks clients to identify themselves and send a stable session id for routing. The Worker sends `user-agent: gh-issue-watcher/0.1` and one `x-opencode-session` per repo (`gh-issue-watcher:<owner/name>`).

The plan is intended for coding-agent traffic and is monitored for abuse. This workload is low-volume issue triage, not a coding agent. Confirm that fits the plan terms before relying on it in production; a dedicated inference provider is the fallback if it does not.

## Cost

- Cloudflare Workers and Cron Triggers: hourly execution fits the free plan.
- KV: negligible for this write volume.
- Email to verified destinations: free.
- AI: only unmatched new issues, sent as one batched request per repo per window (batches of 20) and requested with `reasoning_effort: low`. A three-issue batch measures about $0.001 at `deepseek-v4.1-flash` pricing.

## Repository layout

```
src/
  index.ts      scheduled handler and manual trigger
  run.ts        one run: collect, deliver, settle state
  config.ts     watchers.yaml schema and defaults
  state.ts      KV config load and the shared cursor
  github.ts     issue search client
  match.ts      label matching and window arithmetic
  ai.ts         relevance gate
  digest.ts     email body rendering
  email.ts      send_email wrapper
scripts/
  sync-config.ts
test/
.github/workflows/ci.yml
```

Tests use a Map-backed KV fake and a stub `fetch`, so they exercise the real run path without network access.

## License

Unlicensed, private repository.
