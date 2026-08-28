import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/settings";
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../src/utils/path";

describe("portable paths and policy", () => {
  it("keeps mandatory exclusions stronger than user rules", () => {
    const policy = { ...DEFAULT_POLICY, ignorePatterns: ["!**/.obsidian/plugins/constellation-sync/**"] };
    expect(shouldSyncPath(".obsidian/plugins/constellation-sync/data.json", policy, ".obsidian")).toBe(false);
    expect(shouldSyncPath("Notes/today.md", policy, ".obsidian")).toBe(true);
  });

  it("requires opt-in for selected Obsidian settings", () => {
    expect(shouldSyncPath(".obsidian/app.json", DEFAULT_POLICY, ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/app.json", { ...DEFAULT_POLICY, obsidian: { ...DEFAULT_POLICY.obsidian, coreSettings: true } }, ".obsidian")).toBe(true);
  });

  it("uses the vault's configured settings directory", () => {
    const configDir = ".settings";
    expect(shouldSyncPath(`${configDir}/app.json`, DEFAULT_POLICY, configDir)).toBe(false);
    expect(shouldSyncPath(`${configDir}/app.json`, { ...DEFAULT_POLICY, obsidian: { ...DEFAULT_POLICY.obsidian, coreSettings: true } }, configDir)).toBe(true);
    expect(shouldSyncPath(`${configDir}/cache/data.json`, { ...DEFAULT_POLICY, obsidian: { ...DEFAULT_POLICY.obsidian, coreSettings: true } }, configDir)).toBe(false);
  });

  it("detects Windows-invalid names and case collisions", () => {
    expect(validatePortablePath("Notes/con.md")).toContain("windows-reserved-name");
    const collisions = findPortableCollisions(["Notes/A.md", "notes/a.md"]);
    expect(collisions.get("notes/a.md")).toEqual(["Notes/A.md", "notes/a.md"]);
  });
});
