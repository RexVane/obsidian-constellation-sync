import type { CommitChanges, GitHubClient } from "../github/github-client";
import {
  type ConflictRecord,
  type RepositoryBinding,
  type SnapshotManifest,
  type SyncApproval,
  type SyncOperation,
  type SyncPlan,
  type SyncResult
} from "../types";
import { decodeUtf8, utf8 } from "../utils/encoding";
import { gitBlobOid } from "../utils/hash";
import { shouldSyncPath } from "../utils/path";
import { mergeText } from "./merge";
import { buildSyncPlan } from "./planner";
import type { VaultStore } from "./vault-store";

const MAX_TEXT_MERGE_BYTES = 2 * 1024 * 1024;
const GRAPHQL_BATCH_BYTES = 4 * 1024 * 1024;
const GRAPHQL_BATCH_FILES = 100;

type StagedLocalChange =
  | { kind: "write"; path: string; bytes: Uint8Array }
  | { kind: "remove"; path: string };

export interface SyncExecution {
  result: SyncResult;
  manifest: SnapshotManifest;
  baseCommitOid: string;
  conflicts: ConflictRecord[];
}

export interface SyncGithubPort {
  getSnapshot: GitHubClient["getSnapshot"];
  getBranchHead: GitHubClient["getBranchHead"];
  getBranchHeadForCommit: GitHubClient["getBranchHeadForCommit"];
  getBlob: GitHubClient["getBlob"];
  createCommitOnBranch: GitHubClient["createCommitOnBranch"];
  createCommitWithGitData: GitHubClient["createCommitWithGitData"];
}

export class SyncReviewRequiredError extends Error {
  constructor(
    message: string,
    readonly plan: SyncPlan
  ) {
    super(message);
    this.name = "SyncReviewRequiredError";
  }
}

export class SyncChangedDuringRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncChangedDuringRunError";
  }
}

export class SyncEngine {
  constructor(
    private readonly github: SyncGithubPort,
    private readonly vault: VaultStore
  ) {}

  // Steady-state polls only need to know WHETHER the remote moved: when the
  // branch head still matches the last fetched snapshot, that snapshot is
  // exact (git trees are content-addressed by head) and the full recursive
  // tree fetch — the most expensive call of every cycle — is skipped.
  private remoteSnapshotCache: {
    repositoryId: number;
    branch: string;
    snapshot: { headOid: string; manifest: SnapshotManifest };
  } | null = null;

  async createPlan(binding: RepositoryBinding, base: SnapshotManifest): Promise<SyncPlan> {
    const local = await this.vault.scan();
    const remote = await this.remoteSnapshot(binding);
    const configDir = this.vault.configDir();
    const configSelection = new Set(this.vault.syncedConfigPaths());
    const filteredBase = filterManifest(base, configDir, configSelection);
    const filteredRemote = filterManifest(remote.manifest, configDir, configSelection);
    return buildSyncPlan({
      ...(binding.baseCommitOid ? { baseCommitOid: binding.baseCommitOid } : {}),
      remoteHeadOid: remote.headOid,
      base: filteredBase,
      local: local.manifest,
      remote: filteredRemote,
      blockedPaths: local.blockedPaths
    });
  }

