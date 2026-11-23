import type { Issue } from "./github.ts";

export const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;

export function matchesAnyLabel(issue: Issue, labels: string[]): boolean {
  if (labels.length === 0) return false;
  const wanted = new Set(labels.map(normalizeLabel));
  return issue.labels.some((label) => wanted.has(normalizeLabel(label)));
}

export function windowStart(cursor: string | null, now: Date): Date {
  if (!cursor) return new Date(now.getTime() - INITIAL_LOOKBACK_MS);
  const parsed = new Date(cursor);
  return Number.isNaN(parsed.getTime()) ? new Date(now.getTime() - INITIAL_LOOKBACK_MS) : parsed;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
