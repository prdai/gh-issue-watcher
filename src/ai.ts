import { z } from "zod";
import type { Env } from "./env.ts";
import type { Issue } from "./github.ts";

const OPENCODE_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const MAX_BODY_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 300;
const ERROR_BODY_CHARS = 200;

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
});

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
}

export async function judgeIssue(env: Env, input: JudgeInput): Promise<Verdict> {
  const response = await fetch(`${OPENCODE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(input) },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AiError(`OpenCode Go ${response.status}: ${body.slice(0, ERROR_BODY_CHARS)}`);
  }

  const completion = completionSchema.safeParse(await response.json());
  if (!completion.success) throw new AiError("unexpected OpenCode Go response");

  const content = completion.data.choices[0]?.message.content;
  if (!content) throw new AiError("empty completion");

  return parseVerdict(content);
}

const SYSTEM_PROMPT = [
  "You triage GitHub issues for a maintainer.",
  "Decide whether the issue falls inside the maintainer's stated interest.",
  "Reply with a JSON object and nothing else.",
  'Shape: {"relevant": boolean, "score": number between 0 and 1, "reason": string under 200 characters}',
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

export function parseVerdict(content: string): Verdict {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new AiError("completion was not JSON");
  }
  const parsed = verdictSchema.safeParse(raw);
  if (!parsed.success) throw new AiError("completion did not match the verdict schema");
  return parsed.data;
}
