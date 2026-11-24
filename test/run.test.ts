import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.ts";
import { WATCHER_CONFIG, completion, githubItem, jsonResponse, makeIssue, testEnv, type TestEnv } from "./fakes.ts";
import type { Issue } from "../src/github.ts";

const now = new Date("2026-11-22T05:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seeded(overrides: Record<string, unknown> = {}): Promise<TestEnv> {
  const test = testEnv();
  await test.env.CONFIG.put(
    "config:watchers",
    JSON.stringify({ ...WATCHER_CONFIG, ...overrides }),
  );
  return test;
}

function stubApi(options: { issues?: Issue[]; status?: number; relevant?: boolean; error?: string }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      if (options.status) {
        return new Response(options.error ?? "nope", {
          status: options.status,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" },
        });
      }
      const issues = options.issues ?? [];
      return jsonResponse({ total_count: issues.length, items: issues.map(githubItem) });
    }
    const issues = options.issues ?? [];
    return completion({
      verdicts: issues.map((issue) => ({
        number: issue.number,
        relevant: options.relevant ?? false,
        score: 0.5,
        reason: "stub verdict",
      })),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("run", () => {
  it("emails label and AI matches, then advances state", async () => {
    const test = await seeded();
    stubApi({
      issues: [
        makeIssue(1, { labels: ["Bug"] }),
        makeIssue(2, { labels: [] }),
        makeIssue(3, { labels: [] }),
      ],
      relevant: true,
    });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ repos: 1, issues: 3, failures: 0, emailed: true });
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.to).toBe("dest@example.com");
    expect(test.sent[0]?.subject).toBe("gh-issue-watcher: 3 issues in 1 repo");
    expect(test.store.get("cursor")).toBe(now.toISOString());
    expect(test.store.size).toBe(2);
  });

  it("does not email when nothing matches", async () => {
    const test = await seeded();
    stubApi({ issues: [makeIssue(1)] });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 0, failures: 0, emailed: false });
    expect(test.sent).toHaveLength(0);
    expect(test.store.get("cursor")).toBe(now.toISOString());
  });

  it("reports a GitHub failure and leaves the cursor behind", async () => {
    const test = await seeded();
    stubApi({ status: 403, error: "rate limited" });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 0, failures: 1, emailed: false });
    expect(summary.errors[0]?.message).toContain("GitHub 403");
    expect(summary.errors[0]?.message).toContain("limit resets 2026-11-18T11:06:40.000Z");
    expect(test.sent).toHaveLength(0);
    expect(test.store.has("cursor")).toBe(false);
  });

  it("advances the window even when an AI check fails", async () => {
    const test = await seeded();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("https://api.github.com/")) {
          return jsonResponse({ total_count: 1, items: [githubItem(makeIssue(9))] });
        }
        return new Response("boom", { status: 500 });
      }),
    );

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 0, failures: 1, emailed: false });
    expect(summary.errors[0]?.message).toContain("AI request for 1 issues");
    expect(test.store.get("cursor")).toBe(now.toISOString());
  });

  it("sends one AI request for the whole window", async () => {
    const test = await seeded();
    const issues = Array.from({ length: 25 }, (_, index) => makeIssue(index + 1));
    stubApi({ issues });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 0, failures: 0, emailed: false });
    const aiCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("opencode.ai"));
    expect(aiCalls).toHaveLength(1);
    expect(test.store.get("cursor")).toBe(now.toISOString());
  });

  it("keeps label matches out of the AI batch", async () => {
    const test = await seeded();
    stubApi({ issues: [makeIssue(1, { labels: ["bug"] }), makeIssue(2)] });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 1, failures: 0, emailed: true });
    const aiCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("opencode.ai"));
    const body = JSON.parse(String((aiCall?.[1] as RequestInit).body));
    const prompt = JSON.stringify(body.messages);
    expect(prompt).toContain("### 2");
    expect(prompt).not.toContain("### 1");
  });

  it("advances the shared cursor when only some watchers succeed", async () => {
    const test = testEnv();
    await test.env.CONFIG.put(
      "config:watchers",
      JSON.stringify({
        defaults: {
          ai: { enabled: false, model: "m" },
          notify: { to: "dest@example.com", from: "issues@example.com" },
        },
        watchers: [
          { repo: "owner/one", labels: ["bug"] },
          { repo: "owner/two", labels: ["bug"] },
        ],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const q = new URL(String(input)).searchParams.get("q") ?? "";
        if (q.startsWith("repo:owner/two")) return new Response("boom", { status: 500 });
        return jsonResponse({ total_count: 0, items: [] });
      }),
    );

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ repos: 2, failures: 1, emailed: false });
    expect(test.store.get("cursor")).toBe(now.toISOString());
  });

  it("collects watchers concurrently and keeps their results ordered", async () => {
    const test = testEnv();
    await test.env.CONFIG.put(
      "config:watchers",
      JSON.stringify({
        defaults: {
          ai: { enabled: false, model: "m" },
          notify: { to: "dest@example.com", from: "issues@example.com" },
        },
        watchers: [
          { repo: "owner/one", labels: ["bug"] },
          { repo: "owner/two", labels: ["bug"] },
        ],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const q = new URL(String(input)).searchParams.get("q") ?? "";
        const number = q.startsWith("repo:owner/one") ? 1 : 2;
        return jsonResponse({
          total_count: 1,
          items: [githubItem(makeIssue(number, { labels: ["bug"] }))],
        });
      }),
    );

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ repos: 2, issues: 2, failures: 0, emailed: true });
    expect(summary.hits.map((hit) => hit.repo)).toEqual(["owner/one", "owner/two"]);
    expect(test.store.get("cursor")).toBe(now.toISOString());
  });

  it("fails clearly when config is missing", async () => {
    const test = testEnv();

    await expect(run(test.env, now)).rejects.toThrow(/sync-config/);
  });
});
