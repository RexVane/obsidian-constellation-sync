import { Notice, Plugin } from "obsidian";
import { GitHubAuth, GitHubAuthError, type SecretStore } from "./auth/github-auth";
import type { DashboardController, DashboardSnapshot } from "./controller";
import { GitHubApiError, GitHubClient, isStaleHeadError } from "./github/github-client";
import { createDefaultSettings, loadSettings, normalizeLocalDebounce, normalizePollInterval } from "./settings";
import { SyncChangedDuringRunError, SyncEngine, SyncReviewRequiredError } from "./sync/engine";
import { ObsidianVaultStore } from "./sync/vault-store";
import {
  SCHEMA_VERSION,
  type ConfigFileInfo,
  type LocaleSetting,
  type PluginSettings,
  type RemoteVaultSummary,
  type RepositoryRef,
  type RuntimeStatus,
  type SyncApproval,
  type VaultMetadata
} from "./types";
import { branchFromEnglishName, slugifyEnglishName, validateBranchName } from "./utils/branch";

import { ConstellationDashboardView, DASHBOARD_VIEW_TYPE } from "./ui/dashboard-view";
import { ConstellationSettingTab } from "./ui/settings-tab";

const STORAGE_REFRESH_MS = 10 * 60_000;

export default class ConstellationSyncPlugin extends Plugin implements DashboardController {
  override settings: PluginSettings = createDefaultSettings();
  private status: RuntimeStatus = { kind: "unconfigured", message: "Not configured" };
  private auth!: GitHubAuth;
  private github!: GitHubClient;
  private engine!: SyncEngine;
  private vaultStore!: ObsidianVaultStore;
  private readonly listeners = new Set<() => void>();
  private repositories: RepositoryRef[] = [];
  private remoteVaults: RemoteVaultSummary[] = [];
  private selectedRepository?: RepositoryRef;
  private operationQueue: Promise<void> = Promise.resolve();
  private localTimer: number | null = null;
  private lastRemotePollAt = 0;
  private statusBar?: HTMLElement;

