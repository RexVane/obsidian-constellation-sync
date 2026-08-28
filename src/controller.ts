import type {
  LocaleSetting,
  PluginSettings,
  RemoteVaultSummary,
  RepositoryRef,
  RuntimeStatus
} from "./types";

export interface DashboardSnapshot {
  settings: PluginSettings;
  status: RuntimeStatus;
  repositories: RepositoryRef[];
  selectedRepository?: RepositoryRef;
  remoteVaults: RemoteVaultSummary[];
  localVaultName: string;
  suggestedBranch?: string;
  rateLimit: { remaining: number | null; resetAt: number | null };
}

export interface DashboardController {
  snapshot(): DashboardSnapshot;
  subscribe(listener: () => void): () => void;
  activateView(): Promise<void>;
  connectWithToken(token: string): Promise<void>;
  openExternal(url: string): void;
  refreshRepositories(): Promise<void>;
  selectRepository(repository: RepositoryRef): Promise<void>;
  createVault(repository: RepositoryRef, englishName: string): Promise<void>;
  useDefaultBranch(repository: RepositoryRef): Promise<void>;
  joinVault(repository: RepositoryRef, vault: RemoteVaultSummary): Promise<void>;
  renameVault(englishName: string): Promise<void>;
  syncNow(): Promise<void>;
  approvePendingSync(): Promise<void>;
  cancelPendingSync(): Promise<void>;
  resolveConflict(id: string): Promise<void>;
  restoreFile(path: string, commitOid: string): Promise<void>;
  updatePreference<K extends "autoSync" | "paused" | "deviceName" | "locale" | "remotePollMs">(
    key: K,
    value: K extends "autoSync" | "paused"
      ? boolean
      : K extends "locale"
        ? LocaleSetting
        : K extends "remotePollMs"
          ? number
          : string
  ): Promise<void>;
  updateIgnorePatterns(value: string): Promise<void>;
  updateCommunityPluginData(pluginIds: string[]): Promise<void>;
  disconnectVault(): Promise<void>;
  signOut(): Promise<void>;
}
