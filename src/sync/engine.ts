import { GitHubApiError, isStaleHeadError, type CommitChanges, type GitHubClient } from "../github/github-client";
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
import { findPortableCollisions, shouldSyncPath, validatePortablePath } from "../utils/path";
import { mergeText } from "./merge";
import { buildSyncPlan } from "./planner";
import type { VaultStore } from "./vault-store";

const MAX_TEXT_MERGE_BYTES = 2 * 1024 * 1024;
const GRAPHQL_MAX_BYTES = 4 * 1024 * 1024;
const GRAPHQL_MAX_FILES = 100;

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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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

  async createPlan(
    binding: RepositoryBinding,
    base: SnapshotManifest,
    pendingDeleteConflicts?: ReadonlySet<string>
  ): Promise<SyncPlan> {
    const local = await this.vault.scan();
    const remote = await this.remoteSnapshot(binding);
    const configDir = this.vault.configDir();
    const preparedBase = prepareManifest(base, configDir);
    const preparedRemote = prepareManifest(remote.manifest, configDir);
    const allPaths = [
      ...Object.keys(preparedBase.manifest),
      ...Object.keys(local.manifest),
      ...Object.keys(preparedRemote.manifest)
    ];
    const blockedPaths = new Set([
      ...local.blockedPaths,
      ...preparedBase.blockedPaths,
      ...preparedRemote.blockedPaths
    ]);
    for (const paths of findPortableCollisions(allPaths).values()) {
      for (const path of paths) blockedPaths.add(path);
    }
    const filteredBase = omitPaths(preparedBase.manifest, blockedPaths);
    const filteredRemote = omitPaths(preparedRemote.manifest, blockedPaths);
    return buildSyncPlan({
      ...(binding.baseCommitOid ? { baseCommitOid: binding.baseCommitOid } : {}),
      remoteHeadOid: remote.headOid,
      base: filteredBase,
      local: local.manifest,
      remote: filteredRemote,
      blockedPaths: [...blockedPaths],
      ...(pendingDeleteConflicts ? { pendingDeleteConflicts } : {})
    });
  }

  async execute(
    binding: RepositoryBinding,
    plan: SyncPlan,
    approval: SyncApproval,
    deviceName: string,
    existingDeleteConflicts?: ReadonlySet<string>
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
      await this.applyOperation(binding, operation, changes, staged, reservedPaths, conflicts, deviceName, existingDeleteConflicts);
    }

    const pushed = changes.additions.length > 0 || changes.deletions.length > 0;
    let commitOid = currentHead;
    if (pushed) {
      commitOid = await this.pushChanges(binding, currentHead, plan.id, deviceName, changes);
    } else if (await this.github.getBranchHeadForCommit(binding.repository, binding.branch) !== currentHead) {
      throw new SyncChangedDuringRunError("The remote branch changed before local files were applied.");
    }

    // The remote is durable from here on, so the staged local half can land.
    for (const change of staged) {
      if (change.kind === "write") await this.vault.write(change.path, change.bytes);
      else await this.vault.remove(change.path);
    }

    // A pull has no conditional remote mutation to close the race window. Check
    // once more after landing local changes so a concurrent remote edit cannot
    // be recorded as the base of bytes downloaded from the previous head.
    if (!pushed && await this.github.getBranchHeadForCommit(binding.repository, binding.branch) !== currentHead) {
      throw new SyncChangedDuringRunError("The remote branch changed while local files were being applied.");
    }

    const refreshed = await this.refreshedSnapshot(binding, commitOid);
    this.remoteSnapshotCache = { repositoryId: binding.repository.id, branch: binding.branch, snapshot: refreshed };
    const changed = pushed || staged.length > 0 || conflicts.length > 0;
    return {
      result: {
        kind: changed ? "success" : "noop",
        plan,
        ...(pushed ? { commitOid } : {})
      },
      manifest: omitPaths(prepareManifest(refreshed.manifest, this.vault.configDir()).manifest, new Set(plan.blockedFiles)),
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
    expectedHead: string
  ): Promise<{ headOid: string; manifest: SnapshotManifest }> {
    const delays = [0, 1_000, 2_000, 4_000, 6_000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      const delay = delays[attempt] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const refreshed = await this.github.getSnapshot(binding.repository, binding.branch);
      if (refreshed.headOid === expectedHead) return refreshed;
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
    deviceName: string,
    existingDeleteConflicts?: ReadonlySet<string>
  ): Promise<void> {
    if (operation.kind === "upload") {
      changes.additions.push({ path: operation.path, bytes: await this.vault.read(operation.path) });
      return;
    }
    // Pull-only operations are staged too. This keeps a later network or push
    // failure from leaving a mixed run half-applied locally.
    if (operation.kind === "download") {
      if (!operation.remoteOid) throw new Error(`Missing remote OID for ${operation.path}`);
      staged.push({ kind: "write", path: operation.path, bytes: await this.verifiedBlob(binding, operation.remoteOid) });
      return;
    }
    if (operation.kind === "delete-local") {
      staged.push({ kind: "remove", path: operation.path });
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
    await this.conflictOperation(binding, operation, changes, staged, reservedPaths, conflicts, deviceName, existingDeleteConflicts);
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
    deviceName: string,
    existingDeleteConflicts?: ReadonlySet<string>
  ): Promise<void> {
    if (operation.reason === "local-delete-remote-modify") {
      // The file was deleted locally while another device modified it. Neither
      // side wins silently: we do not auto-restore the remote version over the
      // user's deletion, nor do we let a later plan turn this into a silent remote
      // deletion. The conflict stays pending until the user picks Restore or
      // Delete in the dashboard, and a fresh record is added only once.
      if (!existingDeleteConflicts?.has(operation.path)) {
        conflicts.push(conflictRecord(operation.path, operation.reason));
      }
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
    const additionBytes = changes.additions.reduce((total, addition) => total + addition.bytes.byteLength, 0);
    const useGitData =
      additionBytes >= GRAPHQL_MAX_BYTES ||
      changes.additions.length + changes.deletions.length > GRAPHQL_MAX_FILES;
    try {
      if (useGitData) {
        return await this.github.createCommitWithGitData(binding.repository, binding.branch, expectedHeadOid, message, changes);
      }
      return await this.github.createCommitOnBranch(binding.repository, binding.branch, expectedHeadOid, message, changes);
    } catch (error) {
      if (isStaleHeadError(error)) {
        throw new SyncChangedDuringRunError("The remote branch changed while the sync commit was being published.", { cause: error });
      }
      throw error;
    }
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

  /**
   * Applies the "keep the remote version" choice for a delete-vs-modify conflict:
   * brings the current remote content back into the local vault.
   *
   * @throws When the remote file has meanwhile been removed from the branch.
   */
  async restoreRemoteFile(binding: RepositoryBinding, path: string): Promise<void> {
    const remote = await this.remoteSnapshot(binding);
    const entry = remote.manifest[path];
    if (!entry) throw new Error(`The remote file no longer exists on the branch: ${path}`);
    await this.vault.write(path, await this.verifiedBlob(binding, entry.oid));
  }

  /**
   * Applies the "delete the remote version" choice for a delete-vs-modify conflict:
   * removes the file from the branch (history retains it either way) and keeps
   * the local deletion. Runs through the same strong-consistency head
   * pre-check as the primary push path; a remote that already dropped the file
   * is treated as the desired end state rather than an error.
   */
  async deleteRemoteFile(
    binding: RepositoryBinding,
    path: string,
    deviceName: string
  ): Promise<{ baseCommitOid: string; manifest: SnapshotManifest }> {
    const head = await this.github.getBranchHeadForCommit(binding.repository, binding.branch);
    let current = await this.remoteSnapshot(binding);
    if (current.headOid !== head) current = await this.refreshedSnapshot(binding, head);
    if (!current.manifest[path]) {
      return {
        baseCommitOid: current.headOid,
        manifest: prepareManifest(current.manifest, this.vault.configDir()).manifest
      };
    }
    let commitOid: string;
    try {
      commitOid = await this.github.createCommitOnBranch(
        binding.repository,
        binding.branch,
        head,
        `[Constellation Sync] ${deviceName}\n\nResolve delete conflict: ${path}`,
        { additions: [], deletions: [path] }
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      const latestHead = await this.github.getBranchHeadForCommit(binding.repository, binding.branch);
      const latest = await this.refreshedSnapshot(binding, latestHead);
      if (latest.manifest[path]) throw error;
      this.remoteSnapshotCache = { repositoryId: binding.repository.id, branch: binding.branch, snapshot: latest };
      return {
        baseCommitOid: latest.headOid,
        manifest: prepareManifest(latest.manifest, this.vault.configDir()).manifest
      };
    }
    const refreshed = await this.refreshedSnapshot(binding, commitOid);
    return {
      baseCommitOid: refreshed.headOid,
      manifest: prepareManifest(refreshed.manifest, this.vault.configDir()).manifest
    };
  }
}

function prepareManifest(
  manifest: SnapshotManifest,
  configDir: string
): { manifest: SnapshotManifest; blockedPaths: string[] } {
  const candidates: SnapshotManifest = {};
  const blockedPaths = new Set<string>();
  for (const [path, entry] of Object.entries(manifest)) {
    try {
      if (!shouldSyncPath(path, configDir)) continue;
      if (validatePortablePath(path).length > 0) {
        blockedPaths.add(path);
        continue;
      }
      candidates[path] = entry;
    } catch {
      blockedPaths.add(path);
    }
  }
  for (const paths of findPortableCollisions(Object.keys(candidates)).values()) {
    for (const path of paths) blockedPaths.add(path);
  }
  return { manifest: omitPaths(candidates, blockedPaths), blockedPaths: [...blockedPaths].sort() };
}

function omitPaths(manifest: SnapshotManifest, blockedPaths: ReadonlySet<string>): SnapshotManifest {
  return Object.fromEntries(Object.entries(manifest).filter(([path]) => !blockedPaths.has(path)));
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
