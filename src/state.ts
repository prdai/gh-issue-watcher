import { parseConfig, type Config } from "./config.ts";
import type { Env } from "./env.ts";

const CONFIG_KEY = "config:watchers";
const CURSOR_KEY = "cursor";

export async function loadConfig(env: Env): Promise<Config> {
  const stored = await env.CONFIG.get(CONFIG_KEY);
  if (!stored) throw new Error(`missing ${CONFIG_KEY} in KV; run bun run sync-config`);
  return parseConfig(JSON.parse(stored));
}

export async function getCursor(env: Env): Promise<string | null> {
  return env.CONFIG.get(CURSOR_KEY);
}

export async function putCursor(env: Env, iso: string): Promise<void> {
  await env.CONFIG.put(CURSOR_KEY, iso);
}
