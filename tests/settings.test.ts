import { describe, expect, it } from "vitest";
import { createDefaultSettings, loadSettings, normalizeLocalDebounce, normalizePollInterval } from "../src/settings";

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

describe("local debounce settings", () => {
  it("uses 5 seconds for new installs and migrates the former 30 second default", () => {
    expect(createDefaultSettings().localDebounceMs).toBe(5_000);
    expect(normalizeLocalDebounce(30_000)).toBe(5_000);
    expect(loadSettings({ localDebounceMs: 30_000 }).localDebounceMs).toBe(5_000);
  });
});

describe("settings validation", () => {
  it("drops legacy config-sync state and rejects malformed persisted values", () => {
    const settings = loadSettings({
      locale: "invalid",
      autoSync: "yes",
      deviceName: "",
      baseManifest: { "bad.md": { path: "other.md", oid: 42, size: -1 } },
      conflicts: [{ path: "missing-fields" }],
      syncedConfigPaths: ["appearance.json"]
    });

    expect(settings.locale).toBe("auto");
    expect(settings.autoSync).toBe(true);
    expect(settings.baseManifest).toEqual({});
    expect(settings.conflicts).toEqual([]);
    expect(settings).not.toHaveProperty("syncedConfigPaths");
  });

  it("preserves and sanitizes a complete valid persisted state", () => {
    const now = "2026-09-10T00:00:00.000Z";
    const summary = {
      uploads: 1,
      downloads: 2,
      localDeletes: 0,
      remoteDeletes: 0,
      merges: 0,
      conflicts: 1,
      warnings: 0
    };
    const settings = loadSettings({
      locale: "zh-CN",
      autoSync: false,
      paused: true,
      localDebounceMs: 15_000,
      remotePollMs: 300_000,
      deviceId: "device-id",
      deviceName: "  laptop  ",
      account: { login: "octocat", avatarUrl: "https://example.com/avatar.png", ignored: true },
      binding: {
        repository: {
          id: 1,
          nodeId: "node",
          owner: "owner",
          name: "notes",
          fullName: "owner/notes",
          private: true,
          defaultBranch: "main"
        },
        vaultId: "vault-id",
        branch: "work-notes",
        baseCommitOid: "base-oid",
        boundAt: now
      },
      baseManifest: { "note.md": { path: "note.md", oid: "blob-oid", size: 10 } },
      pendingReview: {
        plan: {
          id: "plan-id",
          createdAt: now,
          baseCommitOid: "base-oid",
          remoteHeadOid: "remote-head",
          initial: false,
          operations: [{
            kind: "conflict",
            path: "note.md",
            baseOid: "base-oid",
            remoteOid: "remote-oid",
            size: 10,
            reason: "local-delete-remote-modify"
          }],
          summary,
          deletionGuardTriggered: false,
          largeFileWarnings: [],
          blockedFiles: []
        }
      },
      conflicts: [{
        id: "conflict-id",
        path: "note.md",
        reason: "local-delete-remote-modify",
        createdAt: now,
        resolved: true,
        resolution: "restore-remote"
      }],
      activity: [{
        id: "activity-id",
        time: now,
        kind: "sync",
        message: "Synchronized",
        commitOid: "commit-oid",
        counts: summary
      }],
      skippedFiles: ["z.md", "z.md", "a.md"],
      lastSuccessAt: now,
      storageUsage: { sizeKb: 42, checkedAt: now },
      unknownField: "discard me"
    });

    expect(settings).toMatchObject({
      locale: "zh-CN",
      autoSync: false,
      paused: true,
      localDebounceMs: 15_000,
      remotePollMs: 300_000,
      deviceId: "device-id",
      deviceName: "laptop",
      account: { login: "octocat", avatarUrl: "https://example.com/avatar.png" },
      binding: { vaultId: "vault-id", branch: "work-notes", baseCommitOid: "base-oid" },
      baseManifest: { "note.md": { path: "note.md", oid: "blob-oid", size: 10 } },
      skippedFiles: ["a.md", "z.md"],
      lastSuccessAt: now,
      storageUsage: { sizeKb: 42, checkedAt: now }
    });
    expect(settings.pendingReview?.plan.operations[0]).toMatchObject({
      kind: "conflict",
      reason: "local-delete-remote-modify"
    });
    expect(settings.conflicts[0]?.resolution).toBe("restore-remote");
    expect(settings.activity[0]?.counts).toEqual(summary);
    expect(settings).not.toHaveProperty("unknownField");
  });
});
