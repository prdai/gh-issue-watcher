import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError, buildPrompt, judgeIssue, parseVerdict } from "../src/ai.ts";
import { completion, makeIssue, testEnv } from "./fakes.ts";

const issue = makeIssue(7, { title: "Crash on startup", body: "x".repeat(10000), labels: ["bug"] });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseVerdict", () => {
  it("accepts a well-formed verdict", () => {
    expect(parseVerdict('{"relevant":true,"score":0.8,"reason":"crash"}')).toEqual({
      relevant: true,
      score: 0.8,
      reason: "crash",
    });
  });

  it.each([
    ["not json", "not json"],
    ["missing fields", '{"relevant":true}'],
    ["score out of range", '{"relevant":true,"score":2,"reason":"x"}'],
  ])("rejects %s", (_name, content) => {
    expect(() => parseVerdict(content)).toThrow(AiError);
  });
});

describe("buildPrompt", () => {
  it("truncates long bodies and names the interest", () => {
    const prompt = buildPrompt({ issue, interest: "runtime bugs", model: "m" });
    expect(prompt).toContain("Maintainer interest:\nruntime bugs");
    expect(prompt.length).toBeLessThan(10000 + 400);
  });

  it("falls back to a generic interest", () => {
    expect(buildPrompt({ issue, interest: null, model: "m" })).toContain("Any issue");
  });
});

describe("judgeIssue", () => {
  it("posts to OpenCode Go and returns the verdict", async () => {
    const { env } = testEnv();
    const fetchMock = vi.fn(async () => completion({ relevant: true, score: 0.9, reason: "matches" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await judgeIssue(env, { issue, interest: "runtime bugs", model: "deepseek-v4.1-flash" });

    expect(verdict.relevant).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: "Bearer opencode-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "deepseek-v4.1-flash", temperature: 0 });
  });

  it("raises on a non-2xx response", async () => {
    const { env } = testEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(judgeIssue(env, { issue, interest: null, model: "m" })).rejects.toThrow(/500/);
  });

  it("raises on an empty completion", async () => {
    const { env } = testEnv();
    vi.stubGlobal("fetch", vi.fn(async () => completion(null)));

    await expect(judgeIssue(env, { issue, interest: null, model: "m" })).rejects.toThrow(AiError);
  });
});