  override async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    const secretStore: SecretStore = {
      getSecret: (key) => this.app.secretStorage.getSecret(key),
      setSecret: (key, value) => this.app.secretStorage.setSecret(key, value),
      // Obsidian currently exposes no delete operation; an empty value is inert and
      // ensures a revoked session can never be used again.
      removeSecret: (key) => this.app.secretStorage.setSecret(key, "")
    };
    this.auth = new GitHubAuth(secretStore);
    this.github = new GitHubClient(this.auth);
    this.vaultStore = new ObsidianVaultStore(this.app);
    this.vaultStore.setSyncedConfigPaths(this.settings.syncedConfigPaths);
    this.engine = new SyncEngine(this.github, this.vaultStore);

    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new ConstellationDashboardView(leaf, this));
    this.addRibbonIcon("orbit", "Constellation Sync", () => void this.activateView());
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({ id: "pause-auto-sync", name: "Pause automatic sync", callback: () => void this.updatePreference("paused", true) });
    this.addCommand({ id: "resume-auto-sync", name: "Resume automatic sync", callback: () => void this.updatePreference("paused", false) });
    this.addCommand({ id: "verify-binding", name: "Verify repository binding", callback: () => void this.verifyBinding() });
    this.addSettingTab(new ConstellationSettingTab(this.app, this));

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("constellation-sync-statusbar");
    this.statusBar.addEventListener("click", () => void this.activateView());

    const onVaultChange = (): void => this.scheduleLocalSync();
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.pollImmediately();
    });
    this.registerInterval(window.setInterval(() => void this.maybePollRemote(), 5_000));

    this.setStatus(this.settings.paused ? "paused" : "idle", this.settings.paused ? "Paused" : "Ready");
    void this.initializeSession();
  }

  override onunload(): void {
    if (this.localTimer !== null) window.clearTimeout(this.localTimer);
  }

  snapshot(): DashboardSnapshot {
    const localVaultName = this.localVaultName();
    const suggestedBranch = this.suggestedLocalBranch();
    return {
      settings: structuredClone(this.settings),
      status: { ...this.status },
      repositories: [...this.repositories],
      ...(this.selectedRepository ? { selectedRepository: { ...this.selectedRepository } } : {}),
      remoteVaults: structuredClone(this.remoteVaults),
      localVaultName,
      ...(suggestedBranch ? { suggestedBranch } : {}),
      rateLimit: this.github.getRateLimit()
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async connectWithToken(token: string): Promise<void> {
    this.setStatus("scanning", "Verifying GitHub token…");
    try {
      this.auth.setPatSession(token);
      this.settings.account = await this.github.getAccount();
      this.addActivity("login", `Connected GitHub account @${this.settings.account.login}`);
      await this.saveSettings();
      await this.refreshRepositories();
      this.setStatus("idle", "GitHub connected");
    } catch (error) {
      // A token that failed verification must never linger in storage.
      this.auth.signOut();
      this.handleError(error);
      throw error;
    }
  }

  openExternal(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("Only HTTPS github.com links can be opened.");
    window.open(parsed.toString(), "_blank", "noopener,noreferrer");
  }

  async refreshRepositories(): Promise<void> {
    this.setStatus("scanning", "Loading repositories…");
    try {
      const repositories = await this.github.listAccessibleRepositories();
      this.repositories = repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
      if (this.selectedRepository) {
        const nextSelected = this.repositories.find((item) => item.id === this.selectedRepository?.id);
        if (nextSelected) this.selectedRepository = nextSelected;
        else delete this.selectedRepository;
      }
      this.setStatus("idle", `Found ${this.repositories.length} repositories`);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async selectRepository(repository: RepositoryRef): Promise<void> {
    return this.enqueueOperation(() => this.selectRepositoryInternal(repository));
  }

  private async selectRepositoryInternal(repository: RepositoryRef): Promise<void> {
    this.selectedRepository = repository;
    this.setStatus("scanning", `Scanning ${repository.fullName}…`);
    try {
      // Selecting a repository only discovers what is already there. Binding a
      // vault always needs an explicit choice, because guessing a branch from
      // the local folder name silently forks devices onto separate branches
      // whenever those folder names differ.
      this.remoteVaults = await this.github.discoverVaults(repository);
      this.setStatus("idle", `Found ${this.remoteVaults.length} vault branches`);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async createVault(repository: RepositoryRef, englishName: string): Promise<void> {
    return this.enqueueOperation(() => this.createVaultInternal(repository, englishName));
  }

  private async createVaultInternal(repository: RepositoryRef, englishName: string): Promise<void> {
    if (this.settings.binding) throw new Error("This Obsidian vault is already bound to a GitHub branch.");
    const branch = branchFromEnglishName(englishName, repository.defaultBranch);
    const branches = await this.github.listBranches(repository);
    if (branches.some((item) => item.name === branch)) throw new Error(`Branch ${branch} already exists.`);
    const now = new Date().toISOString();
    const metadata: VaultMetadata = {
      schemaVersion: SCHEMA_VERSION,
      vaultId: crypto.randomUUID(),
      englishName: branch,
      createdAt: now,
      updatedAt: now,


    };
    this.setStatus("syncing", `Creating ${branch}…`);
    try {
      await this.github.createVaultBranch(repository, metadata);
    } catch (error) {
      if (!isReferenceAlreadyExistsError(error)) throw error;
      const existing = await this.github.getVaultMetadata(repository, branch);
      if (!existing) throw error;
      this.settings.binding = {
        repository,
        vaultId: existing.vaultId,
        branch,

        boundAt: new Date().toISOString()
      };

      this.settings.baseManifest = {};
      delete this.settings.pendingReview;
      this.addActivity("bind", `Joined existing vault branch ${branch}`);
      await this.saveSettings();
      await this.performSync();
      return;
    }
    this.settings.binding = {
      repository,
      vaultId: metadata.vaultId,
      branch,

      boundAt: now
    };
    this.settings.baseManifest = {};
    delete this.settings.pendingReview;
    this.addActivity("bind", `Created vault branch ${branch}`);
    await this.saveSettings();
    await this.performSync();
  }

  async useDefaultBranch(repository: RepositoryRef): Promise<void> {
    return this.enqueueOperation(() => this.useDefaultBranchInternal(repository));
  }

  private async useDefaultBranchInternal(repository: RepositoryRef): Promise<void> {
    if (this.settings.binding) throw new Error("This Obsidian vault is already bound to a GitHub branch.");
    const branch = repository.defaultBranch;
    this.setStatus("syncing", `Using ${branch} as the vault…`);
    const now = new Date().toISOString();
    let vaultId: string;


    // Another device may already have turned the default branch into the vault;
    // in that case this is a join, not a creation.
    const existing = await this.github.getVaultMetadata(repository, branch);
    if (existing) {
      vaultId = existing.vaultId;


      this.addActivity("bind", `Joined vault branch ${branch}`);
    } else {
      const metadata: VaultMetadata = {
        schemaVersion: SCHEMA_VERSION,
        vaultId: crypto.randomUUID(),
        englishName: branch,
        createdAt: now,
        updatedAt: now,


      };
      await this.github.createVaultOnDefaultBranch(repository, metadata);
      vaultId = metadata.vaultId;


      // The metadata check and the marker commit are not atomic. If another
      // device claimed the branch in between, follow the winner's identity.
      const committed = await this.github.getVaultMetadata(repository, branch);
      if (committed && committed.vaultId !== metadata.vaultId) {
        this.addActivity("warning", `Another device bound ${branch} at the same time; following its vault identity`);
        vaultId = committed.vaultId;


      } else {
        this.addActivity("bind", `Using ${branch} as the vault`);
      }
    }
    this.settings.binding = { repository, vaultId, branch, boundAt: now };

    this.settings.baseManifest = {};
    delete this.settings.pendingReview;
    await this.saveSettings();
    await this.performSync();
  }

  async joinVault(repository: RepositoryRef, vault: RemoteVaultSummary): Promise<void> {
    return this.enqueueOperation(() => this.joinVaultInternal(repository, vault));
  }

  private async joinVaultInternal(repository: RepositoryRef, vault: RemoteVaultSummary): Promise<void> {
    if (this.settings.binding) throw new Error("This Obsidian vault is already bound to a GitHub branch.");
    const canonical = await this.github.findVaultById(repository, vault.metadata.vaultId);
    if (!canonical) throw new Error("The selected vault branch no longer exists.");
    this.settings.binding = {
      repository,
      vaultId: canonical.metadata.vaultId,
      branch: canonical.branch.name,

      boundAt: new Date().toISOString()
    };

    this.settings.baseManifest = {};
    delete this.settings.pendingReview;
    this.addActivity("bind", `Joined vault branch ${canonical.branch.name}`);
    await this.saveSettings();
    await this.performSync();
  }

  async renameVault(englishName: string): Promise<void> {
    return this.enqueueOperation(() => this.renameVaultInternal(englishName));
  }

  private async renameVaultInternal(englishName: string): Promise<void> {
    const binding = this.requireBinding();
    if (this.settings.conflicts.some((item) => !item.resolved)) throw new Error("Resolve current conflicts before renaming the branch.");
    await this.performSync();
    if (this.settings.pendingReview) throw new Error("Review the pending sync before renaming the branch.");
    const next = branchFromEnglishName(englishName, binding.repository.defaultBranch);
    if (next === binding.branch) return;
    const branches = await this.github.listBranches(binding.repository);
    if (branches.some((item) => item.name === next)) throw new Error(`Branch ${next} already exists.`);

    this.setStatus("syncing", `Renaming ${binding.branch} to ${next}…`);
    const previous = binding.branch;
    const renamed = await this.github.renameBranch(binding.repository, previous, next);
    binding.branch = next;
    binding.baseCommitOid = renamed.headOid;
    await this.saveSettings();
    try {
      const metadata = await this.github.getVaultMetadata(binding.repository, next);
      if (!metadata || metadata.vaultId !== binding.vaultId) throw new Error("Vault identity marker is missing after branch rename.");
      metadata.englishName = next;
      metadata.updatedAt = new Date().toISOString();
      const commit = await this.github.updateVaultMetadata(binding.repository, next, renamed.headOid, metadata);
      binding.baseCommitOid = commit;
      this.addActivity("rename", `Renamed ${previous} to ${next}`, commit);
      await this.saveSettings();
      this.setStatus("idle", `Branch renamed to ${next}`);
    } catch (error) {
      this.addActivity("warning", `Branch is ${next}; metadata repair will retry automatically`);
      await this.saveSettings();
      this.handleError(error);
      throw error;
    }
  }

  async syncNow(): Promise<void> {
    return this.enqueueOperation(() => this.performSync(false));
  }

  /** Scheduled and focus-triggered syncs run silently in the background. */
  private syncQuietly(): Promise<void> {
    return this.enqueueOperation(() => this.performSync(true));
  }

  async approvePendingSync(): Promise<void> {
    return this.enqueueOperation(() => this.approvePendingSyncInternal());
  }

  private async approvePendingSyncInternal(): Promise<void> {
    const pending = this.settings.pendingReview?.plan;
    if (!pending) return;
    try {
      const binding = await this.reconcileBinding();
      const fresh = await this.engine.createPlan(binding, this.settings.baseManifest);
      if (fresh.id !== pending.id) {
        if (fresh.operations.length === 0 && fresh.largeFileWarnings.length === 0 && !fresh.deletionGuardTriggered) {
          // A previous attempt may have committed successfully before the final
          // verification request observed the new remote head. Finalize the
          // no-op plan locally instead of asking the user to upload everything again.
          await this.executePlan(binding, fresh, {
            planId: fresh.id,
            confirmInitialMerge: true,
            confirmMassDeletion: true,
            confirmLargeFiles: true
          });
          return;
        }
        this.settings.pendingReview = { plan: fresh };
        await this.saveSettings();
        this.setStatus("needs-review", "The sync preview changed; review the updated plan");
        return;
      }
      await this.executePlan(binding, fresh, {
        planId: fresh.id,
        confirmInitialMerge: true,
        confirmMassDeletion: true,
        confirmLargeFiles: true
      });
    } catch (error) {
      if (error instanceof SyncChangedDuringRunError) {
        await this.recoverPendingSyncAfterRemoteChange();
        return;
      }
      this.handleError(error);
      throw error;
    }
  }

  async cancelPendingSync(): Promise<void> {
    return this.enqueueOperation(() => this.cancelPendingSyncInternal());
  }

  private async cancelPendingSyncInternal(): Promise<void> {
    delete this.settings.pendingReview;
    await this.saveSettings();
    this.setStatus(this.settings.paused ? "paused" : "idle", "Pending sync cancelled");
  }

  async resolveConflict(id: string): Promise<void> {
    const conflict = this.settings.conflicts.find((item) => item.id === id);
    if (!conflict) return;
    conflict.resolved = true;
    await this.saveSettings();
    this.setStatus(this.settings.conflicts.some((item) => !item.resolved) ? "conflict" : "idle", "Conflict status updated");
  }

  async updateSyncedConfigPaths(paths: string[]): Promise<void> {
    return this.enqueueOperation(async () => {
      this.settings.syncedConfigPaths = [...new Set(paths)];
      this.vaultStore.setSyncedConfigPaths(this.settings.syncedConfigPaths);
      await this.saveSettings();
      this.scheduleLocalSync();
    });
  }

  async scanConfigFiles(): Promise<ConfigFileInfo[]> {
    const configDir = this.app.vault.configDir;
    const selected = new Set(this.settings.syncedConfigPaths);
    const rows: ConfigFileInfo[] = [];
    const push = (path: string, isDir: boolean, disabled: boolean): void => {
      rows.push({ path, isDir, disabled, selected: !disabled && selected.has(path) });
    };

    const listing = await this.app.vault.adapter.list(configDir);
    for (const filePath of listing.files) {
      const relative = filePath.slice(configDir.length + 1);
      // Workspace layout and plugin sync are always excluded, so they stay
      // out of the picker entirely.
      if (!/^workspace.*\.json$/i.test(relative) && relative !== "community-plugins.json") {
        push(relative, false, false);
      }
    }
    for (const folderPath of listing.folders) {
      const relative = `${folderPath.slice(configDir.length + 1)}/`;
      if (relative === "cache/" || relative === "plugins/") continue;
      push(relative, true, false);
    }
    return rows.sort((left, right) => left.path.localeCompare(right.path));
  }

  async updatePreference<K extends "autoSync" | "paused" | "deviceName" | "locale" | "remotePollMs" | "localDebounceMs">(
    key: K,
    value: K extends "autoSync" | "paused"
      ? boolean
      : K extends "locale"
        ? LocaleSetting
        : K extends "remotePollMs" | "localDebounceMs"
          ? number
          : string
  ): Promise<void> {
    return this.enqueueOperation(() => this.updatePreferenceInternal(key, value));
  }

  private async updatePreferenceInternal<K extends "autoSync" | "paused" | "deviceName" | "locale" | "remotePollMs" | "localDebounceMs">(
    key: K,
    value: K extends "autoSync" | "paused"
      ? boolean
      : K extends "locale"
        ? LocaleSetting
        : K extends "remotePollMs" | "localDebounceMs"
          ? number
          : string
  ): Promise<void> {
    if (key === "autoSync" || key === "paused") {
      if (key === "autoSync") this.settings.autoSync = value as boolean;
      else this.settings.paused = value as boolean;
    } else if (key === "locale") {
      this.settings.locale = value as LocaleSetting;
    } else if (key === "remotePollMs") {
      this.settings.remotePollMs = normalizePollInterval(value);
    } else if (key === "localDebounceMs") {
      this.settings.localDebounceMs = normalizeLocalDebounce(value);
    } else {
      const name = String(value).trim().slice(0, 32);
      if (!name) throw new Error("Device name cannot be empty.");
      this.settings.deviceName = name;
    }
    await this.saveSettings();
    this.setStatus(this.settings.paused ? "paused" : "idle", this.settings.paused ? "Paused" : "Ready");
    if (key === "autoSync" && value === true) this.scheduleLocalSync();
  }

  async disconnectVault(): Promise<void> {
    return this.enqueueOperation(() => this.disconnectVaultInternal());
  }

  private async disconnectVaultInternal(): Promise<void> {
    const branch = this.settings.binding?.branch;
    delete this.settings.binding;
    delete this.settings.pendingReview;
    this.settings.baseManifest = {};
    this.remoteVaults = [];
    this.addActivity("warning", `Disconnected this device${branch ? ` from ${branch}` : ""}`);
    await this.saveSettings();
    this.setStatus("unconfigured", "Vault not bound");
  }

  async signOut(): Promise<void> {
    return this.enqueueOperation(() => this.signOutInternal());
  }

  private async signOutInternal(): Promise<void> {
    this.auth.signOut();
    delete this.settings.account;
    this.repositories = [];
    this.remoteVaults = [];
    delete this.selectedRepository;
    await this.saveSettings();
    this.setStatus("unconfigured", "GitHub disconnected");
  }

  private async initializeSession(): Promise<void> {
    if (!this.auth.getSession()) {
      this.setStatus("unconfigured", "Connect GitHub to begin");
      return;
    }
    try {
      this.settings.account = await this.github.getAccount();
      await this.saveSettings();
      if (this.settings.binding && !this.settings.paused) await this.pollImmediately();
      else await this.refreshRepositories();
      this.maybeRefreshStorageUsage();
    } catch (error) {
      this.handleError(error);
    }
  }

  private maybeRefreshStorageUsage(): void {
    if (!this.settings.binding || !this.settings.account) return;
    const checkedAt = this.settings.storageUsage?.checkedAt;
    if (checkedAt && Date.now() - Date.parse(checkedAt) < STORAGE_REFRESH_MS) return;
    void this.enqueueOperation(async () => {
      try {
        const binding = this.settings.binding;
        if (!binding) return;
        const sizeKb = await this.github.getRepositorySize(binding.repository);
        this.settings.storageUsage = { sizeKb, checkedAt: new Date().toISOString() };
        await this.saveSettings();
      } catch {
        // The gauge is informational; API failures surface through normal sync handling.
      }
    });
  }

  private async recoverPendingSyncAfterRemoteChange(): Promise<void> {
    const pending = this.settings.pendingReview?.plan;
    if (!pending) return;
    const binding = await this.reconcileBinding();
    const fresh = await this.engine.createPlan(binding, this.settings.baseManifest);
    if (fresh.operations.length === 0 && fresh.largeFileWarnings.length === 0 && !fresh.deletionGuardTriggered) {
      await this.executePlan(binding, fresh, {
        planId: fresh.id,
        confirmInitialMerge: true,
        confirmMassDeletion: true,
        confirmLargeFiles: true
      });
      return;
    }
    this.settings.pendingReview = { plan: fresh };
    await this.saveSettings();
    this.setStatus("needs-review", "The remote changed; review the updated sync plan");
  }

  private async performSync(quiet = false): Promise<void> {
    if (!this.settings.binding) throw new Error("No vault branch is bound.");
    if (!this.settings.account) throw new Error("Connect GitHub before synchronizing.");
    if (this.settings.paused) {
      this.setStatus("paused", "Paused");
      return;
    }
    if (this.settings.pendingReview) {
      this.setStatus("needs-review", "Review required before files are changed");
      return;
    }
    try {
      if (!quiet) this.setStatus("scanning", "Comparing local and remote files…");
      const binding = await this.reconcileBinding();
      const plan = await this.engine.createPlan(binding, this.settings.baseManifest);
      // Skipped files are reported, never a gate: a single unportable name used
      // to hold the entire vault hostage with no way to proceed.
      const reviewRequired =
        (plan.initial && plan.operations.length > 0) ||
        plan.deletionGuardTriggered ||
        plan.largeFileWarnings.length > 0;
      if (reviewRequired) {
        this.settings.pendingReview = { plan };
        await this.saveSettings();
        this.setStatus("needs-review", "Review required before files are changed");
        return;
      }
      await this.executePlan(binding, plan, {
        planId: plan.id,
        confirmInitialMerge: false,
        confirmMassDeletion: false,
        confirmLargeFiles: false
      }, quiet);
    } catch (error) {
      if (error instanceof SyncChangedDuringRunError) {
        if (!quiet) this.setStatus("scanning", "Files changed during sync; retrying with a fresh plan");
        this.scheduleLocalSync();
        return;
      }
      if (error instanceof SyncReviewRequiredError) {
        this.settings.pendingReview = { plan: error.plan };
        await this.saveSettings();
        this.setStatus("needs-review", error.message);
        return;
      }
      this.handleError(error);
      throw error;
    }
  }

  private async executePlan(
    binding: NonNullable<PluginSettings["binding"]>,
    plan: NonNullable<PluginSettings["pendingReview"]>["plan"],
    approval: SyncApproval,
    quiet = false
  ): Promise<void> {
    if (!quiet) this.setStatus("syncing", "Synchronizing files…");
    const execution = await this.engine.execute(binding, plan, approval, this.settings.deviceName);
    binding.baseCommitOid = execution.baseCommitOid;
    this.settings.baseManifest = execution.manifest;
    this.reportSkippedFiles(plan.blockedFiles);
    this.settings.conflicts.push(...execution.conflicts);
    this.settings.conflicts = this.settings.conflicts.slice(-200);
    const unresolved = this.settings.conflicts.some((item) => !item.resolved);
    const message = unresolved ? "Synchronization completed with preserved conflicts" : "Up to date";
    delete this.settings.pendingReview;
    // A routine check that found nothing on either side stays invisible: no
    // disk write, no re-render, and "last successful sync" keeps pointing at
    // the last time real changes were carried over.
    if (execution.result.kind === "noop") {
      if (!quiet) {
        await this.saveSettings();
        this.setStatus(unresolved ? "conflict" : "idle", message);
      } else {
        const baseMoved = Boolean(
          this.settings.binding && execution.baseCommitOid !== this.settings.binding.baseCommitOid
        );
        const shouldClearError = this.status.kind === "error";
        if (baseMoved || shouldClearError) {
          // Persist a corrected base commit once so a lagging replica from a
          // previous run cannot keep misclassifying remote config changes as
          // conflicts, and let a quiet check clear a stale error status.
          await this.saveSettings();
          if (shouldClearError) {
            this.setStatus(this.settings.paused ? "paused" : "idle", this.settings.paused ? "Paused" : "Ready");
          }
        }
      }
      return;
    }
    this.settings.lastSuccessAt = new Date().toISOString();
    delete this.settings.pendingReview;
    this.addActivity("sync", `Synchronized ${plan.operations.length} changes`, execution.result.commitOid, plan.summary);
    await this.saveSettings();
    this.setStatus(unresolved ? "conflict" : "idle", message);
    this.maybeRefreshStorageUsage();
  }

  private reportSkippedFiles(paths: string[]): void {
    const previous = this.settings.skippedFiles;
    const changed = paths.length !== previous.length || paths.some((path, index) => path !== previous[index]);
    this.settings.skippedFiles = [...paths];
    if (changed && paths.length > 0) {
      this.addActivity("warning", `Skipped ${paths.length} file(s) that cannot sync safely on every platform`);
    }
  }

  private async reconcileBinding(): Promise<NonNullable<PluginSettings["binding"]>> {
    const binding = this.requireBinding();
    const canonical = await this.github.getRepository(binding.repository.owner, binding.repository.name);
    if (canonical.id !== binding.repository.id) throw new Error("The bound repository identity changed.");
    binding.repository = canonical;

    let branch = binding.branch;
    try {
      await this.github.getBranchHead(binding.repository, branch);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      const found = await this.github.findVaultById(binding.repository, binding.vaultId);
      if (!found) throw new Error("The vault branch was renamed or deleted and its stable vaultId could not be found.");
      branch = found.branch.name;
      const normalized = slugifyEnglishName(branch);
      if (validateBranchName(normalized, binding.repository.defaultBranch)) {
        throw new Error(`The externally renamed branch ${branch} cannot be repaired automatically.`);
      }
      if (normalized !== branch) {
        const branches = await this.github.listBranches(binding.repository);
        if (branches.some((item) => item.name === normalized)) throw new Error(`Cannot normalize ${branch}; ${normalized} already exists.`);
        const renamed = await this.github.renameBranch(binding.repository, branch, normalized);
        branch = normalized;
        binding.baseCommitOid = renamed.headOid;
      }
      binding.branch = branch;
      this.addActivity("rename", `Followed external branch rename to ${branch}`);
    }

    const metadata = await this.github.getVaultMetadata(binding.repository, branch);
    if (!metadata || metadata.vaultId !== binding.vaultId) throw new Error("The remote vault marker does not match this local binding.");
    if (metadata.englishName !== branch) {
      const repaired = await this.commitVaultMetadata(binding, (current) => {
        current.englishName = branch;
        current.updatedAt = new Date().toISOString();
      });
      binding.baseCommitOid = repaired.commitOid;
      this.addActivity("rename", `Repaired vault metadata for ${branch}`, binding.baseCommitOid);
    }
    await this.saveSettings();
    return binding;
  }


   /**
   * Rewrites the shared vault marker. GitHub can report a stale head right after
   * a write, so a rejected commit is re-read and replayed rather than surfaced.
   */
  private async commitVaultMetadata(
    binding: NonNullable<PluginSettings["binding"]>,
    mutate: (metadata: VaultMetadata) => void
  ): Promise<{ commitOid: string; metadata: VaultMetadata }> {
    for (let attempt = 0; ; attempt += 1) {
      const metadata = await this.github.getVaultMetadata(binding.repository, binding.branch);
      if (!metadata || metadata.vaultId !== binding.vaultId) throw new Error("Remote vault metadata could not be verified.");
      const head = await this.github.getBranchHeadForCommit(binding.repository, binding.branch);
      mutate(metadata);
      try {
        const commitOid = await this.github.updateVaultMetadata(binding.repository, binding.branch, head, metadata);
        return { commitOid, metadata };
      } catch (error) {
        if (attempt >= 3 || !isStaleHeadError(error)) throw error;
        await sleep(400 * 2 ** attempt);
      }
    }
  }

  private async verifyBinding(): Promise<void> {
    try {
      const binding = await this.reconcileBinding();
      new Notice(`Constellation Sync: ${binding.repository.fullName}/${binding.branch} verified.`);
      this.setStatus("idle", "Repository binding verified");
    } catch (error) {
      this.handleError(error);
      new Notice(`Constellation Sync: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleLocalSync(): void {
    if (!this.settings.autoSync || this.settings.paused || !this.settings.binding || !this.settings.account) return;
    if (this.localTimer !== null) window.clearTimeout(this.localTimer);
    this.localTimer = window.setTimeout(() => {
      this.localTimer = null;
      void this.syncQuietly().catch(() => undefined);
    }, this.settings.localDebounceMs);
  }

  private async maybePollRemote(): Promise<void> {
    if (document.visibilityState !== "visible" || !this.settings.autoSync || this.settings.paused) return;
    if (Date.now() - this.lastRemotePollAt < this.settings.remotePollMs) return;
    await this.pollImmediately();
  }

  private async pollImmediately(): Promise<void> {
    this.lastRemotePollAt = Date.now();
    if (!this.settings.binding || !this.settings.account || this.settings.pendingReview) return;
    await this.syncQuietly().catch(() => undefined);
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(
      () => operation(),
      () => operation()
    );
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private requireBinding(): NonNullable<PluginSettings["binding"]> {
    if (!this.settings.binding) throw new Error("No vault branch is bound.");
    return this.settings.binding;
  }

  private localVaultName(): string {
    return this.app.vault.getName().trim() || "vault";
  }

  private suggestedLocalBranch(defaultBranch = "main"): string | undefined {
    const candidate = slugifyEnglishName(this.localVaultName());
    return candidate && !validateBranchName(candidate, defaultBranch) ? candidate : undefined;
  }

  private addActivity(
    kind: PluginSettings["activity"][number]["kind"],
    message: string,
    commitOid?: string,
    counts?: PluginSettings["activity"][number]["counts"]
  ): void {
    this.settings.activity.push({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      kind,
      message,
      ...(commitOid ? { commitOid } : {}),
      ...(counts ? { counts } : {})
    });
    this.settings.activity = this.settings.activity.slice(-500);
  }

  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.emit();
  }

  private setStatus(kind: RuntimeStatus["kind"], message: string, errorCode?: string): void {
    const lastSuccessAt = this.settings.lastSuccessAt;
    // Emitting an identical status re-renders the whole dashboard for nothing,
    // which is exactly the flicker a routine background sync used to cause.
    if (
      this.status.kind === kind &&
      this.status.message === message &&
      this.status.errorCode === errorCode &&
      this.status.lastSuccessAt === lastSuccessAt
    ) return;
    this.status = {
      kind,
      message,
      ...(lastSuccessAt ? { lastSuccessAt } : {}),
      ...(errorCode ? { errorCode } : {})
    };
    if (this.statusBar) this.statusBar.setText(`Constellation: ${message}`);
    this.emit();
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    let kind: RuntimeStatus["kind"] = "error";
    let code = "unknown";
    if (error instanceof GitHubAuthError) {
      code = error.code;
      kind = error.code.includes("expired") || error.code === "not-authenticated" ? "reauth-required" : "error";
    } else if (error instanceof GitHubApiError) {
      code = error.code;
      if (error.code === "rate-limited") kind = "rate-limited";
      else if (error.status === 401) kind = "reauth-required";
      else if (error.status === 0) kind = "offline";
    }
    if (kind === "reauth-required") {
      // A dead token cannot recover by itself; showing the token screen again is
      // the only way forward, so the connected account must not keep it hidden.
      delete this.settings.account;
    }
    this.addActivity("error", `${code}: ${message}`);
    void this.saveSettings();
    this.setStatus(kind, message, code);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isReferenceAlreadyExistsError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && error.status === 422 && /reference already exists/i.test(error.message);
}
