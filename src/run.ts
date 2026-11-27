import { judgeIssues } from "./ai.ts";
import { resolveWatchers, type ResolvedWatcher } from "./config.ts";
import { renderDigest, type DigestEntry } from "./digest.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { searchIssuesSince, findIssuesWithClosingPullRequests, type Issue } from "./github.ts";
import { windowStart } from "./match.ts";
import { getCursor, loadConfig, putCursor } from "./state.ts";

export interface RunFailure {
  repo: string;
  message: string;
}

export interface RunSummary {
  ranAt: string;
  repos: number;
  issues: number;
  failures: number;
  emailed: boolean;
  errors: RunFailure[];
  hits: { repo: string; number: number; source: "label" | "ai" }[];
}

interface CollectResult {
  searched: boolean;
  entries: DigestEntry[];
  failures: RunFailure[];
}

export async function run(env: Env, now: Date): Promise<RunSummary> {
  const config = await loadConfig(env);
  const watchers = resolveWatchers(config);
  const until = now.toISOString();
  const since = windowStart(await getCursor(env), now).toISOString();
  const entries: DigestEntry[] = [];
  const failures: RunFailure[] = [];

  const collected = await Promise.all(
    watchers.map(async (watcher) => ({ watcher, result: await collect(env, watcher, since, until) })),
  );

  for (const { result } of collected) {
    entries.push(...result.entries);
    failures.push(...result.failures);
  }

  const shouldEmail = entries.length > 0;
  if (shouldEmail) await deliver(env, config.defaults.notify, entries, now);

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
    const candidates = await withoutClosingPullRequests(env, watcher.repo, issues, result);
    for (const issue of candidates) {
      const label = matchedLabel(issue, watcher.labels);
      if (label) {
        result.entries.push({ repo: watcher.repo, issue, source: "label", label, reason: null, });
        continue;
      }
      unmatched.push(issue);
    }

    if (watcher.ai && unmatched.length > 0) {
      try {
        const verdicts = await judgeIssues(env, {
          issues: unmatched,
          interest: watcher.interest,
          model: watcher.model,
          session: `gh-issue-watcher:${watcher.repo}`,
        });
        for (const issue of unmatched) {
          const verdict = verdicts.get(issue.number);
          if (verdict?.relevant) {
            result.entries.push({ repo: watcher.repo, issue, source: "ai", label: null, reason: verdict.reason, });
          }
        }
      } catch (error) {
        result.failures.push({ repo: watcher.repo, message: `AI request for ${unmatched.length} issues: ${errorMessage(error)}` });
        console.error(`[${watcher.repo}] AI request for ${unmatched.length} issues failed: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    result.failures.push({ repo: watcher.repo, message: errorMessage(error) });
    console.error(`[${watcher.repo}] search failed: ${errorMessage(error)}`);
  }

  return result;
}

async function withoutClosingPullRequests(
  env: Env,
  repo: string,
  issues: Issue[],
  result: CollectResult,
): Promise<Issue[]> {
  if (issues.length === 0) return issues;

  try {
    const linked = await findIssuesWithClosingPullRequests(env, repo, issues.map((issue) => issue.number));
    return issues.filter((issue) => !linked.has(issue.number));
  } catch (error) {
    result.failures.push({ repo, message: `Linked pull request check: ${errorMessage(error)}` });
    console.error(`[${repo}] linked pull request check failed: ${errorMessage(error)}`);
    return issues;
  }
}

async function deliver(
  env: Env,
  notify: { to: string; from: string },
  entries: DigestEntry[],
  now: Date,
): Promise<void> {
  const digest = renderDigest(entries, now);
  await sendEmail(env, {
    to: notify.to,
    from: notify.from,
    subject: digest.subject,
    text: digest.text,
    html: digest.html,
  });
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
