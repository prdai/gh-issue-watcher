import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import type { Env } from "./env.ts";

const PER_PAGE = 100;
const MAX_PAGES = 10;
const CLOSING_PR_BATCH = 50;
const USER_AGENT = "gh-issue-watcher/0.1";

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  author: string;
  labels: string[];
}

export class GitHubError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly resetAt: Date | null = null,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface SearchWindow {
  repo: string;
  since: string;
  until: string;
}

export async function searchIssuesSince(env: Env, window: SearchWindow): Promise<Issue[]> {
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN, userAgent: USER_AGENT });
  const issues: Issue[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await searchPage(octokit, window, page);
    issues.push(...items.map((item) => normalize(item)));
    if (items.length < PER_PAGE) break;
  }

  return issues;
}

export async function findIssuesWithClosingPullRequests(
  env: Env,
  repo: string,
  numbers: number[],
): Promise<Set<number>> {
  const found = new Set<number>();
  if (numbers.length === 0) return found;

  const [owner, name] = repo.split("/");
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN, userAgent: USER_AGENT });

  for (const batch of chunk(numbers, CLOSING_PR_BATCH)) {
    const fields = batch
      .map(
        (number, index) =>
          `i${index}: issue(number: ${number}) { closedByPullRequestsReferences(first: 1) { totalCount } }`,
      )
      .join(" ");
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;

    let data: ClosingQuery;
    try {
      data = await octokit.graphql<ClosingQuery>(query, { owner, name });
    } catch (error) {
      throw toGitHubError(error, repo);
    }

    if (!data?.repository) {
      throw new GitHubError(null, `unexpected GitHub graphql response for ${repo}`);
    }

    batch.forEach((number, index) => {
      const total = data.repository?.[`i${index}`]?.closedByPullRequestsReferences.totalCount ?? 0;
      if (total > 0) found.add(number);
    });
  }

  return found;
}

interface ClosingQuery {
  repository: Record<string, { closedByPullRequestsReferences: { totalCount: number } } | null> | null;
}

type SearchItem = Awaited<ReturnType<Octokit["rest"]["search"]["issuesAndPullRequests"]>>["data"]["items"][number];

async function searchPage(octokit: Octokit, window: SearchWindow, page: number): Promise<SearchItem[]> {
  try {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `repo:${window.repo} is:issue created:${queryTime(window.since)}..${queryTime(window.until)}`,
      sort: "created",
      order: "asc",
      per_page: PER_PAGE,
      page,
    });
    if (!Array.isArray(data.items)) {
      throw new GitHubError(null, `unexpected GitHub response for ${window.repo}`);
    }
    return data.items;
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw toGitHubError(error, window.repo);
  }
}

function toGitHubError(error: unknown, repo: string): GitHubError {
  if (error instanceof GitHubError) return error;
  if (error instanceof RequestError) {
    return new GitHubError(
      error.status,
      `GitHub ${error.status} for ${repo}: ${error.message}`,
      rateLimitReset(error),
    );
  }
  return new GitHubError(null, `GitHub request failed for ${repo}: ${String(error)}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function queryTime(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

function rateLimitReset(error: RequestError): Date | null {
  const headers = error.response?.headers ?? {};
  if (String(headers["x-ratelimit-remaining"]) !== "0") return null;
  const reset = Number(headers["x-ratelimit-reset"]);
  return Number.isFinite(reset) ? new Date(reset * 1000) : null;
}

function normalize(raw: SearchItem): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    url: raw.html_url,
    createdAt: raw.created_at,
    author: raw.user?.login ?? "ghost",
    labels: raw.labels.flatMap((label) => {
      if (typeof label === "string") return [label];
      return label.name ? [label.name] : [];
    }),
  };
}