  async execute(
    binding: RepositoryBinding,
    plan: SyncPlan,
    approval: SyncApproval,
    deviceName: string
  ): Promise<SyncExecution> {
    if (approval.planId !== plan.id) throw new SyncReviewRequiredError("The sync preview changed.", plan);
    if (plan.initial && plan.operations.length > 0 && !approval.confirmInitialMerge) {
      throw new SyncReviewRequiredError("Initial merge confirmation is required.", plan);
    }
    if (plan.deletionGuardTriggered && !approval.confirmMassDeletion) {
      throw new SyncReviewRequiredError("Mass deletion confirmation is required.", plan);
    }
    if (plan.largeFileWarnings.length > 0 && !approval.confirmLargeFiles) {
      throw new SyncReviewRequiredError("Large file confirmation is required.", plan);
    }
    // The mutation validates expectedHeadOid against the strong read, so the
    // pre-push check must use the same consistency domain: a REST replica can
    // still report a head from before earlier pushes and get a fresh plan
    // rejected as stale even though nothing else touched the branch.
    const currentHead = await this.github.getBranchHeadForCommit(binding.repository, binding.branch);
    if (currentHead !== plan.remoteHeadOid) {
      // The plan was built against an older tree — replan rather than gating
      // the user through a review that has nothing to review.
      throw new SyncChangedDuringRunError("The remote branch changed after the plan was built.");
    }

    const changes: CommitChanges = { additions: [], deletions: [] };
    const conflicts: ConflictRecord[] = [];
    // Operations that both rewrite a local file and publish that rewrite are
    // staged here instead of touching the disk immediately. A failed push must
    // leave the vault exactly as the user left it, so the whole run stays
    // replayable rather than half-applied with its conflict records lost.
    const staged: StagedLocalChange[] = [];
    const reservedPaths = new Set<string>();
    for (const operation of plan.operations) {
      await this.assertLocalStable(operation);
      await this.applyOperation(binding, operation, changes, staged, reservedPaths, conflicts, deviceName);
    }

    const pushed = changes.additions.length > 0 || changes.deletions.length > 0;
    let commitOid = currentHead;
    if (pushed) {
      commitOid = await this.pushChanges(binding, currentHead, plan.id, deviceName, changes);
    } else if (await this.github.getBranchHeadForCommit(binding.repository, binding.branch) !== currentHead) {
      throw new SyncChangedDuringRunError("The remote branch changed while local files were being applied.");
    }

    // The remote is durable from here on, so the staged local half can land.
    for (const change of staged) {
      if (change.kind === "write") await this.vault.write(change.path, change.bytes);
      else await this.vault.remove(change.path);
    }

    const refreshed = await this.refreshedSnapshot(binding, commitOid, pushed);
    this.remoteSnapshotCache = { repositoryId: binding.repository.id, branch: binding.branch, snapshot: refreshed };
    return {
      result: {
        kind: plan.operations.length === 0 ? "noop" : "success",
        plan,
        ...(pushed ? { commitOid } : {})
      },
      manifest: filterManifest(refreshed.manifest, this.vault.configDir(), new Set(this.vault.syncedConfigPaths())),
      baseCommitOid: refreshed.headOid,
      conflicts
    };
  }

