import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ZodError } from "zod";
import { parseWatchersYaml } from "./config-file.ts";

const CONFIG_PATH = resolve(process.cwd(), "watchers.yaml");
const CHECK = process.argv.includes("--check");

let config;
try {
  config = parseWatchersYaml(await readFile(CONFIG_PATH, "utf8"));
} catch (error) {
  if (error instanceof ZodError) {
    for (const issue of error.issues) {
      console.error(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  throw error;
}

if (CHECK) {
  console.log(`watchers.yaml ok: ${config.watchers.length} watchers`);
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "gh-issue-watcher-"));
const jsonPath = join(dir, "watchers.json");
await writeFile(jsonPath, JSON.stringify(config));

const result = spawnSync(
  "wrangler",
  ["kv", "key", "put", "config:watchers", "--binding", "CONFIG", "--path", jsonPath, "--remote"],
  { stdio: "inherit" },
);

if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`synced ${config.watchers.length} watchers to config:watchers`);
