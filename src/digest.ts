import type { Issue } from "./github.ts";

export interface DigestEntry {
  repo: string;
  issue: Issue;
  source: "label" | "ai";
  label: string | null;
  reason: string | null;
  notify: { to: string; from: string };
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
}

export function renderDigest(entries: DigestEntry[], now: Date): Digest {
  return {
    subject: subjectFor(entries),
    text: textFor(entries, now),
    html: htmlFor(entries, now),
  };
}

function subjectFor(entries: DigestEntry[]): string {
  const repos = new Set(entries.map((entry) => entry.repo));
  const issues = `${entries.length} ${entries.length === 1 ? "issue" : "issues"}`;
  const repoPart = `${repos.size} ${repos.size === 1 ? "repo" : "repos"}`;
  return `gh-issue-watcher: ${issues} in ${repoPart}`;
}

function textFor(entries: DigestEntry[], now: Date): string {
  const lines = [`gh-issue-watcher run ${now.toISOString()}`, ""];

  for (const [repo, group] of groupByRepo(entries)) {
    lines.push(`${repo} (${group.length})`);
    for (const entry of group) {
      const tag = entry.source === "label" ? `label: ${entry.label ?? ""}` : "ai match";
      lines.push(`  #${entry.issue.number} ${entry.issue.title} [${tag}]`);
      lines.push(`  ${entry.issue.url}`);
      if (entry.reason) lines.push(`  why: ${entry.reason}`);
      lines.push("");
    }
  }

  if (entries.length === 0) lines.push("No issues matched.", "");

  return lines.join("\n").trimEnd() + "\n";
}

function htmlFor(entries: DigestEntry[], now: Date): string {
  const parts = [`<p>gh-issue-watcher run ${escapeHtml(now.toISOString())}</p>`];

  for (const [repo, group] of groupByRepo(entries)) {
    parts.push(`<h2>${escapeHtml(repo)} (${group.length})</h2><ul>`);
    for (const entry of group) {
      const tag = entry.source === "label" ? `label: ${entry.label ?? ""}` : "ai match";
      const reason = entry.reason ? `<br><em>${escapeHtml(entry.reason)}</em>` : "";
      parts.push(
        `<li><a href="${escapeHtml(entry.issue.url)}">#${entry.issue.number} ${escapeHtml(entry.issue.title)}</a> <small>[${escapeHtml(tag)}]</small>${reason}</li>`,
      );
    }
    parts.push("</ul>");
  }

  if (entries.length === 0) parts.push("<p>No issues matched.</p>");

  return parts.join("\n");
}

function groupByRepo(entries: DigestEntry[]): Map<string, DigestEntry[]> {
  const groups = new Map<string, DigestEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.repo) ?? [];
    group.push(entry);
    groups.set(entry.repo, group);
  }
  return groups;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
