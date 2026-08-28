import { describe, expect, it } from "vitest";
import { gitBlobOid } from "../src/utils/hash";

describe("Git object hashing", () => {
  it("matches the canonical empty blob SHA-1", async () => {
    expect(await gitBlobOid(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});
