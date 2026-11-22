import { z } from "zod";

export const DEFAULT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_AI_ENABLED = true;
export const DEFAULT_MAX_AI_CHECKS = 25;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const notifySchema = z
  .object({
    to: z.email(),
    from: z.email(),
  })
  .strict();

const aiDefaultsSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_AI_ENABLED),
    model: z.string().trim().min(1).default(DEFAULT_MODEL),
    maxPerRun: z.number().int().min(1).max(500).default(DEFAULT_MAX_AI_CHECKS),
  })
  .strict();

const watcherSchema = z
  .object({
    repo: z.string().regex(REPO_PATTERN, "repo must be owner/name"),
    labels: z.array(z.string().trim().min(1)).default([]),
    ai: z.boolean().optional(),
    model: z.string().trim().min(1).optional(),
    interest: z.string().trim().min(1).optional(),
    notify: notifySchema.partial().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    defaults: z
      .object({
        ai: aiDefaultsSchema.prefault({}),
        interest: z.string().trim().min(1).optional(),
        notify: notifySchema,
      })
      .strict(),
    watchers: z.array(watcherSchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.watchers.forEach((watcher, index) => {
      const key = watcher.repo.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate watcher for ${watcher.repo}`,
          path: ["watchers", index, "repo"],
        });
      }
      seen.add(key);
    });
  });

export type Config = z.infer<typeof configSchema>;
export type Watcher = Config["watchers"][number];

export interface ResolvedWatcher {
  repo: string;
  labels: string[];
  ai: boolean;
  model: string;
  interest: string | null;
  notify: { to: string; from: string };
}

export function parseConfig(value: unknown): Config {
  return configSchema.parse(value);
}

export function resolveWatchers(config: Config): ResolvedWatcher[] {
  return config.watchers.map((watcher) => ({
    repo: watcher.repo,
    labels: watcher.labels,
    ai: watcher.ai ?? config.defaults.ai.enabled,
    model: watcher.model ?? config.defaults.ai.model,
    interest: watcher.interest ?? config.defaults.interest ?? null,
    notify: {
      to: watcher.notify?.to ?? config.defaults.notify.to,
      from: watcher.notify?.from ?? config.defaults.notify.from,
    },
  }));
}

export function maxAiChecks(config: Config): number {
  return config.defaults.ai.maxPerRun;
}