  // The push is durable once GraphQL accepts it, but getSnapshot is served
  // from a REST replica that can lag behind the write for a few seconds and
  // still report the pre-push head — which used to misfile the run as a
  // mid-sync change and fail every retry until the replica caught up. Wait
  // the replica out; only a genuinely different head fails the run.
  private async refreshedSnapshot(
    binding: RepositoryBinding,
    expectedHead: string,
    pushed: boolean
  ): Promise<{ headOid: string; manifest: SnapshotManifest }> {
    const delays = [0, 1_000, 2_000, 4_000, 6_000];
    let refreshed: { headOid: string; manifest: SnapshotManifest } | null = null;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      const delay = delays[attempt] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      refreshed = await this.github.getSnapshot(binding.repository, binding.branch);
      if (!pushed || refreshed.headOid === expectedHead) return refreshed;
    }
    throw new SyncChangedDuringRunError("The remote branch changed while the sync commit was being finalized.");
  }

  // The branch head is re-read through the GraphQL strong read: if it says the
  // head is unchanged, the cached snapshot is exact; if it moved, fall through
  // to the full fetch and refresh the cache.
  private async remoteSnapshot(binding: RepositoryBinding): Promise<{ headOid: string; manifest: SnapshotManifest }> {
    const cached = this.remoteSnapshotCache;
    if (
      cached &&
      cached.repositoryId === binding.repository.id &&
      cached.branch === binding.branch &&
      cached.snapshot.headOid === (await this.github.getBranchHeadForCommit(binding.repository, binding.branch))
    ) {
      return cached.snapshot;
    }
    const snapshot = await this.github.getSnapshot(binding.repository, binding.branch);
    this.remoteSnapshotCache = { repositoryId: binding.repository.id, branch: binding.branch, snapshot };
    return snapshot;
  }

  private async applyOperation(
    binding: RepositoryBinding,
    operation: SyncOperation,
    changes: CommitChanges,
    staged: StagedLocalChange[],
    reservedPaths: Set<string>,
    conflicts: ConflictRecord[],
    deviceName: string
  ): Promise<void> {
    if (operation.kind === "upload") {
      changes.additions.push({ path: operation.path, bytes: await this.vault.read(operation.path) });
      return;
    }
    // Download and delete-local publish nothing, so applying them now is safe:
    // a later failure just leaves work for the next run to redo.
    if (operation.kind === "download") {
      if (!operation.remoteOid) throw new Error(`Missing remote OID for ${operation.path}`);
      await this.vault.write(operation.path, await this.verifiedBlob(binding, operation.remoteOid));
      return;
    }
    if (operation.kind === "delete-local") {
      await this.vault.remove(operation.path);
      return;
    }
    if (operation.kind === "delete-remote") {
      changes.deletions.push(operation.path);
      return;
    }
    if (operation.kind === "merge") {
      await this.mergeOperation(binding, operation, changes, staged, reservedPaths, conflicts, deviceName);
      return;
    }
    await this.conflictOperation(binding, operation, changes, staged, reservedPaths, conflicts, deviceName);
  }

  private async assertLocalStable(operation: SyncOperation): Promise<void> {
    const exists = await this.vault.exists(operation.path);
    const currentOid = exists ? await gitBlobOid(await this.vault.read(operation.path)) : undefined;
    if (currentOid !== operation.localOid) {
      throw new SyncChangedDuringRunError(`Local file changed during the sync: ${operation.path}`);
    }
  }

  private async mergeOperation(
    binding: RepositoryBinding,
    operation: SyncOperation,
    changes: CommitChanges,
    staged: StagedLocalChange[],
    reservedPaths: Set<string>,
    conflicts: ConflictRecord[],
    deviceName: string
  ): Promise<void> {
    if (!operation.baseOid || !operation.remoteOid || operation.size > MAX_TEXT_MERGE_BYTES) {
      await this.preserveBoth(binding, operation, changes, staged, reservedPaths, conflicts, deviceName, "binary");
      return;
    }
    const [baseBytes, localBytes, remoteBytes] = await Promise.all([
      this.verifiedBlob(binding, operation.baseOid),
      this.vault.read(operation.path),
      this.verifiedBlob(binding, operation.remoteOid)
    ]);
    const base = decodeUtf8(baseBytes);
    const local = decodeUtf8(localBytes);
    const remote = decodeUtf8(remoteBytes);
    if (base === null || local === null || remote === null || base.includes("\0") || local.includes("\0") || remote.includes("\0")) {
      await this.preserveBoth(binding, operation, changes, staged, reservedPaths, conflicts, deviceName, "binary", localBytes, remoteBytes);
      return;
    }
    const merged = mergeText(base, local, remote);
    if (!merged.clean || merged.text === undefined) {
      await this.preserveBoth(binding, operation, changes, staged, reservedPaths, conflicts, deviceName, "overlapping-text", localBytes, remoteBytes);
      return;
    }
    const bytes = utf8(merged.text);
    staged.push({ kind: "write", path: operation.path, bytes });
    changes.additions.push({ path: operation.path, bytes });
  }

  private async conflictOperation(
    binding: RepositoryBinding,
    operation: Extract<SyncOperation, { kind: "conflict" }>,
    changes: CommitChanges,
    staged: StagedLocalChange[],
    reservedPaths: Set<string>,
    conflicts: ConflictRecord[],
    deviceName: string
  ): Promise<void> {
    if (operation.reason === "local-delete-remote-modify") {
      if (!operation.remoteOid) throw new Error(`Missing remote OID for ${operation.path}`);
      const remoteBytes = await this.verifiedBlob(binding, operation.remoteOid);
      staged.push({ kind: "write", path: operation.path, bytes: remoteBytes });
      conflicts.push(conflictRecord(operation.path, operation.reason));
      return;
    }
    if (operation.reason === "remote-delete-local-modify") {
      const localBytes = await this.vault.read(operation.path);
      const conflictPath = await this.uniqueConflictPath(operation.path, deviceName, reservedPaths);
      staged.push({ kind: "write", path: conflictPath, bytes: localBytes });
      staged.push({ kind: "remove", path: operation.path });
      changes.additions.push({ path: conflictPath, bytes: localBytes });
      conflicts.push(conflictRecord(operation.path, operation.reason, conflictPath));
      return;
    }
    await this.preserveBoth(binding, operation, changes, staged, reservedPaths, conflicts, deviceName, operation.reason);
  }

  private async preserveBoth(
    binding: RepositoryBinding,
    operation: SyncOperation,
    changes: CommitChanges,
    staged: StagedLocalChange[],
    reservedPaths: Set<string>,
    conflicts: ConflictRecord[],
    deviceName: string,
    reason: ConflictRecord["reason"],
    knownLocal?: Uint8Array,
    knownRemote?: Uint8Array
  ): Promise<void> {
    if (!operation.remoteOid) throw new Error(`Missing remote OID for ${operation.path}`);
    const [localBytes, remoteBytes] = await Promise.all([
      knownLocal ? Promise.resolve(knownLocal) : this.vault.read(operation.path),
      knownRemote ? Promise.resolve(knownRemote) : this.verifiedBlob(binding, operation.remoteOid)
    ]);
    const conflictPath = await this.uniqueConflictPath(operation.path, deviceName, reservedPaths);
    staged.push({ kind: "write", path: conflictPath, bytes: localBytes });
    staged.push({ kind: "write", path: operation.path, bytes: remoteBytes });
    changes.additions.push({ path: conflictPath, bytes: localBytes });
    conflicts.push(conflictRecord(operation.path, reason, conflictPath));
  }

  private async verifiedBlob(binding: RepositoryBinding, oid: string): Promise<Uint8Array> {
    const bytes = await this.github.getBlob(binding.repository, oid);
    if ((await gitBlobOid(bytes)) !== oid) throw new Error(`Git blob verification failed for ${oid}`);
    return bytes;
  }

  private async pushChanges(
    binding: RepositoryBinding,
    expectedHeadOid: string,
    runId: string,
    deviceName: string,
    changes: CommitChanges
  ): Promise<string> {
    const message = `[Constellation Sync] ${deviceName}\n\nConstellation-Sync-Run: ${runId}`;
    const useGitData = changes.additions.some((addition) => addition.bytes.byteLength >= GRAPHQL_BATCH_BYTES);
    if (useGitData) {
      return this.github.createCommitWithGitData(binding.repository, binding.branch, expectedHeadOid, message, changes);
    }

    const additions = [...changes.additions];
    const deletions = [...changes.deletions];
    let head = expectedHeadOid;
    while (additions.length > 0 || deletions.length > 0) {
      const batch: CommitChanges = { additions: [], deletions: [] };
      let batchBytes = 0;
      while (additions.length > 0 && batch.additions.length + batch.deletions.length < GRAPHQL_BATCH_FILES) {
        const next = additions[0];
        if (!next) break;
        if (batch.additions.length > 0 && batchBytes + next.bytes.byteLength > GRAPHQL_BATCH_BYTES) break;
        additions.shift();
        batch.additions.push(next);
        batchBytes += next.bytes.byteLength;
      }
      while (deletions.length > 0 && batch.additions.length + batch.deletions.length < GRAPHQL_BATCH_FILES) {
        const path = deletions.shift();
        if (path) batch.deletions.push(path);
      }
      head = await this.github.createCommitOnBranch(binding.repository, binding.branch, head, message, batch);
    }
    return head;
  }

  // Conflict copies are staged rather than written, so vault.exists cannot see
  // the ones this run already claimed. reserved keeps them distinct.
  private async uniqueConflictPath(path: string, deviceName: string, reserved: Set<string>): Promise<string> {
    const dot = path.lastIndexOf(".");
    const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
    const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const safeDevice = deviceName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 24) || "device";
    let candidate = `${stem}.conflict-${safeDevice}-${stamp}${extension}`;
    let suffix = 2;
    while (reserved.has(candidate) || (await this.vault.exists(candidate))) {
      candidate = `${stem}.conflict-${safeDevice}-${stamp}-${suffix}${extension}`;
      suffix += 1;
    }
    reserved.add(candidate);
    return candidate;
  }
}

function filterManifest(manifest: SnapshotManifest, configDir: string, configSelection: ReadonlySet<string>): SnapshotManifest {
  return Object.fromEntries(Object.entries(manifest).filter(([path]) => shouldSyncPath(path, configDir, configSelection)));
}

function conflictRecord(path: string, reason: ConflictRecord["reason"], conflictPath?: string): ConflictRecord {
  return {
    id: crypto.randomUUID(),
    path,
    ...(conflictPath ? { conflictPath } : {}),
    reason,
    createdAt: new Date().toISOString(),
    resolved: false
  };
}
