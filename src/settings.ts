import { Platform } from "obsidian";
import type { PluginSettings, SyncPolicy } from "./types";
import { SCHEMA_VERSION } from "./types";

export const DEFAULT_POLICY: SyncPolicy = {
  obsidian: {
    communityPluginData: []
  },
  ignorePatterns: []
};

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

/**
 * Whether a remote policy read should replace the local one. `policyRevision`
 * only ever increases, so a read reporting less than what this device already
 * accepted came from a replica that has not caught up, and adopting it would
 * roll a just-made change back.
 */
export function shouldAdoptRemotePolicy(remoteRevision: number, acceptedRevision: number | undefined): boolean {
  return remoteRevision >= (acceptedRevision ?? 0);
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
    policy: structuredClone(DEFAULT_POLICY),
    baseManifest: {},
    conflicts: [],
    activity: [],
    skippedFiles: []
  };
}

export function loadSettings(raw: unknown): PluginSettings {
  const defaults = createDefaultSettings();
  if (!raw || typeof raw !== "object") return defaults;

  const value = raw as Partial<PluginSettings>;
  const obsidian = value.policy?.obsidian;
  return {
    ...defaults,
    ...value,
    schemaVersion: SCHEMA_VERSION,
    remotePollMs: normalizePollInterval(value.remotePollMs),
    policy: {
      obsidian: {
        ...defaults.policy.obsidian,
        ...obsidian,
        communityPluginData: Array.isArray(obsidian?.communityPluginData)
          ? obsidian.communityPluginData.filter((item): item is string => typeof item === "string")
          : []
      },
      ignorePatterns: Array.isArray(value.policy?.ignorePatterns)
        ? value.policy.ignorePatterns.filter((item): item is string => typeof item === "string")
        : []
    },
    baseManifest: value.baseManifest ?? {},
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.slice(-200) : [],
    activity: Array.isArray(value.activity) ? value.activity.slice(-500) : [],
    skippedFiles: Array.isArray(value.skippedFiles)
      ? value.skippedFiles.filter((item): item is string => typeof item === "string")
      : []
  };
}

function defaultDeviceName(): string {
  if (Platform.isWin) return "windows";
  if (Platform.isMacOS) return "macos";
  if (Platform.isLinux) return "linux";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isIosApp) return "ios";
  return "device";
}
