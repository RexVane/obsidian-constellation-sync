import {
  LARGE_FILE_BLOCK_BYTES,
  LARGE_FILE_WARNING_BYTES,
  type SnapshotEntry,
  type SnapshotManifest,
  type SyncOperation,
  type SyncPlan,
  type SyncPlanSummary
} from "../types";
import { stableFingerprint } from "../utils/hash";

export interface PlanInput {
  baseCommitOid?: string;
  remoteHeadOid: string;
  base: SnapshotManifest;
  local: SnapshotManifest;
  remote: SnapshotManifest;
  blockedPaths?: string[];
}

export async function buildSyncPlan(input: PlanInput): Promise<SyncPlan> {
  const operations: SyncOperation[] = [];
  const blockedFiles: string[] = [...(input.blockedPaths ?? [])];
  const unportable = new Set(input.blockedPaths ?? []);
  const largeFileWarnings: string[] = [];
  const paths = new Set([...Object.keys(input.base), ...Object.keys(input.local), ...Object.keys(input.remote)]);

  for (const path of [...paths].sort()) {
    // A path that cannot exist on every platform, or that Git refuses outright,
    // is skipped rather than planned. One such file used to stall the whole
    // vault; the rest of the tree has no reason to wait for it.
    if (unportable.has(path)) continue;
    const base = input.base[path];
    const local = input.local[path];
    const remote = input.remote[path];
    const maxSize = Math.max(base?.size ?? 0, local?.size ?? 0, remote?.size ?? 0);
    if (maxSize >= LARGE_FILE_BLOCK_BYTES) {
      if (!blockedFiles.includes(path)) blockedFiles.push(path);
      continue;
    }
    if (maxSize >= LARGE_FILE_WARNING_BYTES) largeFileWarnings.push(path);

    const operation = classify(path, base, local, remote, maxSize);
    if (operation) operations.push(operation);
  }

  blockedFiles.sort();
  const summary = summarize(operations, largeFileWarnings.length);
  const trackedCount = Math.max(Object.keys(input.base).length, Object.keys(input.remote).length, 1);
  const localDeletionCount = summary.localDeletes;
  const remoteDeletionCount = summary.remoteDeletes;
  const deletionGuardTriggered = [localDeletionCount, remoteDeletionCount].some(
    (count) => count >= 500 || (count >= 20 && count / trackedCount >= 0.25)
  );
  const initial = !input.baseCommitOid;
  const id = await stableFingerprint({
    remoteHeadOid: input.remoteHeadOid,
    initial,
    operations,
    blockedFiles,
    largeFileWarnings
  });

  return {
    id,
    createdAt: new Date().toISOString(),
    ...(input.baseCommitOid ? { baseCommitOid: input.baseCommitOid } : {}),
    remoteHeadOid: input.remoteHeadOid,
    initial,
    operations,
    summary,
    deletionGuardTriggered,
    largeFileWarnings,
    blockedFiles
  };
}

function classify(
  path: string,
  base: SnapshotEntry | undefined,
  local: SnapshotEntry | undefined,
  remote: SnapshotEntry | undefined,
  size: number
): SyncOperation | null {
  if (local?.oid === remote?.oid) return null;

  if (!base) {
    if (local && remote) {
      return operation("conflict", path, size, base, local, remote, "initial-divergence");
    }
    if (local) return operation("upload", path, size, base, local, remote);
    if (remote) return operation("download", path, size, base, local, remote);
    return null;
  }

  const localChanged = local?.oid !== base.oid;
  const remoteChanged = remote?.oid !== base.oid;
  if (!localChanged && !remoteChanged) return null;

  if (localChanged && !remoteChanged) {
    return local
      ? operation("upload", path, size, base, local, remote)
      : operation("delete-remote", path, size, base, local, remote);
  }

  if (!localChanged && remoteChanged) {
    return remote
      ? operation("download", path, size, base, local, remote)
      : operation("delete-local", path, size, base, local, remote);
  }

  if (!local && !remote) return null;
  if (!local && remote) {
    return operation("conflict", path, size, base, local, remote, "local-delete-remote-modify");
  }
  if (local && !remote) {
    return operation("conflict", path, size, base, local, remote, "remote-delete-local-modify");
  }
  return operation("merge", path, size, base, local, remote);
}

function operation(
  kind: SyncOperation["kind"],
  path: string,
  size: number,
  base?: SnapshotEntry,
  local?: SnapshotEntry,
  remote?: SnapshotEntry,
  reason?: Extract<SyncOperation, { kind: "conflict" }>["reason"]
): SyncOperation {
  const shared = {
    path,
    size,
    ...(base ? { baseOid: base.oid } : {}),
    ...(local ? { localOid: local.oid } : {}),
    ...(remote ? { remoteOid: remote.oid } : {})
  };
  if (kind === "conflict") return { kind, ...shared, reason: reason ?? "binary" };
  return { kind, ...shared };
}

function summarize(operations: SyncOperation[], warnings: number): SyncPlanSummary {
  const summary: SyncPlanSummary = {
    uploads: 0,
    downloads: 0,
    localDeletes: 0,
    remoteDeletes: 0,
    merges: 0,
    conflicts: 0,
    warnings
  };
  for (const operation of operations) {
    if (operation.kind === "upload") summary.uploads += 1;
    if (operation.kind === "download") summary.downloads += 1;
    if (operation.kind === "delete-local") summary.localDeletes += 1;
    if (operation.kind === "delete-remote") summary.remoteDeletes += 1;
    if (operation.kind === "merge") summary.merges += 1;
    if (operation.kind === "conflict") summary.conflicts += 1;
  }
  return summary;
}
