import type { CommitChanges, GitHubClient } from "../github/github-client";
import {
  type ConflictRecord,
  type RepositoryBinding,
  type SnapshotManifest,
  type SyncApproval,
  type SyncOperation,
  type SyncPlan,
  type SyncPolicy,
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

export interface SyncExecution {
  result: SyncResult;
  manifest: SnapshotManifest;
  baseCommitOid: string;
  conflicts: ConflictRecord[];
}

export interface SyncGithubPort {
  getSnapshot: GitHubClient["getSnapshot"];
  getBranchHead: GitHubClient["getBranchHead"];
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

export class SyncBlockedError extends Error {
  constructor(
    message: string,
    readonly paths: string[]
  ) {
    super(message);
    this.name = "SyncBlockedError";
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

  async createPlan(binding: RepositoryBinding, policy: SyncPolicy, base: SnapshotManifest): Promise<SyncPlan> {
    const [local, remote] = await Promise.all([
      this.vault.scan(policy),
      this.github.getSnapshot(binding.repository, binding.branch)
    ]);
    const configDir = this.vault.configDir();
    const filteredBase = filterManifest(base, policy, configDir);
    const filteredRemote = filterManifest(remote.manifest, policy, configDir);
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
    policy: SyncPolicy,
    plan: SyncPlan,
    approval: SyncApproval,
    deviceName: string
  ): Promise<SyncExecution> {
    if (approval.planId !== plan.id) throw new SyncReviewRequiredError("The sync preview changed.", plan);
    if (plan.blockedFiles.length > 0) throw new SyncBlockedError("Some files cannot be synchronized safely.", plan.blockedFiles);
    if (plan.initial && plan.operations.length > 0 && !approval.confirmInitialMerge) {
      throw new SyncReviewRequiredError("Initial merge confirmation is required.", plan);
    }
    if (plan.deletionGuardTriggered && !approval.confirmMassDeletion) {
      throw new SyncReviewRequiredError("Mass deletion confirmation is required.", plan);
    }
    if (plan.largeFileWarnings.length > 0 && !approval.confirmLargeFiles) {
      throw new SyncReviewRequiredError("Large file confirmation is required.", plan);
    }
    const currentHead = await this.github.getBranchHead(binding.repository, binding.branch);
    if (currentHead !== plan.remoteHeadOid) throw new SyncReviewRequiredError("Remote branch changed after preview.", plan);

    const changes: CommitChanges = { additions: [], deletions: [] };
    const conflicts: ConflictRecord[] = [];
    for (const operation of plan.operations) {
      await this.assertLocalStable(operation);
      await this.applyOperation(binding, operation, changes, conflicts, deviceName);
    }

    let commitOid = currentHead;
    if (changes.additions.length > 0 || changes.deletions.length > 0) {
      commitOid = await this.pushChanges(binding, currentHead, plan.id, deviceName, changes);
    } else if (await this.github.getBranchHead(binding.repository, binding.branch) !== currentHead) {
      throw new SyncChangedDuringRunError("The remote branch changed while local files were being applied.");
    }
    const refreshed = await this.github.getSnapshot(binding.repository, binding.branch);
    if (changes.additions.length > 0 || changes.deletions.length > 0) {
      if (refreshed.headOid !== commitOid) throw new SyncChangedDuringRunError("The remote branch changed while the sync commit was being finalized.");
    }
    return {
      result: {
        kind: plan.operations.length === 0 ? "noop" : "success",
        plan,
        commitOid
      },
      manifest: filterManifest(refreshed.manifest, policy, this.vault.configDir()),
      baseCommitOid: refreshed.headOid,
      conflicts
    };
  }

  private async applyOperation(
    binding: RepositoryBinding,
    operation: SyncOperation,
    changes: CommitChanges,
    conflicts: ConflictRecord[],
    deviceName: string
  ): Promise<void> {
    if (operation.kind === "upload") {
      changes.additions.push({ path: operation.path, bytes: await this.vault.read(operation.path) });
      return;
    }
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
      await this.mergeOperation(binding, operation, changes, conflicts, deviceName);
      return;
    }
    await this.conflictOperation(binding, operation, changes, conflicts, deviceName);
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
    conflicts: ConflictRecord[],
    deviceName: string
  ): Promise<void> {
    if (!operation.baseOid || !operation.remoteOid || operation.size > MAX_TEXT_MERGE_BYTES) {
      await this.preserveBoth(binding, operation, changes, conflicts, deviceName, "binary");
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
      await this.preserveBoth(binding, operation, changes, conflicts, deviceName, "binary", localBytes, remoteBytes);
      return;
    }
    const merged = mergeText(base, local, remote);
    if (!merged.clean || merged.text === undefined) {
      await this.preserveBoth(binding, operation, changes, conflicts, deviceName, "overlapping-text", localBytes, remoteBytes);
      return;
    }
    const bytes = utf8(merged.text);
    await this.vault.write(operation.path, bytes);
    changes.additions.push({ path: operation.path, bytes });
  }

  private async conflictOperation(
    binding: RepositoryBinding,
    operation: Extract<SyncOperation, { kind: "conflict" }>,
    changes: CommitChanges,
    conflicts: ConflictRecord[],
    deviceName: string
  ): Promise<void> {
    if (operation.reason === "local-delete-remote-modify") {
      if (!operation.remoteOid) throw new Error(`Missing remote OID for ${operation.path}`);
      await this.vault.write(operation.path, await this.verifiedBlob(binding, operation.remoteOid));
      conflicts.push(conflictRecord(operation.path, operation.reason));
      return;
    }
    if (operation.reason === "remote-delete-local-modify") {
      const localBytes = await this.vault.read(operation.path);
      const conflictPath = await this.uniqueConflictPath(operation.path, deviceName);
      await this.vault.write(conflictPath, localBytes);
      await this.vault.remove(operation.path);
      changes.additions.push({ path: conflictPath, bytes: localBytes });
      conflicts.push(conflictRecord(operation.path, operation.reason, conflictPath));
      return;
    }
    await this.preserveBoth(binding, operation, changes, conflicts, deviceName, operation.reason);
  }

  private async preserveBoth(
    binding: RepositoryBinding,
    operation: SyncOperation,
    changes: CommitChanges,
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
    const conflictPath = await this.uniqueConflictPath(operation.path, deviceName);
    await this.vault.write(conflictPath, localBytes);
    await this.vault.write(operation.path, remoteBytes);
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

  private async uniqueConflictPath(path: string, deviceName: string): Promise<string> {
    const dot = path.lastIndexOf(".");
    const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
    const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const safeDevice = deviceName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 24) || "device";
    let candidate = `${stem}.conflict-${safeDevice}-${stamp}${extension}`;
    let suffix = 2;
    while (await this.vault.exists(candidate)) {
      candidate = `${stem}.conflict-${safeDevice}-${stamp}-${suffix}${extension}`;
      suffix += 1;
    }
    return candidate;
  }
}

function filterManifest(manifest: SnapshotManifest, policy: SyncPolicy, configDir: string): SnapshotManifest {
  return Object.fromEntries(Object.entries(manifest).filter(([path]) => shouldSyncPath(path, policy, configDir)));
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
