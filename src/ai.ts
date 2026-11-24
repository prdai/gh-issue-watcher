import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import { z } from "zod";
import type { Env } from "./env.ts";
import type { Issue } from "./github.ts";

const OPENCODE_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const USER_AGENT = "gh-issue-watcher/0.1";
const MAX_BODY_CHARS = 600;
const REASONING_EFFORT = "low";
const ATTEMPTS = 2;
const OUTPUT_BASE_TOKENS = 800;
const OUTPUT_TOKENS_PER_ISSUE = 200;
const MAX_OUTPUT_TOKENS = 8000;

const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      number: z.number().int(),
      relevant: z.boolean(),
      score: z.number().min(0).max(1),
      reason: z.string().min(1).max(400),
    }),
  ),
});

export type Verdict = z.infer<typeof verdictsSchema>["verdicts"][number];

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

export interface JudgeInput {
  issues: Issue[];
  interest: string | null;
  model: string;
  session: string;
}

export async function judgeIssues(env: Env, input: JudgeInput): Promise<Map<number, Verdict>> {
  if (input.issues.length === 0) return new Map();

  const provider = createOpenAICompatible({
    name: "opencode-go",
    baseURL: OPENCODE_BASE_URL,
    apiKey: env.OPENCODE_API_KEY,
    supportsStructuredOutputs: true,
    headers: { "x-opencode-session": input.session },
    fetch: agentFetch,
    transformRequestBody: (body) => ({ ...body, reasoning_effort: REASONING_EFFORT }),
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const { output } = await generateText({
        model: provider(input.model),
        output: Output.object({ schema: verdictsSchema, name: "verdicts" }),
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(input),
        temperature: 0,
        maxOutputTokens: outputBudget(input.issues.length, attempt),
        maxRetries: 0,
      });
      return alignVerdicts(input.issues, output.verdicts);
    } catch (error) {
      lastError = error;
      if (!NoObjectGeneratedError.isInstance(error) && !NoOutputGeneratedError.isInstance(error)) break;
    }
  }
  throw toAiError(lastError);
}

const SYSTEM_PROMPT = [
  "You triage GitHub issues for a maintainer.",
  "Decide whether each issue falls inside the maintainer's stated interest.",
  "Return exactly one verdict per issue number and never invent issue numbers.",
  "Keep each reason specific and under 200 characters. Do not use placeholders.",
].join(" ");

export function buildPrompt(input: JudgeInput): string {
  const interest = input.interest ?? "Any issue that reports a clear bug or a concrete feature request.";
  const sections = input.issues.map((issue) =>
    [
      `### ${issue.number}`,
      `title: ${issue.title}`,
      `labels: ${issue.labels.join(", ") || "none"}`,
      "body:",
      issue.body.slice(0, MAX_BODY_CHARS).trim() || "(empty)",
    ].join("\n"),
  );

  return [
    "Maintainer interest:",
    interest,
    "",
    `Issues (${input.issues.length}):`,
    ...sections,
  ].join("\n");
}

function outputBudget(issueCount: number, attempt: number): number {
  const base = OUTPUT_BASE_TOKENS + issueCount * OUTPUT_TOKENS_PER_ISSUE;
  return Math.min(MAX_OUTPUT_TOKENS, base * attempt);
}

function alignVerdicts(issues: Issue[], verdicts: Verdict[]): Map<number, Verdict> {
  const byNumber = new Map<number, Verdict>();
  for (const verdict of verdicts) {
    if (!byNumber.has(verdict.number)) byNumber.set(verdict.number, verdict);
  }

  const missing = issues.filter((issue) => !byNumber.has(issue.number));
  if (missing.length > 0) {
    throw new AiError(`completion missed ${missing.length} of ${issues.length} issues`);
  }

  return new Map(issues.map((issue) => [issue.number, byNumber.get(issue.number)!]));
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
