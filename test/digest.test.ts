import { describe, expect, it } from "vitest";
import { renderDigest, type DigestEntry } from "../src/digest.ts";
import { makeIssue } from "./fakes.ts";

const now = new Date("2026-11-22T05:00:00Z");

function entry(overrides: Partial<DigestEntry> = {}): DigestEntry {
  return {
    repo: "owner/repo",
    issue: makeIssue(12, { title: "Crash on startup" }),
    source: "label",
    label: "bug",
    reason: null,
    ...overrides,
  };
}

describe("renderDigest", () => {
  it("pluralizes the subject and counts repos", () => {
    expect(renderDigest([entry()], now).subject).toBe("gh-issue-watcher: 1 issue in 1 repo");

    const many = [entry(), entry({ issue: makeIssue(13) }), entry({ repo: "other/repo" })];
    expect(renderDigest(many, now).subject).toBe("gh-issue-watcher: 3 issues in 2 repos");
  });



  it("lists issues with their source and link", () => {
    const digest = renderDigest(
      [entry(), entry({ source: "ai", label: null, reason: "matches the interest" })],
      now,
    );

    expect(digest.text).toContain("owner/repo (2)");
    expect(digest.text).toContain("#12 Crash on startup [label: bug]");
    expect(digest.text).toContain("https://github.com/owner/repo/issues/12");
    expect(digest.text).toContain("why: matches the interest");
  });

  it("escapes HTML in titles and reasons", () => {
    const digest = renderDigest(
      [entry({ issue: makeIssue(1, { title: "<script>alert(1)</script>" }), reason: "<b>yes</b>" })],
      now,
    );

    expect(digest.html).not.toContain("<script>");
    expect(digest.html).toContain("&lt;script&gt;");
    expect(digest.html).toContain("&lt;b&gt;yes&lt;/b&gt;");
  });
});
