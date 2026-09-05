import { Platform } from "obsidian";
import type { PluginSettings, StorageUsage } from "./types";
import { SCHEMA_VERSION } from "./types";

export const POLL_INTERVAL_MS_OPTIONS = [15_000, 30_000, 60_000, 300_000];
const DEFAULT_POLL_MS = 15_000;
// The default before 0.2.3. A stored 60 000 is that default, not a deliberate
// choice, so it migrates to the new default; anything the user actually picked
// stays.
const LEGACY_DEFAULT_POLL_MS = 60_000;

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
    localDebounceMs: 30_000,
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
  if (!raw || typeof raw !== "object") return defaults;

  const value = raw as Partial<PluginSettings> & { policy?: unknown };
  delete value.policy;

  const storageUsage = parseStorageUsage(value.storageUsage);

  return {
    ...defaults,
    ...value,
    schemaVersion: SCHEMA_VERSION,
    remotePollMs: normalizePollInterval(value.remotePollMs),
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.slice(-200) : [],
    activity: Array.isArray(value.activity) ? value.activity.slice(-500) : [],
    skippedFiles: Array.isArray(value.skippedFiles)
      ? value.skippedFiles.filter((item): item is string => typeof item === "string")
      : [],
    ...(storageUsage ? { storageUsage } : {})
  };
}

function parseStorageUsage(raw: unknown): StorageUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<StorageUsage>;
  if (typeof value.sizeKb !== "number" || !Number.isFinite(value.sizeKb) || value.sizeKb < 0) return null;
  if (typeof value.checkedAt !== "string" || Number.isNaN(Date.parse(value.checkedAt))) return null;
  return { sizeKb: value.sizeKb, checkedAt: value.checkedAt };
}

function defaultDeviceName(): string {
  if (Platform.isWin) return "windows";
  if (Platform.isMacOS) return "macos";
  if (Platform.isLinux) return "linux";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isIosApp) return "ios";
  return "device";
}
