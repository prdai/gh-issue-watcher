import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError, buildPrompt, judgeIssue } from "../src/ai";
import { completion, makeIssue, testEnv } from "./fakes";

const issue = makeIssue(7, { title: "Crash on startup", body: "x".repeat(10000), labels: ["bug"] });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPrompt", () => {
  it("truncates long bodies and names the interest", () => {
    const prompt = buildPrompt({ issue, interest: "runtime bugs", model: "m", session: "s" });
    expect(prompt).toContain("Maintainer interest:\nruntime bugs");
    expect(prompt.length).toBeLessThan(10000 + 400);
  });

  it("falls back to a generic interest", () => {
    expect(buildPrompt({ issue, interest: null, model: "m", session: "s" })).toContain("Any issue");
  });
});

describe("judgeIssue", () => {
  it("calls OpenCode Go through the AI SDK and validates the verdict", async () => {
    const { env } = testEnv();
    const fetchMock = vi.fn(async () => completion({ relevant: true, score: 0.9, reason: "matches" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await judgeIssue(env, {
      issue,
      interest: "runtime bugs",
      model: "deepseek-v4.1-flash",
      session: "gh-issue-watcher:owner/repo",
    });

    expect(verdict).toEqual({ relevant: true, score: 0.9, reason: "matches" });
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
      max_tokens: 1500,
      response_format: { type: "json_schema" },
    });
    expect(body.messages[0]).toMatchObject({ role: "system" });
  });

  it("wraps a non-2xx response", async () => {
    const { env } = testEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(judgeIssue(env, { issue, interest: null, model: "m", session: "s" })).rejects.toThrow(/OpenCode Go 500/);
  });

  it("raises AiError when the model returns an invalid verdict", async () => {
    const { env } = testEnv();
    vi.stubGlobal("fetch", vi.fn(async () => completion({ relevant: "maybe" })));

    await expect(judgeIssue(env, { issue, interest: null, model: "m", session: "s" })).rejects.toThrow(AiError);
  });
});
