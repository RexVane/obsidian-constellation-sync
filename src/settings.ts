import { Platform } from "obsidian";
import type {
  ActivityRecord,
  ConflictReason,
  ConflictRecord,
  GitHubAccount,
  LocaleSetting,
  PendingReview,
  PluginSettings,
  RepositoryBinding,
  RepositoryRef,
  SnapshotManifest,
  StorageUsage,
  SyncOperation,
  SyncPlan,
  SyncPlanSummary
} from "./types";
import { SCHEMA_VERSION } from "./types";

export const POLL_INTERVAL_MS_OPTIONS = [15_000, 30_000, 60_000, 300_000];
const DEFAULT_POLL_MS = 15_000;
// The default before 0.2.3. A stored 60 000 is that default, not a deliberate
// choice, so it migrates to the new default; anything the user actually picked
// stays.
const LEGACY_DEFAULT_POLL_MS = 60_000;

export const LOCAL_DEBOUNCE_MS_OPTIONS = [5_000, 15_000, 30_000, 60_000];
// Fast by default: 5 s after the last local change the push goes out, so with
// a 15 s check interval the worst-case cross-device latency is ~20 s.
const DEFAULT_LOCAL_DEBOUNCE_MS = 5_000;
// The default before 0.5.1. A stored 30 000 is that default, not a deliberate
// choice, so it migrates to the new default; anything the user actually picked
// stays.
const LEGACY_DEFAULT_LOCAL_DEBOUNCE_MS = 30_000;

export function normalizeLocalDebounce(ms: unknown): number {
  const value = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_LOCAL_DEBOUNCE_MS;
  if (value === LEGACY_DEFAULT_LOCAL_DEBOUNCE_MS) return DEFAULT_LOCAL_DEBOUNCE_MS;
  return LOCAL_DEBOUNCE_MS_OPTIONS.includes(value) ? value : DEFAULT_LOCAL_DEBOUNCE_MS;
}

export function normalizePollInterval(ms: unknown): number {
  const value = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_POLL_MS;
  if (value === LEGACY_DEFAULT_POLL_MS) return DEFAULT_POLL_MS;
  return POLL_INTERVAL_MS_OPTIONS.includes(value) ? value : DEFAULT_POLL_MS;
}

export function createDefaultSettings(): PluginSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    locale: "auto",
    autoSync: true,
    paused: false,
    localDebounceMs: DEFAULT_LOCAL_DEBOUNCE_MS,
    remotePollMs: DEFAULT_POLL_MS,
    deviceId: crypto.randomUUID(),
    deviceName: defaultDeviceName(),
    baseManifest: {},
    conflicts: [],
    activity: [],
    skippedFiles: []
  };
}

