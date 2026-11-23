import { judgeIssue } from "./ai.ts";
import { maxAiChecks, resolveWatchers, type Config, type ResolvedWatcher } from "./config.ts";
import { renderDigest, type DigestEntry, type DigestFailure } from "./digest.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { searchIssuesSince, type Issue } from "./github.ts";
import { windowStart } from "./match.ts";
import { getCursor, isSeen, loadConfig, markSeen, putCursor } from "./state.ts";

export interface RunSummary {
  ranAt: string;
  repos: number;
  issues: number;
  failures: number;
  emailed: boolean;
  errors: DigestFailure[];
  hits: { repo: string; number: number; source: "label" | "ai" }[];
  skipped: number;
}

interface CollectResult {
  searched: boolean;
  processed: number[];
  skipped: number;
}

export async function run(env: Env, now: Date): Promise<RunSummary> {
  const config = await loadConfig(env);
  const watchers = resolveWatchers(config);
  const aiLimit = maxAiChecks(config);
  const until = now.toISOString();
  const entries: DigestEntry[] = [];
  const failures: DigestFailure[] = [];
  const notes: string[] = [];
  const settled: string[] = [];
  const processed = new Map<string, number[]>();
  let skipped = 0;

  for (const watcher of watchers) {
    const result = await collect(env, watcher, now, until, aiLimit, entries, failures, notes);
    processed.set(watcher.repo, result.processed);
    skipped += result.skipped;
    if (result.searched) settled.push(watcher.repo);
  }

  const shouldEmail = entries.length > 0 || failures.length > 0;
  if (shouldEmail) await deliver(env, config, entries, failures, notes, now);

  await Promise.all(
    [...processed].map(([repo, numbers]) => (numbers.length > 0 ? markSeen(env, repo, numbers) : Promise.resolve())),
  );
  await Promise.all(settled.map((repo) => putCursor(env, repo, until)));

  return {
    ranAt: until,
    repos: watchers.length,
    issues: entries.length,
    failures: failures.length,
    emailed: shouldEmail,
    errors: failures,
    hits: entries.map((entry) => ({ repo: entry.repo, number: entry.issue.number, source: entry.source })),
    skipped,
  };
}

async function collect(
  env: Env,
  watcher: ResolvedWatcher,
  now: Date,
  until: string,
  aiLimit: number,
  entries: DigestEntry[],
  failures: DigestFailure[],
  notes: string[],
): Promise<CollectResult> {
  const result: CollectResult = { searched: false, processed: [], skipped: 0 };

  try {
    const cursor = await getCursor(env, watcher.repo);
    const since = windowStart(cursor, now).toISOString();
    const issues = await searchIssuesSince(env, { repo: watcher.repo, since, until });
    result.searched = true;

    let aiChecks = 0;
    for (const issue of await dropSeen(env, watcher.repo, issues)) {
      const label = matchedLabel(issue, watcher.labels);
      if (label) {
        result.processed.push(issue.number);
        entries.push({ repo: watcher.repo, issue, source: "label", label, reason: null, notify: watcher.notify });
        continue;
      }

      if (!watcher.ai) {
        result.processed.push(issue.number);
        continue;
      }

      if (aiChecks >= aiLimit) {
        result.skipped++;
        continue;
      }

      aiChecks++;

      try {
        const verdict = await judgeIssue(env, {
          issue,
          interest: watcher.interest,
          model: watcher.model,
          session: `gh-issue-watcher:${watcher.repo}`,
        });
        result.processed.push(issue.number);
        if (verdict.relevant) {
          entries.push({ repo: watcher.repo, issue, source: "ai", label: null, reason: verdict.reason, notify: watcher.notify });
        }
      } catch (error) {
        failures.push({ repo: watcher.repo, message: `AI: #${issue.number} ${errorMessage(error)}` });
        console.error(`[${watcher.repo}] AI check failed for #${issue.number}: ${errorMessage(error)}`);
      }
    }

    if (result.skipped > 0) {
      notes.push(`${watcher.repo}: ${result.skipped} issues skipped by the AI cap of ${aiLimit}`);
    }
  } catch (error) {
    failures.push({ repo: watcher.repo, message: errorMessage(error) });
    console.error(`[${watcher.repo}] search failed: ${errorMessage(error)}`);
  }

  return result;
}

async function dropSeen(env: Env, repo: string, issues: Issue[]): Promise<Issue[]> {
  const checks = await Promise.all(issues.map((issue) => isSeen(env, repo, issue.number)));
  return issues.filter((_, index) => !checks[index]);
}

async function deliver(
  env: Env,
  config: Config,
  entries: DigestEntry[],
  failures: DigestFailure[],
  notes: string[],
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
    const digest = renderDigest(
      group.entries,
      group.extras ? failures : [],
      group.extras ? notes : [],
      now,
    );
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
