import { parseConfig, type Config } from "./config.ts";
import type { Env } from "./env.ts";

const CONFIG_KEY = "config:watchers";
const CURSOR_PREFIX = "cursor:";

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
