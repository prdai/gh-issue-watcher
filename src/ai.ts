import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import { z } from "zod";
import type { Env } from "./env.ts";
import type { Issue } from "./github.ts";

const OPENCODE_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const USER_AGENT = "gh-issue-watcher/0.1";
const MAX_BODY_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 1500;

const verdictSchema = z.object({
  relevant: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().min(1).max(400),
});

export type Verdict = z.infer<typeof verdictSchema>;

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

export interface JudgeInput {
  issue: Issue;
  interest: string | null;
  model: string;
  session: string;
}

export async function judgeIssue(env: Env, input: JudgeInput): Promise<Verdict> {
  const provider = createOpenAICompatible({
    name: "opencode-go",
    baseURL: OPENCODE_BASE_URL,
    apiKey: env.OPENCODE_API_KEY,
    supportsStructuredOutputs: true,
    headers: { "x-opencode-session": input.session },
    fetch: agentFetch,
  });

  try {
    const { output } = await generateText({
      model: provider(input.model),
      output: Output.object({ schema: verdictSchema, name: "verdict" }),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(input),
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
    });
    return output;
  } catch (error) {
    throw toAiError(error);
  }
}

const SYSTEM_PROMPT = [
  "You triage GitHub issues for a maintainer.",
  "Decide whether the issue falls inside the maintainer's stated interest.",
  "Keep the reason specific and under 200 characters. Do not use placeholders.",
].join(" ");

export function buildPrompt(input: JudgeInput): string {
  const interest = input.interest ?? "Any issue that reports a clear bug or a concrete feature request.";
  return [
    `Issue: ${input.issue.url}`,
    `Labels: ${input.issue.labels.join(", ") || "none"}`,
    `Title: ${input.issue.title}`,
    "",
    "Body:",
    input.issue.body.slice(0, MAX_BODY_CHARS) || "(empty)",
    "",
    "Maintainer interest:",
    interest,
  ].join("\n");
}

const agentFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", USER_AGENT);
  return fetch(input, { ...init, headers });
};

function toAiError(error: unknown): AiError {
  if (NoOutputGeneratedError.isInstance(error)) {
    return new AiError("model produced no final answer within the token budget");
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    return new AiError(`completion did not match the verdict schema: ${error.message}`);
  }
  if (APICallError.isInstance(error)) {
    return new AiError(`OpenCode Go ${error.statusCode ?? "request"} failed: ${error.message}`);
  }
  return new AiError(error instanceof Error ? error.message : String(error));
}
