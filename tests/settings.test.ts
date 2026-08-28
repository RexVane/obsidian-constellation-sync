import { describe, expect, it } from "vitest";
import { loadSettings, normalizePollInterval } from "../src/settings";

describe("poll interval settings", () => {
  it("migrates the pre-0.2.3 default of 60 s to the new 15 s default", () => {
    expect(normalizePollInterval(60_000)).toBe(15_000);
    expect(loadSettings({ remotePollMs: 60_000 }).remotePollMs).toBe(15_000);
  });

  it("keeps an interval the user deliberately picked", () => {
    expect(normalizePollInterval(30_000)).toBe(30_000);
    expect(loadSettings({ remotePollMs: 300_000 }).remotePollMs).toBe(300_000);
  });

  it("falls back to the default for unknown or missing values", () => {
    expect(normalizePollInterval(undefined)).toBe(15_000);
    expect(normalizePollInterval(12_345)).toBe(15_000);
    expect(loadSettings({}).remotePollMs).toBe(15_000);
  });
});
