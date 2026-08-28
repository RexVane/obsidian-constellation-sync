import { describe, expect, it } from "vitest";
import { branchFromEnglishName, slugifyEnglishName, validateBranchName } from "../src/utils/branch";

describe("vault branch names", () => {
  it("normalizes human names to stable lowercase kebab case", () => {
    expect(slugifyEnglishName("Work Notes 2026")).toBe("work-notes-2026");
    expect(slugifyEnglishName("ObsidianData")).toBe("obsidian-data");
    expect(slugifyEnglishName("Café / Research")).toBe("cafe-research");
  });

  it("rejects reserved and malformed branches", () => {
    expect(validateBranchName("main")).toBe("reserved");
    expect(validateBranchName("-bad")).toBe("format");
    expect(validateBranchName("work-notes")).toBeNull();
    expect(() => branchFromEnglishName("Main")).toThrow(/reserved/);
  });
});
