import { describe, expect, it } from "vitest";
import type { CommitChanges } from "../src/github/github-client";
import { SyncEngine, type SyncGithubPort } from "../src/sync/engine";
import { EMPTY_DIRECTORY_MARKER } from "../src/sync/empty-directories";
import type { LocalScan, VaultStore } from "../src/sync/vault-store";
import type { RepositoryBinding, SnapshotManifest } from "../src/types";
import { gitBlobOid } from "../src/utils/hash";

class MemoryVault implements VaultStore {
  readonly blocked: string[] = [];
  onWrite?: (path: string, bytes: Uint8Array) => void;
  constructor(readonly files = new Map<string, Uint8Array>()) {}

  configDir(): string {
    return ".obsidian";
  }

  async scan(): Promise<LocalScan> {
    const manifest: SnapshotManifest = {};
    for (const [path, bytes] of this.files) manifest[path] = { path, oid: await gitBlobOid(bytes), size: bytes.length };
    return { manifest, blockedPaths: [...this.blocked] };
  }

  read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing ${path}`);
    return Promise.resolve(bytes);
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
    this.onWrite?.(path, bytes);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> { this.files.delete(path); return Promise.resolve(); }
  exists(path: string): Promise<boolean> { return Promise.resolve(this.files.has(path)); }
}

class MemoryGitHub implements SyncGithubPort {
  head = "head-1";
  failCommit = false;
  snapshotCalls = 0;
  constructor(readonly files = new Map<string, Uint8Array>(), readonly historical = new Map<string, Uint8Array>()) {}

  async getSnapshot(): Promise<{ headOid: string; manifest: SnapshotManifest }> {
    this.snapshotCalls += 1;
    const manifest: SnapshotManifest = {};
    for (const [path, bytes] of this.files) manifest[path] = { path, oid: await gitBlobOid(bytes), size: bytes.length };
    return { headOid: this.head, manifest };
  }

  getBranchHead(): Promise<string> { return Promise.resolve(this.head); }
  getBranchHeadForCommit(): Promise<string> { return Promise.resolve(this.head); }

  async getBlob(_repository: RepositoryBinding["repository"], oid: string): Promise<Uint8Array> {
    for (const bytes of [...this.files.values(), ...this.historical.values()]) if (await gitBlobOid(bytes) === oid) return bytes;
    throw new Error(`Missing blob ${oid}`);
  }

  createCommitOnBranch(_repository: RepositoryBinding["repository"], _branch: string, expected: string, _message: string, changes: CommitChanges): Promise<string> {
    if (this.failCommit) throw new Error("network down during commit");
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


describe("sync engine", () => {
  it("downloads an empty-directory marker when another device created the folder", async () => {
    const marker = `empty-folder/${EMPTY_DIRECTORY_MARKER}`;
    const vault = new MemoryVault();
    const github = new MemoryGitHub(new Map([[marker, new Uint8Array()]]));
    const engine = new SyncEngine(github, vault);
    const initialBinding: RepositoryBinding = {
      repository,
      vaultId: "vault",
      branch: "work-notes",
      boundAt: new Date().toISOString()
    };

    const plan = await engine.createPlan(initialBinding, {});
    expect(plan.summary.downloads).toBe(1);
    const execution = await engine.execute(
      initialBinding,

      plan,
      { planId: plan.id, confirmInitialMerge: true, confirmMassDeletion: false, confirmLargeFiles: false },
      "laptop"
    );

    expect(vault.files.has(marker)).toBe(true);
    expect(execution.manifest[marker]).toBeDefined();
  });

  it("reuses the cached snapshot while the head is unchanged and refetches when it moves", async () => {
    const vault = new MemoryVault(new Map([["a.md", new TextEncoder().encode("a")]]));
    const github = new MemoryGitHub(new Map([["a.md", new TextEncoder().encode("a")]]));
    const engine = new SyncEngine(github, vault);

    await engine.createPlan(binding, {});
    expect(github.snapshotCalls).toBe(1);

    // Steady state: the head is unchanged, so the cached tree is exact and the
    // expensive recursive snapshot is skipped.
    await engine.createPlan(binding, {});
    expect(github.snapshotCalls).toBe(1);

    // The remote moved: the cache must be bypassed and refreshed.
    github.files.set("b.md", new TextEncoder().encode("b"));
    github.head = "head-2";
    const plan = await engine.createPlan(binding, {});
    expect(github.snapshotCalls).toBe(2);
    expect(plan.summary.downloads).toBe(1);
  });

  it("uploads local additions and refreshes the base manifest", async () => {
    const vault = new MemoryVault(new Map([["local.md", new TextEncoder().encode("local")]]));
    const github = new MemoryGitHub();
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, {});
    const execution = await engine.execute(binding, plan, { planId: plan.id, confirmInitialMerge: true, confirmMassDeletion: false, confirmLargeFiles: false }, "laptop");
    expect(github.files.has("local.md")).toBe(true);
    expect(execution.manifest["local.md"]).toBeDefined();
    expect(execution.baseCommitOid).toContain("next");
  });

  it("leaves the vault untouched when the commit fails mid-run", async () => {
    const baseBytes = new TextEncoder().encode("one\ntwo\nthree");
    const localBytes = new TextEncoder().encode("one\nLOCAL\nthree");
    const remoteBytes = new TextEncoder().encode("one\nREMOTE\nthree");
    const baseOid = await gitBlobOid(baseBytes);
    const vault = new MemoryVault(new Map([["note.md", localBytes]]));
    const github = new MemoryGitHub(new Map([["note.md", remoteBytes]]), new Map([["base", baseBytes]]));
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, { "note.md": { path: "note.md", oid: baseOid, size: baseBytes.length } });

    github.failCommit = true;
    await expect(
      engine.execute(binding, plan, { planId: plan.id, confirmInitialMerge: false, confirmMassDeletion: false, confirmLargeFiles: false }, "laptop")
    ).rejects.toThrow(/network down/);

    // A conflict copy that nobody recorded is worse than no copy at all, so the
    // run must be fully replayable: local edits intact, no orphaned files.
    expect([...vault.files.keys()]).toEqual(["note.md"]);
    expect(new TextDecoder().decode(vault.files.get("note.md"))).toBe("one\nLOCAL\nthree");
  });

  it("synchronizes the rest of the vault when one path cannot be stored portably", async () => {
    const unportable = "Notes/Meeting: agenda.md";
    const vault = new MemoryVault(new Map([[unportable, new TextEncoder().encode("bad")], ["fine.md", new TextEncoder().encode("good")]]));
    vault.blocked.push(unportable);
    const github = new MemoryGitHub();
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, {});
    expect(plan.blockedFiles).toEqual([unportable]);

    const execution = await engine.execute(binding, plan, { planId: plan.id, confirmInitialMerge: true, confirmMassDeletion: false, confirmLargeFiles: false }, "laptop");

    expect(execution.result.kind).toBe("success");
    expect(github.files.has("fine.md")).toBe(true);
    expect(github.files.has(unportable)).toBe(false);
  });

  it("skips unportable and colliding paths that originate on the remote", async () => {
    const github = new MemoryGitHub(new Map([
      ["Notes/Meeting: agenda.md", new TextEncoder().encode("bad")],
      ["Notes/A.md", new TextEncoder().encode("upper")],
      ["notes/a.md", new TextEncoder().encode("lower")],
      ["fine.md", new TextEncoder().encode("good")]
    ]));
    const vault = new MemoryVault();
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, {});

    expect(plan.blockedFiles).toEqual(["Notes/A.md", "Notes/Meeting: agenda.md", "notes/a.md"]);
    expect(plan.operations).toEqual([expect.objectContaining({ kind: "download", path: "fine.md" })]);
  });

  it("does not apply downloads when a mixed run fails to push", async () => {
    const localBytes = new TextEncoder().encode("local");
    const remoteBytes = new TextEncoder().encode("remote");
    const vault = new MemoryVault(new Map([["local.md", localBytes]]));
    const github = new MemoryGitHub(new Map([["remote.md", remoteBytes]]));
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, {});
    github.failCommit = true;

    await expect(
      engine.execute(
        binding,
        plan,
        { planId: plan.id, confirmInitialMerge: false, confirmMassDeletion: false, confirmLargeFiles: false },
        "laptop"
      )
    ).rejects.toThrow(/network down/);

    expect(vault.files.get("local.md")).toEqual(localBytes);
    expect(vault.files.has("remote.md")).toBe(false);
  });

  it("does not advance the base when the remote moves while a download lands", async () => {
    const firstRemote = new TextEncoder().encode("first remote version");
    const secondRemote = new TextEncoder().encode("concurrent remote version");
    const vault = new MemoryVault();
    const github = new MemoryGitHub(new Map([["note.md", firstRemote]]));
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, {});
    vault.onWrite = () => {
      github.files.set("note.md", secondRemote);
      github.head = "head-2";
    };

    await expect(
      engine.execute(
        binding,
        plan,
        { planId: plan.id, confirmInitialMerge: false, confirmMassDeletion: false, confirmLargeFiles: false },
        "laptop"
      )
    ).rejects.toThrow(/remote branch changed/i);

    expect(vault.files.get("note.md")).toEqual(firstRemote);
    delete vault.onWrite;
    const followUp = await engine.createPlan(binding, {});
    expect(followUp.operations).toEqual([
      expect.objectContaining({ kind: "conflict", path: "note.md", reason: "initial-divergence" })
    ]);
  });

  it("records a local-delete conflict once and supports either explicit resolution", async () => {
    const baseBytes = new TextEncoder().encode("base");
    const remoteBytes = new TextEncoder().encode("remote edit");
    const baseOid = await gitBlobOid(baseBytes);
    const github = new MemoryGitHub(new Map([["note.md", remoteBytes]]), new Map([["base", baseBytes]]));
    const vault = new MemoryVault();
    const engine = new SyncEngine(github, vault);
    const base = { "note.md": { path: "note.md", oid: baseOid, size: baseBytes.length } };

    const firstPlan = await engine.createPlan(binding, base);
    const first = await engine.execute(
      binding,
      firstPlan,
      { planId: firstPlan.id, confirmInitialMerge: false, confirmMassDeletion: false, confirmLargeFiles: false },
      "laptop"
    );
    expect(first.conflicts).toHaveLength(1);

    const pending = new Set(["note.md"]);
    const repeatedPlan = await engine.createPlan({ ...binding, baseCommitOid: first.baseCommitOid }, first.manifest, pending);
    expect(repeatedPlan.operations).toEqual([]);
    const repeated = await engine.execute(
      binding,
      repeatedPlan,
      { planId: repeatedPlan.id, confirmInitialMerge: false, confirmMassDeletion: false, confirmLargeFiles: false },
      "laptop",
      pending
    );
    expect(repeated.result.kind).toBe("noop");
    expect(repeated.conflicts).toHaveLength(0);
    expect(github.files.has("note.md")).toBe(true);

    await engine.restoreRemoteFile(binding, "note.md");
    expect(vault.files.get("note.md")).toEqual(remoteBytes);
    vault.files.delete("note.md");
    const deleted = await engine.deleteRemoteFile(binding, "note.md", "laptop");
    expect(github.files.has("note.md")).toBe(false);
    expect(deleted.manifest["note.md"]).toBeUndefined();
  });

  it("preserves local content in a conflict copy when text edits overlap", async () => {
    const baseBytes = new TextEncoder().encode("one\ntwo\nthree");
    const localBytes = new TextEncoder().encode("one\nLOCAL\nthree");
    const remoteBytes = new TextEncoder().encode("one\nREMOTE\nthree");
    const baseOid = await gitBlobOid(baseBytes);
    const vault = new MemoryVault(new Map([["note.md", localBytes]]));
    const github = new MemoryGitHub(new Map([["note.md", remoteBytes]]), new Map([["base", baseBytes]]));
    const engine = new SyncEngine(github, vault);
    const plan = await engine.createPlan(binding, { "note.md": { path: "note.md", oid: baseOid, size: baseBytes.length } });
    expect(plan.summary.conflicts).toBe(0);
    expect(plan.summary.merges).toBe(1);
    const execution = await engine.execute(binding, plan, { planId: plan.id, confirmInitialMerge: false, confirmMassDeletion: false, confirmLargeFiles: false }, "laptop");
    expect(execution.conflicts).toHaveLength(1);
    expect([...vault.files.keys()].some((path) => path.startsWith("note.conflict-laptop-"))).toBe(true);
    expect(new TextDecoder().decode(vault.files.get("note.md"))).toBe("one\nREMOTE\nthree");
  });
});
