import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/settings";
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../src/utils/path";
import type { SyncPolicy } from "../src/types";

function policyWithPlugins(pluginIds: string[]): SyncPolicy {
  return { ...structuredClone(DEFAULT_POLICY), obsidian: { communityPluginData: pluginIds } };
}

describe("portable paths and policy", () => {
  it("keeps mandatory exclusions stronger than user rules", () => {
    const policy = { ...structuredClone(DEFAULT_POLICY), ignorePatterns: ["!**/.obsidian/plugins/constellation-sync/**"] };
    expect(shouldSyncPath(".obsidian/plugins/constellation-sync/data.json", policy, ".obsidian")).toBe(false);
    expect(shouldSyncPath("Notes/today.md", policy, ".obsidian")).toBe(true);
  });

  it("never syncs core settings or themes; community plugin data requires opt-in", () => {
    expect(shouldSyncPath(".obsidian/app.json", DEFAULT_POLICY, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/themes/mine.css", DEFAULT_POLICY, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/snippets/highlight.css", DEFAULT_POLICY, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/dataview/data.json", DEFAULT_POLICY, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/dataview/data.json", policyWithPlugins(["dataview"]), ".obsidian")).toBe(true);
  });

  it("uses the vault's configured settings directory", () => {
    const configDir = ".settings";
    expect(shouldSyncPath(`${configDir}/app.json`, DEFAULT_POLICY, configDir)).toBe(false);
    expect(shouldSyncPath(`${configDir}/plugins/dataview/data.json`, policyWithPlugins(["dataview"]), configDir)).toBe(true);
    expect(shouldSyncPath(`${configDir}/cache/data.json`, policyWithPlugins(["dataview"]), configDir)).toBe(false);
  });

  it("detects Windows-invalid names and case collisions", () => {
    expect(validatePortablePath("Notes/con.md")).toContain("windows-reserved-name");
    const collisions = findPortableCollisions(["Notes/A.md", "notes/a.md"]);
    expect(collisions.get("notes/a.md")).toEqual(["Notes/A.md", "notes/a.md"]);
  });
});
