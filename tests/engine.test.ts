import { describe, expect, it } from "vitest";
import type { CommitChanges } from "../src/github/github-client";
import { SyncEngine, type SyncGithubPort } from "../src/sync/engine";
import type { LocalScan, VaultStore } from "../src/sync/vault-store";
import type { RepositoryBinding, SnapshotManifest, SyncPolicy } from "../src/types";
import { DEFAULT_POLICY } from "../src/settings";
import { gitBlobOid } from "../src/utils/hash";

class MemoryVault implements VaultStore {
  constructor(readonly files = new Map<string, Uint8Array>()) {}

  configDir(): string {
    return ".obsidian";
  }

  async scan(): Promise<LocalScan> {
    const manifest: SnapshotManifest = {};
    for (const [path, bytes] of this.files) manifest[path] = { path, oid: await gitBlobOid(bytes), size: bytes.length };
    return { manifest, blockedPaths: [] };
  }

  read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing ${path}`);
    return Promise.resolve(bytes);
  }

  write(path: string, bytes: Uint8Array): Promise<void> { this.files.set(path, bytes); return Promise.resolve(); }
  remove(path: string): Promise<void> { this.files.delete(path); return Promise.resolve(); }
  exists(path: string): Promise<boolean> { return Promise.resolve(this.files.has(path)); }
}

class MemoryGitHub implements SyncGithubPort {
  head = "head-1";
  constructor(readonly files = new Map<string, Uint8Array>(), readonly historical = new Map<string, Uint8Array>()) {}

  async getSnapshot(): Promise<{ headOid: string; manifest: SnapshotManifest }> {
    const manifest: SnapshotManifest = {};
    for (const [path, bytes] of this.files) manifest[path] = { path, oid: await gitBlobOid(bytes), size: bytes.length };
    return { headOid: this.head, manifest };
  }

  getBranchHead(): Promise<string> { return Promise.resolve(this.head); }

  async getBlob(_repository: RepositoryBinding["repository"], oid: string): Promise<Uint8Array> {
    for (const bytes of [...this.files.values(), ...this.historical.values()]) if (await gitBlobOid(bytes) === oid) return bytes;
    throw new Error(`Missing blob ${oid}`);
  }

  createCommitOnBranch(_repository: RepositoryBinding["repository"], _branch: string, expected: string, _message: string, changes: CommitChanges): Promise<string> {
    if (expected !== this.head) throw new Error("head mismatch");
    for (const addition of changes.additions) this.files.set(addition.path, addition.bytes);
    for (const path of changes.deletions) this.files.delete(path);
    this.head = `${this.head}-next`;
    return Promise.resolve(this.head);
  }

  async createCommitWithGitData(repository: RepositoryBinding["repository"], branch: string, expected: string, message: string, changes: CommitChanges): Promise<string> {
    return this.createCommitOnBranch(repository, branch, expected, message, changes);
  }
}

const repository: RepositoryBinding["repository"] = { id: 1, nodeId: "node", owner: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" };
const binding: RepositoryBinding = { repository, vaultId: "vault", branch: "work-notes", baseCommitOid: "base", boundAt: new Date().toISOString() };
const policy: SyncPolicy = structuredClone(DEFAULT_POLICY);

describe("sync engine", () => {
  it("uploads local additions and refreshes the base manifest", async () => {
    const vault = new MemoryVault(new Map([["local.md", new TextEncoder().encode("local")]]));
    const github = new MemoryGitHub();
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, policy, {});
    const execution = await engine.execute(binding, policy, plan, { planId: plan.id, confirmInitialMerge: true, confirmMassDeletion: false, confirmLargeFiles: false }, "laptop");
    expect(github.files.has("local.md")).toBe(true);
    expect(execution.manifest["local.md"]).toBeDefined();
    expect(execution.baseCommitOid).toContain("next");
  });

  it("preserves local content in a conflict copy when text edits overlap", async () => {
    const baseBytes = new TextEncoder().encode("one\ntwo\nthree");
    const localBytes = new TextEncoder().encode("one\nLOCAL\nthree");
    const remoteBytes = new TextEncoder().encode("one\nREMOTE\nthree");
    const baseOid = await gitBlobOid(baseBytes);
    const vault = new MemoryVault(new Map([["note.md", localBytes]]));
    const github = new MemoryGitHub(new Map([["note.md", remoteBytes]]), new Map([["base", baseBytes]]));
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, policy, { "note.md": { path: "note.md", oid: baseOid, size: baseBytes.length } });
    expect(plan.summary.conflicts).toBe(0);
    expect(plan.summary.merges).toBe(1);
    const execution = await engine.execute(binding, policy, plan, { planId: plan.id, confirmInitialMerge: false, confirmMassDeletion: false, confirmLargeFiles: false }, "laptop");
    expect(execution.conflicts).toHaveLength(1);
    expect([...vault.files.keys()].some((path) => path.startsWith("note.conflict-laptop-"))).toBe(true);
    expect(new TextDecoder().decode(vault.files.get("note.md"))).toBe("one\nREMOTE\nthree");
  });
});
