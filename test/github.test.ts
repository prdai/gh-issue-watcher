import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubError, searchIssuesSince } from "../src/github.ts";
import { githubItem, jsonResponse, makeIssue, testEnv } from "./fakes.ts";

const window = {
  repo: "owner/repo",
  since: "2026-11-22T04:00:00.000Z",
  until: "2026-11-22T05:00:00.000Z",

};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchIssuesSince", () => {
  it("builds a bounded created range and normalizes labels", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ total_count: 1, items: [githubItem(makeIssue(3, { labels: ["bug", "help wanted"] }))] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { env } = testEnv();

    const issues = await searchIssuesSince(env, window);

    expect(issues).toEqual([
      {
        number: 3,
        title: "Issue 3",
        body: "Body 3",
        url: "https://github.com/owner/repo/issues/3",
        createdAt: "2026-11-22T05:00:00Z",
        author: "someone",
        labels: ["bug", "help wanted"],
      },
    ]);

    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(String(input));
    expect(url.searchParams.get("q")).toBe(
      "repo:owner/repo is:issue created:2026-11-22T04:00:00Z..2026-11-22T05:00:00Z",
    );
    expect(url.searchParams.get("sort")).toBe("created");
    expect(new Headers(init.headers).get("authorization")).toBe("token gh-token");
  });

  it("paginates until a short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      githubItem(makeIssue(index + 1, { labels: [] })),
    );
    const secondPage = [githubItem(makeIssue(101, { labels: [] }))];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ total_count: 101, items: firstPage }))
      .mockResolvedValueOnce(jsonResponse({ total_count: 101, items: secondPage }));
    vi.stubGlobal("fetch", fetchMock);
    const { env } = testEnv();

    const issues = await searchIssuesSince(env, window);

    expect(issues).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("carries the rate-limit reset when GitHub is exhausted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("rate limited", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" },
        }),
      ),
    );
    const { env } = testEnv();

    const error = await searchIssuesSince(env, window).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(403);
    expect((error as GitHubError).resetAt?.toISOString()).toBe("2026-11-18T11:06:40.000Z");
  });

  it("rejects an unexpected payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ items: "nope" })));
    const { env } = testEnv();

    await expect(searchIssuesSince(env, window)).rejects.toThrow(/unexpected GitHub response/);
  });
});
