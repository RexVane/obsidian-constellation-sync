import { describe, expect, it } from "vitest";
import { shouldAdoptRemotePolicy } from "../src/settings";

describe("shared policy staleness", () => {
  it("accepts a revision at or above the one already adopted", () => {
    expect(shouldAdoptRemotePolicy(2, 2)).toBe(true);
    expect(shouldAdoptRemotePolicy(3, 2)).toBe(true);
  });

  it("refuses a lower revision, which can only be a lagging replica", () => {
    // The failure this guards: a device writes revision 3, the next sync reads a
    // replica still serving revision 2, and the setting silently rolls back.
    expect(shouldAdoptRemotePolicy(2, 3)).toBe(false);
  });

  it("adopts whatever the remote reports when nothing has been adopted yet", () => {
    expect(shouldAdoptRemotePolicy(0, undefined)).toBe(true);
    expect(shouldAdoptRemotePolicy(7, undefined)).toBe(true);
  });
});
