import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseConfig, resolveWatchers } from "../src/config.ts";
import type { Config } from "../src/config.ts";

const parseWatchersYaml = (text: string): Config => parseConfig(parse(text));

const base = `
defaults:
  notify:
    to: dest@example.com
    from: issues@example.com
watchers:
  - repo: owner/repo
`;

describe("config", () => {
  it("applies AI defaults", () => {
    const config = parseWatchersYaml(base);
    expect(config.defaults.ai).toEqual({
      enabled: true,
      model: "deepseek-v4.1-flash",
    });
    expect(config.watchers[0]?.labels).toEqual([]);
  });

  it("merges per-watcher overrides over defaults", () => {
    const config = parseWatchersYaml(`
defaults:
  ai:
    enabled: false
    model: default-model
  interest: default interest
  notify:
    to: dest@example.com
    from: issues@example.com
watchers:
  - repo: owner/repo
    labels: ["Bug", "good first issue"]
    ai: true
    model: watcher-model
`);
    const [watcher] = resolveWatchers(config);
    expect(watcher).toEqual({
      repo: "owner/repo",
      labels: ["Bug", "good first issue"],
      ai: true,
      model: "watcher-model",
      interest: "default interest",
    });
  });

  it("rejects a repo without an owner", () => {
    expect(() =>
      parseConfig({
        ...JSON.parse(JSON.stringify({ defaults: { notify: { to: "a@b.co", from: "c@d.co" } }, watchers: [] })),
        watchers: [{ repo: "just-a-name" }],
      }),
    ).toThrow(/owner\/name/);
  });

  it("rejects duplicate repos regardless of case", () => {
    expect(() =>
      parseConfig({
        defaults: { notify: { to: "a@b.co", from: "c@d.co" } },
        watchers: [{ repo: "Owner/Repo" }, { repo: "owner/repo" }],
      }),
    ).toThrow(/duplicate watcher/);
  });

  it("requires a recipient and sender", () => {
    expect(() => parseConfig({ defaults: {}, watchers: [{ repo: "owner/repo" }] })).toThrow();
  });

  it("rejects unknown keys so typos fail loudly", () => {
    expect(() =>
      parseConfig({
        defaults: { notify: { to: "a@b.co", from: "c@d.co" } },
        watchers: [{ repo: "owner/repo", labls: ["bug"] }],
      }),
    ).toThrow();
  });
});
