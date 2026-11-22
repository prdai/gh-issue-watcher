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

function stubApi(options: { issues?: Issue[]; status?: number; verdict?: unknown; error?: string }) {
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
    return completion(options.verdict ?? { relevant: false, score: 0.2, reason: "not a match" });
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
      verdict: { relevant: true, score: 0.9, reason: "real bug" },
    });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ repos: 1, issues: 3, failures: 0, emailed: true });
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.to).toBe("dest@example.com");
    expect(test.sent[0]?.subject).toBe("gh-issue-watcher: 3 issues in 1 repo");
    expect(test.store.get("cursor:owner/repo")).toBe(now.toISOString());
    expect(test.store.get("seen:owner/repo:1")).toBe("1");
    expect(test.store.get("seen:owner/repo:2")).toBe("1");

    const second = await run(test.env, new Date(now.getTime() + 3600_000));
    expect(second).toMatchObject({ issues: 0, emailed: false });
    expect(test.sent).toHaveLength(1);
  });

  it("does not email when nothing matches", async () => {
    const test = await seeded();
    stubApi({ issues: [makeIssue(1)], verdict: { relevant: false, score: 0.1, reason: "docs" } });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 0, failures: 0, emailed: false });
    expect(test.sent).toHaveLength(0);
    expect(test.store.get("cursor:owner/repo")).toBe(now.toISOString());
  });

  it("reports a GitHub failure and leaves the cursor behind", async () => {
    const test = await seeded();
    stubApi({ status: 403, error: "rate limited" });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 0, failures: 1, emailed: true });
    expect(test.sent[0]?.text).toContain("owner/repo: GitHub 403");
    expect(test.sent[0]?.text).toContain("limit resets 2026-11-18T11:06:40.000Z");
    expect(test.store.has("cursor:owner/repo")).toBe(false);
  });

  it("retries an issue whose AI check failed", async () => {
    const test = await seeded();
    let aiFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("https://api.github.com/")) {
          return jsonResponse({ total_count: 1, items: [githubItem(makeIssue(9))] });
        }
        if (aiFails) {
          aiFails = false;
          return new Response("boom", { status: 500 });
        }
        return completion({ relevant: true, score: 0.9, reason: "match" });
      }),
    );

    const first = await run(test.env, now);
    expect(first.failures).toBe(1);
    expect(test.store.has("cursor:owner/repo")).toBe(false);
    expect(test.store.has("seen:owner/repo:9")).toBe(false);

    const later = new Date(now.getTime() + 3600_000);
    const second = await run(test.env, later);
    expect(second.failures).toBe(0);
    expect(second.issues).toBe(1);
    expect(test.store.get("cursor:owner/repo")).toBe(later.toISOString());
  });

  it("defers the rest of the window when the AI cap is hit", async () => {
    const test = await seeded({
      defaults: {
        ai: { enabled: true, model: "deepseek-v4.1-flash", maxPerRun: 1 },
        notify: { to: "dest@example.com", from: "issues@example.com" },
      },
    });
    stubApi({ issues: [makeIssue(1), makeIssue(2)], verdict: { relevant: false, score: 0.1, reason: "no" } });

    const summary = await run(test.env, now);

    expect(summary).toMatchObject({ issues: 0, failures: 0, emailed: false });
    expect(test.store.get("seen:owner/repo:1")).toBe("1");
    expect(test.store.has("seen:owner/repo:2")).toBe(false);
    expect(test.store.has("cursor:owner/repo")).toBe(false);
  });

  it("fails clearly when config is missing", async () => {
    const test = testEnv();

    await expect(run(test.env, now)).rejects.toThrow(/sync-config/);
  });
});
