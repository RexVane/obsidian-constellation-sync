import { describe, expect, it } from "vitest";
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../src/utils/path";

describe("portable paths and sync scope", () => {
  it("keeps mandatory exclusions strongest", () => {
    expect(shouldSyncPath(".obsidian/plugins/constellation-sync/data.json", ".obsidian")).toBe(false);
    expect(shouldSyncPath("Notes/today.md", ".obsidian")).toBe(true);
  });

  it("never syncs config contents or core settings", () => {
    expect(shouldSyncPath(".obsidian/app.json", ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/themes/mine.css", ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/dataview/data.json", ".obsidian")).toBe(false);
  });

  it("uses the vault's configured settings directory", () => {
    const configDir = ".settings";
    expect(shouldSyncPath(`${configDir}/app.json`, configDir)).toBe(false);
    expect(shouldSyncPath(`${configDir}/cache/data.json`, configDir)).toBe(false);
    expect(shouldSyncPath("Notes/a.md", configDir)).toBe(true);
  });

  it("detects Windows-invalid namesand case collisions", () => {
    expect(validatePortablePath("Notes/con.md")).toContain("windows-reserved-name");
    const collisions = findPortableCollisions(["Notes/A.md", "notes/a.md"]);
    expect(collisions.get("notes/a.md")).toEqual(["Notes/A.md", "notes/a.md"]);
  });
});
