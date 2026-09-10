import { describe, expect, it } from "vitest";
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../src/utils/path";

describe("portable paths and sync scope", () => {
  it("keeps mandatory exclusions strongest", () => {
    expect(shouldSyncPath(".git/config", ".obsidian")).toBe(false);
    expect(shouldSyncPath(".github/workflows/release.yml", ".obsidian")).toBe(false);
    expect(shouldSyncPath("Notes/today.md", ".obsidian")).toBe(true);
  });

  it("always excludes the complete Obsidian configuration directory", () => {
    expect(shouldSyncPath(".obsidian/app.json", ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/appearance.json", ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/themes/mine.css", ".obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/dataview/data.json", ".obsidian")).toBe(false);
    expect(shouldSyncPath(".OBSIDIAN/plugins/dataview/main.js", ".obsidian")).toBe(false);
  });

  it("uses the vault's configured settings directory", () => {
    const configDir = ".settings";
    expect(shouldSyncPath(`${configDir}/app.json`, configDir)).toBe(false);
    expect(shouldSyncPath(`${configDir}/cache/data.json`, configDir)).toBe(false);
    expect(shouldSyncPath("Notes/a.md", configDir)).toBe(true);
  });

  it("detects Windows-invalid names and case collisions", () => {
    expect(validatePortablePath("Notes/con.md")).toContain("windows-reserved-name");
    expect(validatePortablePath("Notes\\meeting.md")).toContain("noncanonical-path");
    expect(validatePortablePath("Notes/cafe\u0301.md")).toContain("noncanonical-path");
    const collisions = findPortableCollisions(["Notes/A.md", "notes/a.md"]);
    expect(collisions.get("notes/a.md")).toEqual(["Notes/A.md", "notes/a.md"]);
  });
});
