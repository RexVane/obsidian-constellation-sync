import { describe, expect, it } from "vitest";
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../src/utils/path";

const NOTHING = new Set<string>();
const SELECTED = new Set(["appearance.json", "themes/", "snippets/", "plugins/dataview/data.json"]);

describe("portable paths and sync scope", () => {
  it("keeps mandatory exclusions strongest", () => {
    expect(shouldSyncPath(".obsidian/plugins/constellation-sync/data.json", ".obsidian", SELECTED)).toBe(false);
    expect(shouldSyncPath("Notes/today.md", ".obsidian", NOTHING)).toBe(true);
  });

  it("excludes config contents unless they are explicitly selected", () => {
    expect(shouldSyncPath(".obsidian/app.json", ".obsidian", SELECTED)).toBe(false);
    expect(shouldSyncPath(".obsidian/appearance.json", ".obsidian", SELECTED)).toBe(true);
    expect(shouldSyncPath(".obsidian/appearance.json", ".obsidian", NOTHING)).toBe(false);
    expect(shouldSyncPath(".obsidian/themes/mine.css", ".obsidian", SELECTED)).toBe(true);
    expect(shouldSyncPath(".obsidian/snippets/deep/nested.css", ".obsidian", SELECTED)).toBe(true);
    expect(shouldSyncPath(".obsidian/plugins/dataview/data.json", ".obsidian", SELECTED)).toBe(true);
    expect(shouldSyncPath(".obsidian/plugins/dataview/main.js", ".obsidian", SELECTED)).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/other/data.json", ".obsidian", SELECTED)).toBe(false);
  });

  it("uses the vault's configured settings directory", () => {
    const configDir = ".settings";
    const selection = new Set(["app.json"]);
    expect(shouldSyncPath(`${configDir}/app.json`, configDir, selection)).toBe(true);
    expect(shouldSyncPath(`${configDir}/cache/data.json`, configDir, selection)).toBe(false);
    expect(shouldSyncPath("Notes/a.md", configDir, NOTHING)).toBe(true);
  });

  it("detects Windows-invalid namesand case collisions", () => {
    expect(validatePortablePath("Notes/con.md")).toContain("windows-reserved-name");
    const collisions = findPortableCollisions(["Notes/A.md", "notes/a.md"]);
    expect(collisions.get("notes/a.md")).toEqual(["Notes/A.md", "notes/a.md"]);
  });
});
