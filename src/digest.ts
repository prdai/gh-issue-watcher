import type { Issue } from "./github";

export interface DigestEntry {
  repo: string;
  issue: Issue;
  source: "label" | "ai";
  label: string | null;
  reason: string | null;
  notify: { to: string; from: string };
}

export interface DigestFailure {
  repo: string;
  message: string;
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
}

export function renderDigest(
  entries: DigestEntry[],
  failures: DigestFailure[],
  notes: string[],
  now: Date,
): Digest {
  return {
    subject: subjectFor(entries, failures),
    text: textFor(entries, failures, notes, now),
    html: htmlFor(entries, failures, notes, now),
  };
}

function subjectFor(entries: DigestEntry[], failures: DigestFailure[]): string {
  const repos = new Set(entries.map((entry) => entry.repo));
  const issues = `${entries.length} ${entries.length === 1 ? "issue" : "issues"}`;
  const repoPart = `${repos.size} ${repos.size === 1 ? "repo" : "repos"}`;
  const failurePart = failures.length > 0 ? ` (${failures.length} ${failures.length === 1 ? "failure" : "failures"})` : "";
  return `gh-issue-watcher: ${issues} in ${repoPart}${failurePart}`;
}

function textFor(
  entries: DigestEntry[],
  failures: DigestFailure[],
  notes: string[],
  now: Date,
): string {
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

  if (failures.length > 0) {
    lines.push("Failures");
    for (const failure of failures) lines.push(`  ${failure.repo}: ${failure.message}`);
    lines.push("");
  }

  if (notes.length > 0) {
    lines.push("Notes");
    for (const note of notes) lines.push(`  ${note}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function htmlFor(
  entries: DigestEntry[],
  failures: DigestFailure[],
  notes: string[],
  now: Date,
): string {
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

  if (failures.length > 0) {
    parts.push("<h2>Failures</h2><ul>");
    for (const failure of failures) {
      parts.push(`<li>${escapeHtml(failure.repo)}: ${escapeHtml(failure.message)}</li>`);
    }
    parts.push("</ul>");
  }

  if (notes.length > 0) {
    parts.push("<h2>Notes</h2><ul>");
    for (const note of notes) parts.push(`<li>${escapeHtml(note)}</li>`);
    parts.push("</ul>");
  }

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