export function loadSettings(raw: unknown): PluginSettings {
  const defaults = createDefaultSettings();
  if (!isRecord(raw)) return defaults;

  // Parse a strict whitelist instead of spreading data.json into live settings.
  // This also drops legacy policy and configuration-sync fields automatically.
  const account = parseAccount(raw.account);
  const binding = parseBinding(raw.binding);
  const pendingReview = parsePendingReview(raw.pendingReview);
  const storageUsage = parseStorageUsage(raw.storageUsage);
  const lastSuccessAt = parseDate(raw.lastSuccessAt);

  return {
    schemaVersion: SCHEMA_VERSION,
    locale: parseLocale(raw.locale) ?? defaults.locale,
    autoSync: typeof raw.autoSync === "boolean" ? raw.autoSync : defaults.autoSync,
    paused: typeof raw.paused === "boolean" ? raw.paused : defaults.paused,
    remotePollMs: normalizePollInterval(raw.remotePollMs),
    localDebounceMs: normalizeLocalDebounce(raw.localDebounceMs),
    deviceId: nonEmptyString(raw.deviceId)?.trim() ?? defaults.deviceId,
    deviceName: nonEmptyString(raw.deviceName)?.trim().slice(0, 32) ?? defaults.deviceName,
    baseManifest: parseManifest(raw.baseManifest),
    conflicts: Array.isArray(raw.conflicts)
      ? raw.conflicts.map(parseConflict).filter((item): item is ConflictRecord => item !== null).slice(-200)
      : [],
    activity: Array.isArray(raw.activity)
      ? raw.activity.map(parseActivity).filter((item): item is ActivityRecord => item !== null).slice(-500)
      : [],
    skippedFiles: Array.isArray(raw.skippedFiles)
      ? [...new Set(raw.skippedFiles.filter((item): item is string => typeof item === "string"))].sort()
      : [],
    ...(account ? { account } : {}),
    ...(binding ? { binding } : {}),
    ...(pendingReview ? { pendingReview } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(storageUsage ? { storageUsage } : {})
  };
}

function parseLocale(raw: unknown): LocaleSetting | null {
  return raw === "auto" || raw === "zh-CN" || raw === "en" ? raw : null;
}

function parseAccount(raw: unknown): GitHubAccount | null {
  if (!isRecord(raw)) return null;
  const login = nonEmptyString(raw.login);
  if (!login) return null;
  const avatarUrl = nonEmptyString(raw.avatarUrl);
  return { login, ...(avatarUrl ? { avatarUrl } : {}) };
}

function parseRepository(raw: unknown): RepositoryRef | null {
  if (!isRecord(raw)) return null;
  const nodeId = nonEmptyString(raw.nodeId);
  const owner = nonEmptyString(raw.owner);
  const name = nonEmptyString(raw.name);
  const fullName = nonEmptyString(raw.fullName);
  const defaultBranch = nonEmptyString(raw.defaultBranch);
  if (
    typeof raw.id !== "number" ||
    !Number.isSafeInteger(raw.id) ||
    raw.id <= 0 ||
    !nodeId ||
    !owner ||
    !name ||
    !fullName ||
    typeof raw.private !== "boolean" ||
    !defaultBranch
  ) return null;
  return { id: raw.id, nodeId, owner, name, fullName, private: raw.private, defaultBranch };
}

function parseBinding(raw: unknown): RepositoryBinding | null {
  if (!isRecord(raw)) return null;
  const repository = parseRepository(raw.repository);
  const vaultId = nonEmptyString(raw.vaultId);
  const branch = nonEmptyString(raw.branch);
  const boundAt = parseDate(raw.boundAt);
  const baseCommitOid = nonEmptyString(raw.baseCommitOid);
  if (!repository || !vaultId || !branch || !boundAt) return null;
  return { repository, vaultId, branch, boundAt, ...(baseCommitOid ? { baseCommitOid } : {}) };
}

function parseManifest(raw: unknown): SnapshotManifest {
  if (!isRecord(raw)) return {};
  const manifest: SnapshotManifest = {};
  for (const [path, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || entry.path !== path || !isNonNegativeNumber(entry.size)) continue;
    const oid = nonEmptyString(entry.oid);
    if (!oid) continue;
    manifest[path] = { path, oid, size: entry.size };
  }
  return manifest;
}

const OPERATION_KINDS = new Set<SyncOperation["kind"]>([
  "upload",
  "download",
  "delete-local",
  "delete-remote",
  "merge",
  "conflict"
]);
const CONFLICT_REASONS = new Set<ConflictReason>([
  "initial-divergence",
  "overlapping-text",
  "binary",
  "local-delete-remote-modify",
  "remote-delete-local-modify"
]);

function parseOperation(raw: unknown): SyncOperation | null {
  if (!isRecord(raw) || !OPERATION_KINDS.has(raw.kind as SyncOperation["kind"])) return null;
  const path = nonEmptyString(raw.path);
  if (!path || !isNonNegativeNumber(raw.size)) return null;
  const kind = raw.kind as SyncOperation["kind"];
  const baseOid = nonEmptyString(raw.baseOid);
  const localOid = nonEmptyString(raw.localOid);
  const remoteOid = nonEmptyString(raw.remoteOid);
  const shared = {
    path,
    size: raw.size,
    ...(baseOid ? { baseOid } : {}),
    ...(localOid ? { localOid } : {}),
    ...(remoteOid ? { remoteOid } : {})
  };
  if (kind === "conflict") {
    if (!CONFLICT_REASONS.has(raw.reason as ConflictReason)) return null;
    return { kind, ...shared, reason: raw.reason as ConflictReason };
  }
  return { kind, ...shared };
}

function parseSummary(raw: unknown): SyncPlanSummary | null {
  if (!isRecord(raw)) return null;
  const keys: Array<keyof SyncPlanSummary> = [
    "uploads",
    "downloads",
    "localDeletes",
    "remoteDeletes",
    "merges",
    "conflicts",
    "warnings"
  ];
  if (keys.some((key) => !isNonNegativeNumber(raw[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, raw[key]])) as unknown as SyncPlanSummary;
}

function parsePlan(raw: unknown): SyncPlan | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id);
  const createdAt = parseDate(raw.createdAt);
  const remoteHeadOid = nonEmptyString(raw.remoteHeadOid);
  const summary = parseSummary(raw.summary);
  if (
    !id ||
    !createdAt ||
    !remoteHeadOid ||
    typeof raw.initial !== "boolean" ||
    !Array.isArray(raw.operations) ||
    !summary ||
    typeof raw.deletionGuardTriggered !== "boolean" ||
    !isStringArray(raw.largeFileWarnings) ||
    !isStringArray(raw.blockedFiles)
  ) return null;
  const operations = raw.operations.map(parseOperation);
  if (operations.some((item) => item === null)) return null;
  const baseCommitOid = nonEmptyString(raw.baseCommitOid);
  return {
    id,
    createdAt,
    ...(baseCommitOid ? { baseCommitOid } : {}),
    remoteHeadOid,
    initial: raw.initial,
    operations: operations as SyncOperation[],
    summary,
    deletionGuardTriggered: raw.deletionGuardTriggered,
    largeFileWarnings: [...raw.largeFileWarnings],
    blockedFiles: [...raw.blockedFiles]
  };
}

