import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError, buildPrompt, judgeIssues } from "../src/ai";
import { completion, makeIssue, testEnv } from "./fakes";

const issues = [
  makeIssue(7, { title: "Crash on startup", body: "x".repeat(10000), labels: ["bug"] }),
  makeIssue(8, { title: "Wrong dtype", body: "float16 mismatch", labels: [] }),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPrompt", () => {
  it("lists every issue with a truncated body", () => {
    const prompt = buildPrompt({ issues, interest: "runtime bugs", model: "m", session: "s" });
    expect(prompt).toContain("Maintainer interest:\nruntime bugs");
    expect(prompt).toContain("Issues (2):");
    expect(prompt).toContain("### 7");
    expect(prompt).toContain("### 8");
    expect(prompt.length).toBeLessThan(2500);
  });

  it("falls back to a generic interest", () => {
    expect(buildPrompt({ issues, interest: null, model: "m", session: "s" })).toContain("Any issue");
  });
});

describe("judgeIssues", () => {
  it("sends one batched call and returns a verdict per issue", async () => {
    const { env } = testEnv();
    const fetchMock = vi.fn(async () =>
      completion({
        verdicts: [
          { number: 7, relevant: true, score: 0.9, reason: "matches" },
          { number: 8, relevant: false, score: 0.1, reason: "docs" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const verdicts = await judgeIssues(env, {
      issues,
      interest: "runtime bugs",
      model: "deepseek-v4.1-flash",
      session: "gh-issue-watcher:owner/repo",
    });

    expect(verdicts.get(7)).toMatchObject({ relevant: true, score: 0.9 });
    expect(verdicts.get(8)).toMatchObject({ relevant: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer opencode-key");
    expect(headers.get("x-opencode-session")).toBe("gh-issue-watcher:owner/repo");
    expect(headers.get("user-agent")).toBe("gh-issue-watcher/0.1");

    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "deepseek-v4.1-flash",
      temperature: 0,
      max_tokens: 1200,
      reasoning_effort: "low",
      response_format: { type: "json_schema" },
    });
    const prompt = JSON.stringify(body.messages);
    expect(prompt).toContain("### 7");
    expect(prompt).toContain("### 8");
  });

  it("makes no call for an empty batch", async () => {
    const { env } = testEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const verdicts = await judgeIssues(env, { issues: [], interest: null, model: "m", session: "s" });

    expect(verdicts.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("raises when a verdict is missing", async () => {
    const { env } = testEnv();
    vi.stubGlobal("fetch", vi.fn(async () => completion({ verdicts: [{ number: 7, relevant: true, score: 1, reason: "ok" }] })));

    await expect(judgeIssues(env, { issues, interest: null, model: "m", session: "s" })).rejects.toThrow(
      /missed 1 of 2/,
    );
  });

  it("retries once when the model returns an unparsable batch", async () => {
    const { env } = testEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completion("not an object"))
      .mockResolvedValueOnce(
        completion({
          verdicts: issues.map((issue) => ({ number: issue.number, relevant: false, score: 0, reason: "no" })),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const verdicts = await judgeIssues(env, { issues, interest: null, model: "m", session: "s" });

    expect(verdicts.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wraps a non-2xx response", async () => {
    const { env } = testEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(judgeIssues(env, { issues, interest: null, model: "m", session: "s" })).rejects.toThrow(
      /OpenCode Go 500/,
    );
  });

  it("raises AiError when the model returns an invalid shape", async () => {
    const { env } = testEnv();
    vi.stubGlobal("fetch", vi.fn(async () => completion({ verdicts: "nope" })));

    await expect(judgeIssues(env, { issues, interest: null, model: "m", session: "s" })).rejects.toThrow(AiError);
  });
});
