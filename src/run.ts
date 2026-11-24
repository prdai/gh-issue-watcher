import { judgeIssues } from "./ai.ts";
import { resolveWatchers, type Config, type ResolvedWatcher } from "./config.ts";
import { renderDigest, type DigestEntry, type DigestFailure } from "./digest.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { searchIssuesSince, type Issue } from "./github.ts";
import { windowStart } from "./match.ts";
import { getCursor, loadConfig, putCursor } from "./state.ts";

export interface RunSummary {
  ranAt: string;
  repos: number;
  issues: number;
  failures: number;
  emailed: boolean;
  errors: DigestFailure[];
  hits: { repo: string; number: number; source: "label" | "ai" }[];
}

const AI_BATCH_SIZE = 20;

interface CollectResult {
  searched: boolean;
  entries: DigestEntry[];
  failures: DigestFailure[];
}

export async function run(env: Env, now: Date): Promise<RunSummary> {
  const config = await loadConfig(env);
  const watchers = resolveWatchers(config);
  const until = now.toISOString();
  const since = windowStart(await getCursor(env), now).toISOString();
  const entries: DigestEntry[] = [];
  const failures: DigestFailure[] = [];

  const collected = await Promise.all(
    watchers.map(async (watcher) => ({ watcher, result: await collect(env, watcher, since, until) })),
  );

  for (const { result } of collected) {
    entries.push(...result.entries);
    failures.push(...result.failures);
  }

  const shouldEmail = entries.length > 0 || failures.length > 0;
  if (shouldEmail) await deliver(env, config, entries, failures, now);

  if (collected.some(({ result }) => result.searched)) await putCursor(env, until);

  return {
    ranAt: until,
    repos: watchers.length,
    issues: entries.length,
    failures: failures.length,
    emailed: shouldEmail,
    errors: failures,
    hits: entries.map((entry) => ({ repo: entry.repo, number: entry.issue.number, source: entry.source })),
  };
}

async function collect(
  env: Env,
  watcher: ResolvedWatcher,
  since: string,
  until: string,
): Promise<CollectResult> {
  const result: CollectResult = { searched: false, entries: [], failures: [] };

  try {
    const issues = await searchIssuesSince(env, { repo: watcher.repo, since, until });
    result.searched = true;

    const unmatched: Issue[] = [];
    for (const issue of issues) {
      const label = matchedLabel(issue, watcher.labels);
      if (label) {
        result.entries.push({ repo: watcher.repo, issue, source: "label", label, reason: null, notify: watcher.notify });
        continue;
      }
      unmatched.push(issue);
    }

    if (watcher.ai) {
      const session = `gh-issue-watcher:${watcher.repo}`;
      for (const batch of chunk(unmatched, AI_BATCH_SIZE)) {
        try {
          const verdicts = await judgeIssues(env, {
            issues: batch,
            interest: watcher.interest,
            model: watcher.model,
            session,
          });
          for (const issue of batch) {
            const verdict = verdicts.get(issue.number);
            if (verdict?.relevant) {
              result.entries.push({ repo: watcher.repo, issue, source: "ai", label: null, reason: verdict.reason, notify: watcher.notify });
            }
          }
        } catch (error) {
          result.failures.push({ repo: watcher.repo, message: `AI batch of ${batch.length}: ${errorMessage(error)}` });
          console.error(`[${watcher.repo}] AI batch of ${batch.length} failed: ${errorMessage(error)}`);
        }
      }
    }
  } catch (error) {
    result.failures.push({ repo: watcher.repo, message: errorMessage(error) });
    console.error(`[${watcher.repo}] search failed: ${errorMessage(error)}`);
  }

  return result;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function deliver(
  env: Env,
  config: Config,
  entries: DigestEntry[],
  failures: DigestFailure[],
  now: Date,
): Promise<void> {
  const groups = groupByRecipient(entries);
  const defaultKey = recipientKey(config.defaults.notify);

  if (failures.length > 0) {
    const existing = groups.get(defaultKey);
    groups.set(defaultKey, {
      notify: config.defaults.notify,
      entries: existing?.entries ?? [],
      extras: true,
    });
  }

  for (const group of groups.values()) {
    if (group.entries.length === 0 && !group.extras) continue;
    const digest = renderDigest(group.entries, group.extras ? failures : [], now);
    await sendEmail(env, {
      to: group.notify.to,
      from: group.notify.from,
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
    });
  }
}

interface RecipientGroup {
  notify: { to: string; from: string };
  entries: DigestEntry[];
  extras?: boolean;
}

function groupByRecipient(entries: DigestEntry[]): Map<string, RecipientGroup> {
  const groups = new Map<string, RecipientGroup>();
  for (const entry of entries) {
    const key = recipientKey(entry.notify);
    const group = groups.get(key) ?? { notify: entry.notify, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function recipientKey(notify: { to: string; from: string }): string {
  return `${notify.to}\u0000${notify.from}`;
}

function matchedLabel(issue: Issue, labels: string[]): string | null {
  const wanted = labels.map((label) => label.trim().toLowerCase());
  return issue.labels.find((label) => wanted.includes(label.trim().toLowerCase())) ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const reset = "resetAt" in error && error.resetAt instanceof Date ? ` (limit resets ${error.resetAt.toISOString()})` : "";
    return `${error.message}${reset}`;
  }
  return String(error);
}
