import { describe, expect, it } from "vitest";
import { buildSyncPlan } from "../src/sync/planner";
import type { SnapshotManifest } from "../src/types";

const entry = (path: string, oid: string, size = 1) => ({ path, oid, size });

describe("sync planner", () => {
  it("creates an initial union plan without treating one side as authoritative", async () => {
    const plan = await buildSyncPlan({
      remoteHeadOid: "remote-head",
      base: {},
      local: { "local.md": entry("local.md", "l") },
      remote: { "remote.md": entry("remote.md", "r") }
    });
    expect(plan.initial).toBe(true);
    expect(plan.summary.uploads).toBe(1);
    expect(plan.summary.downloads).toBe(1);
    expect(plan.summary.conflicts).toBe(0);
  });

  it("marks a first-join divergent path as a conflict", async () => {
    const plan = await buildSyncPlan({
      remoteHeadOid: "remote-head",
      base: {},
      local: { "same.md": entry("same.md", "local") },
      remote: { "same.md": entry("same.md", "remote") }
    });
    expect(plan.summary.conflicts).toBe(1);
    expect(plan.operations[0]).toMatchObject({ kind: "conflict", reason: "initial-divergence" });
  });

  it("guards mass deletion using both absolute and percentage thresholds", async () => {
    const base: SnapshotManifest = {};
    for (let index = 0; index < 80; index += 1) base[`note-${index}.md`] = entry(`note-${index}.md`, `oid-${index}`);
    const plan = await buildSyncPlan({ remoteHeadOid: "head", baseCommitOid: "base", base, local: {}, remote: base });
    expect(plan.deletionGuardTriggered).toBe(true);
    expect(plan.summary.remoteDeletes).toBe(80);
  });

  it("blocks regular Git files at 100 MiB and warns at 50 MiB", async () => {
    const plan = await buildSyncPlan({
      remoteHeadOid: "head",
      base: {},
      local: {
        "large.bin": entry("large.bin", "large", 100 * 1024 * 1024),
        "warning.bin": entry("warning.bin", "warning", 50 * 1024 * 1024)
      },
      remote: {}
    });
    expect(plan.blockedFiles).toEqual(["large.bin"]);
    expect(plan.largeFileWarnings).toEqual(["warning.bin"]);
  });
});
