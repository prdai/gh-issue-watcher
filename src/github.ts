import { z } from "zod";
import type { Env } from "./env.ts";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const PER_PAGE = 100;
const MAX_PAGES = 10;
const ERROR_BODY_CHARS = 200;

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  labels: z.array(
    z.union([
      z.string(),
      z.object({ name: z.string() }),
    ]),
  ),
});

const searchSchema = z.object({
  total_count: z.number().int(),
  items: z.array(issueSchema),
});

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
    readonly status: number,
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
  const issues: Issue[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await searchPage(window, page, env.GITHUB_TOKEN);
    issues.push(...items.map((item) => normalize(item)));
    if (items.length < PER_PAGE) break;
  }

  return issues;
}

async function searchPage(window: SearchWindow, page: number, token: string): Promise<z.infer<typeof issueSchema>[]> {
  const query = `repo:${window.repo} is:issue created:${queryTime(window.since)}..${queryTime(window.until)}`;
  const url = new URL(`${GITHUB_API}/search/issues`);
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "created");
  url.searchParams.set("order", "asc");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));

  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "gh-issue-watcher",
      "x-github-api-version": GITHUB_API_VERSION,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubError(
      response.status,
      `GitHub ${response.status} for ${window.repo}: ${body.slice(0, ERROR_BODY_CHARS)}`,
      rateLimitReset(response.headers),
    );
  }

  const parsed = searchSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new GitHubError(response.status, `unexpected GitHub response for ${window.repo}`);
  }
  return parsed.data.items;
}

function queryTime(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

function rateLimitReset(headers: Headers): Date | null {
  if (headers.get("x-ratelimit-remaining") !== "0") return null;
  const reset = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) ? new Date(reset * 1000) : null;
}

function normalize(raw: z.infer<typeof issueSchema>): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    url: raw.html_url,
    createdAt: raw.created_at,
    author: raw.user?.login ?? "ghost",
    labels: raw.labels.map((label) => (typeof label === "string" ? label : label.name)),
  };
}