function parsePendingReview(raw: unknown): PendingReview | null {
  if (!isRecord(raw)) return null;
  const plan = parsePlan(raw.plan);
  return plan ? { plan } : null;
}

function parseConflict(raw: unknown): ConflictRecord | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id);
  const path = nonEmptyString(raw.path);
  const createdAt = parseDate(raw.createdAt);
  if (!id || !path || !createdAt || !CONFLICT_REASONS.has(raw.reason as ConflictReason) || typeof raw.resolved !== "boolean") {
    return null;
  }
  const conflictPath = nonEmptyString(raw.conflictPath);
  const resolution = raw.resolution === "restore-remote" || raw.resolution === "delete-remote" ? raw.resolution : null;
  return {
    id,
    path,
    reason: raw.reason as ConflictReason,
    createdAt,
    resolved: raw.resolved,
    ...(conflictPath ? { conflictPath } : {}),
    ...(resolution ? { resolution } : {})
  };
}

const ACTIVITY_KINDS = new Set<ActivityRecord["kind"]>([
  "sync",
  "login",
  "bind",
  "rename",
  "restore",
  "warning",
  "error"
]);

function parseActivity(raw: unknown): ActivityRecord | null {
  if (!isRecord(raw) || !ACTIVITY_KINDS.has(raw.kind as ActivityRecord["kind"])) return null;
  const id = nonEmptyString(raw.id);
  const time = parseDate(raw.time);
  const message = nonEmptyString(raw.message);
  if (!id || !time || !message) return null;
  const commitOid = nonEmptyString(raw.commitOid);
  const counts = parsePartialSummary(raw.counts);
  return {
    id,
    time,
    kind: raw.kind as ActivityRecord["kind"],
    message,
    ...(commitOid ? { commitOid } : {}),
    ...(counts ? { counts } : {})
  };
}

function parsePartialSummary(raw: unknown): Partial<SyncPlanSummary> | null {
  if (!isRecord(raw)) return null;
  const keys: Array<keyof SyncPlanSummary> = [
    "uploads",
    "downloads",
    "localDeletes",
    "remoteDeletes",
    "merges",
    "conflicts",
    "warnings"
  ];
  const entries = keys.flatMap((key) => isNonNegativeNumber(raw[key]) ? [[key, raw[key]] as const] : []);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function parseStorageUsage(raw: unknown): StorageUsage | null {
  if (!isRecord(raw) || !isNonNegativeNumber(raw.sizeKb)) return null;
  const checkedAt = parseDate(raw.checkedAt);
  return checkedAt ? { sizeKb: raw.sizeKb, checkedAt } : null;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
}

function nonEmptyString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function parseDate(raw: unknown): string | null {
  return typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

function isNonNegativeNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
}

function isStringArray(raw: unknown): raw is string[] {
  return Array.isArray(raw) && raw.every((item) => typeof item === "string");
}

function defaultDeviceName(): string {
  if (Platform.isWin) return "windows";
  if (Platform.isMacOS) return "macos";
  if (Platform.isLinux) return "linux";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isIosApp) return "ios";
  return "device";
}
