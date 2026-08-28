import { describe, expect, it } from "vitest";
import { mergeText } from "../src/sync/merge";

describe("three-way text merge", () => {
  it("merges independent changes", () => {
    const result = mergeText("one\ntwo\nthree", "ONE\ntwo\nthree", "one\ntwo\nTHREE");
    expect(result.clean).toBe(true);
    expect(result.text).toBe("ONE\ntwo\nTHREE");
  });

  it("accepts an unchanged side", () => {
    expect(mergeText("base", "base", "remote")).toEqual({ clean: true, text: "remote" });
  });

  it("preserves overlapping edits as conflicts", () => {
    const result = mergeText("one\ntwo\nthree", "one\nLOCAL\nthree", "one\nREMOTE\nthree");
    expect(result.clean).toBe(false);
    expect(result.reason).toBe("overlap");
  });
});
