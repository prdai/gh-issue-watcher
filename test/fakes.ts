import type { Env } from "../src/env";
import type { Issue } from "../src/github";

export interface SentEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface TestEnv {
  env: Env;
  store: Map<string, string>;
  sent: SentEmail[];
}

export function testEnv(overrides: Partial<Env> = {}): TestEnv {
  const store = new Map<string, string>();
  const sent: SentEmail[] = [];

  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;

  const email = {
    send: async (message: SentEmail) => {
      sent.push(message);
      return { messageId: "test" };
    },
  } as unknown as SendEmail;

  const env: Env = {
    CONFIG: kv,
    EMAIL: email,
    GITHUB_TOKEN: "gh-token",
    OPENCODE_API_KEY: "opencode-key",
    RUN_TOKEN: "run-token",
    ...overrides,
  };

  return { env, store, sent };
}

export function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    createdAt: "2026-11-22T05:00:00Z",
    author: "someone",
    labels: [],
    ...overrides,
  };
}

export function githubItem(issue: Issue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    html_url: issue.url,
    created_at: issue.createdAt,
    user: { login: issue.author },
    labels: issue.labels.map((name) => ({ name })),
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function completion(content: unknown): Response {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(content) } }],
  });
}

export const WATCHER_CONFIG = {
  defaults: {
    ai: { enabled: true, model: "deepseek-v4.1-flash", maxPerRun: 25 },
    notify: { to: "dest@example.com", from: "issues@example.com" },
  },
  watchers: [{ repo: "owner/repo", labels: ["bug"] }],
};
