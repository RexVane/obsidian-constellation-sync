export const PLUGIN_ID = "constellation-sync";
export const VAULT_META_PATH = ".constellation-sync/vault.json";
export const SCHEMA_VERSION = 1;
export const LARGE_FILE_WARNING_BYTES = 50 * 1024 * 1024;
export const LARGE_FILE_BLOCK_BYTES = 100 * 1024 * 1024;

export type LocaleSetting = "auto" | "zh-CN" | "en";
export type SyncStatusKind =
  | "unconfigured"
  | "idle"
  | "scanning"
  | "syncing"
  | "needs-review"
  | "conflict"
  | "offline"
  | "rate-limited"
  | "reauth-required"
  | "paused"
  | "error";

export interface GitHubSession {
  accessToken: string;
  tokenType: string;
}

export interface GitHubAccount {
  login: string;
  avatarUrl?: string;
}

export interface RepositoryRef {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface RepositoryBinding {
  repository: RepositoryRef;
  vaultId: string;
  branch: string;
  baseCommitOid?: string;
  boundAt: string;
}

export interface VaultMetadata {
  schemaVersion: 1;
  vaultId: string;
  englishName: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotEntry {
  path: string;
  oid: string;
  size: number;
}

export type SnapshotManifest = Record<string, SnapshotEntry>;

export type ConflictReason =
  | "initial-divergence"
  | "overlapping-text"
  | "binary"
  | "local-delete-remote-modify"
  | "remote-delete-local-modify";

interface SyncOperationBase {
  path: string;
  baseOid?: string;
  localOid?: string;
  remoteOid?: string;
  size: number;
}

export type SyncOperation =
  | (SyncOperationBase & { kind: "upload" })
  | (SyncOperationBase & { kind: "download" })
  | (SyncOperationBase & { kind: "delete-local" })
  | (SyncOperationBase & { kind: "delete-remote" })
  | (SyncOperationBase & { kind: "merge" })
  | (SyncOperationBase & { kind: "conflict"; reason: ConflictReason });

export interface SyncPlanSummary {
  uploads: number;
  downloads: number;
  localDeletes: number;
  remoteDeletes: number;
  merges: number;
  conflicts: number;
  warnings: number;
}

export interface SyncPlan {
  id: string;
  createdAt: string;
  baseCommitOid?: string;
  remoteHeadOid: string;
  initial: boolean;
  operations: SyncOperation[];
  summary: SyncPlanSummary;
  deletionGuardTriggered: boolean;
  largeFileWarnings: string[];
  blockedFiles: string[];
}

export interface SyncApproval {
  planId: string;
  confirmInitialMerge: boolean;
  confirmMassDeletion: boolean;
  confirmLargeFiles: boolean;
}

export interface ConflictRecord {
  id: string;
  path: string;
  conflictPath?: string;
  reason: ConflictReason;
  createdAt: string;
  resolved: boolean;
}

export interface ActivityRecord {
  id: string;
  time: string;
  kind: "sync" | "login" | "bind" | "rename" | "restore" | "warning" | "error";
  message: string;
  commitOid?: string;
  counts?: Partial<SyncPlanSummary>;
}

export interface PendingReview {
  plan: SyncPlan;
}

export interface RuntimeStatus {
  kind: SyncStatusKind;
  message: string;
  progress?: number;
  lastSuccessAt?: string;
  errorCode?: string;
}

export interface PluginSettings {
  schemaVersion: 1;
  locale: LocaleSetting;
  autoSync: boolean;
  paused: boolean;
  localDebounceMs: number;
  remotePollMs: number;
  deviceId: string;
  deviceName: string;
  account?: GitHubAccount;
  binding?: RepositoryBinding;
  baseManifest: SnapshotManifest;
  pendingReview?: PendingReview;
  conflicts: ConflictRecord[];
  activity: ActivityRecord[];
  /** Paths the last run left untouched because they cannot sync safely everywhere. */
  skippedFiles: string[];
  lastSuccessAt?: string;
  /** Whole-repo size sampled from GitHub for the dashboard storage gauge. */
  storageUsage?: StorageUsage;
  /**
   * Config entries (relative to the config directory; directories end with "/")
   * the user picked to sync, e.g. appearance.json or plugins/dataview/data.json.
   */
  syncedConfigPaths: string[];
}

export interface StorageUsage {
  /** Whole repository size in kilobytes, as reported by GitHub. */
  sizeKb: number;
  checkedAt: string;
}

export interface ConfigFileInfo {
  /** Entry path relative to the config directory; directories end with "/". */
  path: string;
  isDir: boolean;
  /** Always-excluded entries cannot be selected at all. */
  disabled: boolean;
  selected: boolean;
}

export interface BranchSummary {
  name: string;
  headOid: string;
  protected: boolean;
}

export interface RemoteVaultSummary {
  branch: BranchSummary;
  metadata: VaultMetadata;
}

export interface SyncResult {
  kind: "success" | "needs-review" | "noop";
  plan: SyncPlan;
  commitOid?: string;
}
