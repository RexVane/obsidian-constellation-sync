import { Platform } from "obsidian";
import type { PluginSettings, StorageUsage } from "./types";
import { SCHEMA_VERSION } from "./types";

export const POLL_INTERVAL_MS_OPTIONS = [15_000, 30_000, 60_000, 300_000];
const DEFAULT_POLL_MS = 15_000;
// The default before 0.2.3. A stored 60 000 is that default, not a deliberate
// choice, so it migrates to the new default; anything the user actually picked
// stays.
const LEGACY_DEFAULT_POLL_MS = 60_000;

export const LOCAL_DEBOUNCE_MS_OPTIONS = [5_000, 15_000, 30_000, 60_000];
const DEFAULT_LOCAL_DEBOUNCE_MS = 30_000;

export function normalizeLocalDebounce(ms: unknown): number {
  const value = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_LOCAL_DEBOUNCE_MS;
  return LOCAL_DEBOUNCE_MS_OPTIONS.includes(value) ? value : DEFAULT_LOCAL_DEBOUNCE_MS;
}

// The safe configuration defaults: appearance and editor preferences, themes,
// and snippets. Plugin-related files (the enabled list and per-plugin
// settings) are deliberately excluded — plugins are installed and configured
// on each device.
const DESKTOP_CONFIG_SYNC_PATHS = [
  "appearance.json",
  "app.json",
  "hotkeys.json",
  "themes/",
  "snippets/"
];

// Hotkeys barely apply on mobile (no hardware modifiers), so the mobile
// default skips them; every other safe entry is portable across platforms.
export function defaultConfigSyncPaths(): string[] {
  if (Platform.isMobile) return ["appearance.json", "themes/", "snippets/"];
  return [...DESKTOP_CONFIG_SYNC_PATHS];
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
    localDebounceMs: 30_000,
    remotePollMs: DEFAULT_POLL_MS,
    deviceId: crypto.randomUUID(),
    deviceName: defaultDeviceName(),
    baseManifest: {},
    conflicts: [],
    activity: [],
    skippedFiles: [],
    syncedConfigPaths: defaultConfigSyncPaths()
  };
}

export function loadSettings(raw: unknown): PluginSettings {
  const defaults = createDefaultSettings();
  if (!raw || typeof raw !== "object") return defaults;

  const value = raw as Partial<PluginSettings> & { policy?: unknown };
  delete value.policy;

  const storageUsage = parseStorageUsage(value.storageUsage);
  const syncedConfigPaths = sanitizeConfigPaths(value.syncedConfigPaths);

  return {
    ...defaults,
    ...value,
    schemaVersion: SCHEMA_VERSION,
    remotePollMs: normalizePollInterval(value.remotePollMs),
    localDebounceMs: normalizeLocalDebounce(value.localDebounceMs),
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.slice(-200) : [],
    activity: Array.isArray(value.activity) ? value.activity.slice(-500) : [],
    skippedFiles: Array.isArray(value.skippedFiles)
      ? value.skippedFiles.filter((item): item is string => typeof item === "string")
      : [],
    syncedConfigPaths,
    ...(storageUsage ? { storageUsage } : {})
  };
}

function sanitizeConfigPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return defaultConfigSyncPaths();
  return [
    ...new Set(
      raw.filter(
        (item): item is string =>
          typeof item === "string" &&
          item.trim() !== "" &&
          !item.startsWith("/") &&
          !item.includes("//") &&
          // Plugin sync was removed in 0.4.8: drop stale selections so the
          // picker stops offering them and old saves migrate cleanly.
          item !== "community-plugins.json" &&
          !item.startsWith("plugins/")
      )
    )
  ];
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
