import { parseConfig, type Config } from "./config.ts";
import type { Env } from "./env.ts";

const CONFIG_KEY = "config:watchers";
const CURSOR_PREFIX = "cursor:";
const SEEN_PREFIX = "seen:";
const SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function loadConfig(env: Env): Promise<Config> {
  const stored = await env.CONFIG.get(CONFIG_KEY);
  if (!stored) throw new Error(`missing ${CONFIG_KEY} in KV; run bun run sync-config`);
  return parseConfig(JSON.parse(stored));
}

export async function getCursor(env: Env, repo: string): Promise<string | null> {
  return env.CONFIG.get(CURSOR_PREFIX + repo);
}

export async function putCursor(env: Env, repo: string, iso: string): Promise<void> {
  await env.CONFIG.put(CURSOR_PREFIX + repo, iso);
}

export async function isSeen(env: Env, repo: string, issueNumber: number): Promise<boolean> {
  return (await env.CONFIG.get(seenKey(repo, issueNumber))) !== null;
}

export async function markSeen(env: Env, repo: string, issueNumbers: number[]): Promise<void> {
  await Promise.all(
    issueNumbers.map((number) =>
      env.CONFIG.put(seenKey(repo, number), "1", { expirationTtl: SEEN_TTL_SECONDS }),
    ),
  );
}

function seenKey(repo: string, issueNumber: number): string {
  return `${SEEN_PREFIX}${repo}:${issueNumber}`;
}
