import { describe, expect, it } from "vitest";
import { INITIAL_LOOKBACK_MS, matchesAnyLabel, windowStart } from "../src/match";
import { makeIssue } from "./fakes";

describe("matchesAnyLabel", () => {
  const issue = makeIssue(1, { labels: ["Status: Unconfirmed", "Bug"] });

  it("matches case-insensitively", () => {
    expect(matchesAnyLabel(issue, ["bug"])).toBe(true);
    expect(matchesAnyLabel(issue, ["STATUS: UNCONFIRMED"])).toBe(true);
  });

  it("matches any label in the list", () => {
    expect(matchesAnyLabel(issue, ["help wanted", "bug"])).toBe(true);
  });

  it("returns false when nothing matches or the list is empty", () => {
    expect(matchesAnyLabel(issue, ["help wanted"])).toBe(false);
    expect(matchesAnyLabel(issue, [])).toBe(false);
  });

  it("ignores surrounding whitespace", () => {
    expect(matchesAnyLabel(issue, ["  bug "])).toBe(true);
  });
});

describe("windowStart", () => {
  const now = new Date("2026-11-22T12:00:00Z");

  it("uses the cursor when present", () => {
    expect(windowStart("2026-11-22T05:00:00.000Z", now).toISOString()).toBe("2026-11-22T05:00:00.000Z");
  });

  it("falls back to the initial lookback without a cursor", () => {
    expect(now.getTime() - windowStart(null, now).getTime()).toBe(INITIAL_LOOKBACK_MS);
  });

  it("falls back when the cursor is unparseable", () => {
    expect(now.getTime() - windowStart("garbage", now).getTime()).toBe(INITIAL_LOOKBACK_MS);
  });
});
