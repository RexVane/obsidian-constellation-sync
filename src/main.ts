import { Notice, Plugin } from "obsidian";
import { GitHubAuth, GitHubAuthError, type SecretStore } from "./auth/github-auth";
import type { DashboardController, DashboardSnapshot } from "./controller";
import { GitHubApiError, GitHubClient } from "./github/github-client";
import { createDefaultSettings, loadSettings } from "./settings";
import { SyncBlockedError, SyncChangedDuringRunError, SyncEngine, SyncReviewRequiredError } from "./sync/engine";
import { ObsidianVaultStore } from "./sync/vault-store";
import {
  SCHEMA_VERSION,
  type CommitSummary,
  type DeviceCode,
  type LocaleSetting,
  type PluginSettings,
  type RemoteVaultSummary,
  type RepositoryRef,
  type RuntimeStatus,
  type SyncApproval,
  type VaultMetadata
} from "./types";
import { branchFromEnglishName, slugifyEnglishName, validateBranchName } from "./utils/branch";
import { normalizeRepoPath, shouldSyncPath } from "./utils/path";
import { ConstellationDashboardView, DASHBOARD_VIEW_TYPE } from "./ui/dashboard-view";
import { ConstellationSettingTab } from "./ui/settings-tab";

const APP_CONFIG = {
  clientId: __GITHUB_CLIENT_ID__,
  appSlug: __GITHUB_APP_SLUG__,
  installUrl: __GITHUB_INSTALL_URL__
};

export default class ConstellationSyncPlugin extends Plugin implements DashboardController {
  override settings: PluginSettings = createDefaultSettings();
  private status: RuntimeStatus = { kind: "unconfigured", message: "Not configured" };
  private auth!: GitHubAuth;
  private github!: GitHubClient;
  private engine!: SyncEngine;
  private readonly listeners = new Set<() => void>();
  private repositories: RepositoryRef[] = [];
  private remoteVaults: RemoteVaultSummary[] = [];
  private selectedRepository?: RepositoryRef;
  private deviceCode?: DeviceCode;
  private commits: CommitSummary[] = [];
  private loginAbort?: AbortController;
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
    this.auth = new GitHubAuth(APP_CONFIG, secretStore);
    this.github = new GitHubClient(this.auth);
    this.engine = new SyncEngine(this.github, new ObsidianVaultStore(this.app));

    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new ConstellationDashboardView(leaf, this));
    this.addRibbonIcon("orbit", "Constellation Sync", () => void this.activateView());
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({ id: "pause-auto-sync", name: "Pause automatic sync", callback: () => void this.updatePreference("paused", true) });
    this.addCommand({ id: "resume-auto-sync", name: "Resume automatic sync", callback: () => void this.updatePreference("paused", false) });
    this.addCommand({ id: "open-conflicts", name: "Open conflicts", callback: () => void this.activateView() });
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
    this.registerInterval(window.setInterval(() => void this.maybePollRemote(), 15_000));

    this.setStatus(this.settings.paused ? "paused" : "idle", this.settings.paused ? "Paused" : "Ready");
    void this.initializeSession();
  }

  override onunload(): void {
    this.loginAbort?.abort();
    if (this.localTimer !== null) window.clearTimeout(this.localTimer);
  }

  snapshot(): DashboardSnapshot {
    const localVaultName = this.localVaultName();
    const suggestedBranch = this.suggestedLocalBranch();
    return {
      settings: structuredClone(this.settings),
      status: { ...this.status },
      githubConfigured: this.auth.isConfigured(),
      appInstallUrl: APP_CONFIG.installUrl,
      ...(this.deviceCode ? { deviceCode: { ...this.deviceCode } } : {}),
      repositories: [...this.repositories],
      ...(this.selectedRepository ? { selectedRepository: { ...this.selectedRepository } } : {}),
      remoteVaults: structuredClone(this.remoteVaults),
      localVaultName,
      ...(suggestedBranch ? { suggestedBranch } : {}),
      commits: [...this.commits],
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

  async startLogin(): Promise<void> {
    this.loginAbort?.abort();
    this.loginAbort = new AbortController();
    this.setStatus("syncing", "Requesting GitHub device code…");
    this.deviceCode = await this.auth.beginDeviceFlow();
    this.emit();
    this.openExternal(this.deviceCode.verificationUri);
    try {
      await this.auth.pollDeviceFlow(this.deviceCode, this.loginAbort.signal);
      delete this.deviceCode;
      this.settings.account = await this.github.getAccount();
      this.addActivity("login", `Connected GitHub account @${this.settings.account.login}`);
      await this.saveSettings();
      await this.refreshRepositories();
      this.setStatus("idle", "GitHub connected");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      delete this.deviceCode;
      this.handleError(error);
      throw error;
    }
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
    delete this.deviceCode;
    this.setStatus("idle", "GitHub sign-in cancelled");
  }

  openExternal(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("Only HTTPS github.com links can be opened.");
    window.open(parsed.toString(), "_blank", "noopener,noreferrer");
  }

  async refreshRepositories(): Promise<void> {
    this.setStatus("scanning", "Loading private repositories…");
    try {
      const page = await this.github.listAccessiblePrivateRepositories();
      this.repositories = page.repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
      if (this.selectedRepository) {
        const nextSelected = this.repositories.find((item) => item.id === this.selectedRepository?.id);
        if (nextSelected) this.selectedRepository = nextSelected;
        else delete this.selectedRepository;
      }
      this.setStatus("idle", `Found ${this.repositories.length} private repositories`);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async selectRepository(repository: RepositoryRef): Promise<void> {
    return this.enqueueOperation(() => this.selectRepositoryInternal(repository));
  }

  private async selectRepositoryInternal(repository: RepositoryRef): Promise<void> {
    if (!repository.private) throw new Error("Constellation Sync refuses public repositories.");
    this.selectedRepository = repository;
    this.setStatus("scanning", `Scanning ${repository.fullName}…`);
    try {
      this.remoteVaults = await this.github.discoverVaults(repository);
      if (!this.settings.binding) {
        const suggestedBranch = this.suggestedLocalBranch(repository.defaultBranch);
        const matchingVault = suggestedBranch ? this.remoteVaults.find((vault) => vault.branch.name === suggestedBranch) : undefined;
        if (suggestedBranch && !matchingVault) {
          const branches = await this.github.listBranches(repository);
          if (!branches.some((branch) => branch.name === suggestedBranch)) {
            await this.createVaultInternal(repository, suggestedBranch);
            return;
          }
          this.setStatus("idle", `Detected branch ${suggestedBranch} already exists without a vault marker`);
          return;
        }
      }
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
    if (!repository.private) throw new Error("Constellation Sync refuses public repositories.");
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
      policyRevision: 1,
      syncPolicy: structuredClone(this.settings.policy)
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
      this.settings.policy = structuredClone(existing.syncPolicy);
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

  async joinVault(repository: RepositoryRef, vault: RemoteVaultSummary): Promise<void> {
    return this.enqueueOperation(() => this.joinVaultInternal(repository, vault));
  }

  private async joinVaultInternal(repository: RepositoryRef, vault: RemoteVaultSummary): Promise<void> {
    if (!repository.private) throw new Error("Constellation Sync refuses public repositories.");
    if (this.settings.binding) throw new Error("This Obsidian vault is already bound to a GitHub branch.");
    const canonical = await this.github.findVaultById(repository, vault.metadata.vaultId);
    if (!canonical) throw new Error("The selected vault branch no longer exists.");
    this.settings.binding = {
      repository,
      vaultId: canonical.metadata.vaultId,
      branch: canonical.branch.name,
      boundAt: new Date().toISOString()
    };
    this.settings.policy = structuredClone(canonical.metadata.syncPolicy);
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
    return this.enqueueOperation(() => this.performSync());
  }

  async approvePendingSync(): Promise<void> {
    return this.enqueueOperation(() => this.approvePendingSyncInternal());
  }

  private async approvePendingSyncInternal(): Promise<void> {
    const pending = this.settings.pendingReview?.plan;
    if (!pending) return;
    try {
      const binding = await this.reconcileBinding();
      const fresh = await this.engine.createPlan(binding, this.settings.policy, this.settings.baseManifest);
      if (fresh.id !== pending.id) {
        if (fresh.operations.length === 0 && fresh.blockedFiles.length === 0 && fresh.largeFileWarnings.length === 0 && !fresh.deletionGuardTriggered) {
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

  async loadHistory(page = 1): Promise<void> {
    const binding = this.requireBinding();
    this.commits = await this.github.listCommits(binding.repository, binding.branch, page);
    this.emit();
  }

  async restoreFile(path: string, commitOid: string): Promise<void> {
    const binding = this.requireBinding();
    if (this.settings.pendingReview) throw new Error("Complete or cancel the pending sync before restoring a file.");
    const normalized = normalizeRepoPath(path);
    if (!shouldSyncPath(normalized, this.settings.policy, this.app.vault.configDir)) {
      throw new Error("That path is outside the enabled sync policy.");
    }
    const bytes = await this.github.getFileAtCommit(binding.repository, normalized, commitOid);
    await new ObsidianVaultStore(this.app).write(normalized, bytes);
    this.addActivity("restore", `Restored ${normalized} from ${commitOid.slice(0, 8)}`);
    await this.saveSettings();
    await this.syncNow();
  }

  async updatePreference<K extends "autoSync" | "paused" | "deviceName" | "locale">(
    key: K,
    value: K extends "autoSync" | "paused" ? boolean : K extends "locale" ? LocaleSetting : string
  ): Promise<void> {
    if (key === "autoSync" || key === "paused") {
      if (key === "autoSync") this.settings.autoSync = value as boolean;
      else this.settings.paused = value as boolean;
    } else if (key === "locale") {
      this.settings.locale = value as LocaleSetting;
    } else {
      const name = String(value).trim().slice(0, 32);
      if (!name) throw new Error("Device name cannot be empty.");
      this.settings.deviceName = name;
    }
    await this.saveSettings();
    this.setStatus(this.settings.paused ? "paused" : "idle", this.settings.paused ? "Paused" : "Ready");
    if (key === "autoSync" && value === true) this.scheduleLocalSync();
  }

  async updateObsidianPolicy(key: "coreSettings" | "themesAndSnippets", value: boolean): Promise<void> {
    this.settings.policy.obsidian[key] = value;
    await this.persistSharedPolicy();
  }

  async updateIgnorePatterns(value: string): Promise<void> {
    this.settings.policy.ignorePatterns = value.split(/\r?\n/).map((line) => line.trimEnd());
    await this.persistSharedPolicy();
  }

  async disconnectVault(): Promise<void> {
    const branch = this.settings.binding?.branch;
    delete this.settings.binding;
    delete this.settings.pendingReview;
    this.settings.baseManifest = {};
    this.remoteVaults = [];
    this.commits = [];
    this.addActivity("warning", `Disconnected this device${branch ? ` from ${branch}` : ""}`);
    await this.saveSettings();
    this.setStatus("unconfigured", "Vault not bound");
  }

  async signOut(): Promise<void> {
    this.auth.signOut();
    delete this.settings.account;
    this.repositories = [];
    this.remoteVaults = [];
    delete this.selectedRepository;
    await this.saveSettings();
    this.setStatus("unconfigured", "GitHub disconnected");
  }

  private async initializeSession(): Promise<void> {
    if (!this.auth.isConfigured()) {
      this.setStatus("unconfigured", "GitHub App build configuration required");
      return;
    }
    if (!this.auth.getSession()) {
      this.setStatus("unconfigured", "Connect GitHub to begin");
      return;
    }
    try {
      this.settings.account = await this.github.getAccount();
      await this.saveSettings();
      if (this.settings.binding && !this.settings.paused) await this.pollImmediately();
      else await this.refreshRepositories();
    } catch (error) {
      this.handleError(error);
    }
  }

  private async recoverPendingSyncAfterRemoteChange(): Promise<void> {
    const pending = this.settings.pendingReview?.plan;
    if (!pending) return;
    const binding = await this.reconcileBinding();
    const fresh = await this.engine.createPlan(binding, this.settings.policy, this.settings.baseManifest);
    if (fresh.operations.length === 0 && fresh.blockedFiles.length === 0 && fresh.largeFileWarnings.length === 0 && !fresh.deletionGuardTriggered) {
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

  private async performSync(): Promise<void> {
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
      this.setStatus("scanning", "Comparing local and remote files…");
      const binding = await this.reconcileBinding();
      const plan = await this.engine.createPlan(binding, this.settings.policy, this.settings.baseManifest);
      const reviewRequired =
        plan.blockedFiles.length > 0 ||
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
      });
    } catch (error) {
      if (error instanceof SyncChangedDuringRunError) {
        this.setStatus("scanning", "Files changed during sync; retrying with a fresh plan");
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
    approval: SyncApproval
  ): Promise<void> {
    this.setStatus("syncing", "Synchronizing files…");
    const execution = await this.engine.execute(binding, this.settings.policy, plan, approval, this.settings.deviceName);
    binding.baseCommitOid = execution.baseCommitOid;
    this.settings.baseManifest = execution.manifest;
    this.settings.conflicts.push(...execution.conflicts);
    this.settings.conflicts = this.settings.conflicts.slice(-200);
    this.settings.lastSuccessAt = new Date().toISOString();
    delete this.settings.pendingReview;
    this.addActivity(
      "sync",
      execution.result.kind === "noop" ? "No changes; local and remote are aligned" : `Synchronized ${plan.operations.length} changes`,
      execution.result.commitOid,
      plan.summary
    );
    await this.saveSettings();
    const unresolved = this.settings.conflicts.some((item) => !item.resolved);
    this.setStatus(unresolved ? "conflict" : "idle", unresolved ? "Synchronization completed with preserved conflicts" : "Up to date");
  }

  private async reconcileBinding(): Promise<NonNullable<PluginSettings["binding"]>> {
    const binding = this.requireBinding();
    const canonical = await this.github.getRepository(binding.repository.owner, binding.repository.name);
    if (canonical.id !== binding.repository.id) throw new Error("The bound repository identity changed.");
    if (!canonical.private) throw new Error("The bound repository is public. Synchronization is blocked.");
    binding.repository = { ...canonical, ...(binding.repository.installationId ? { installationId: binding.repository.installationId } : {}) };

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
    this.settings.policy = structuredClone(metadata.syncPolicy);
    if (metadata.englishName !== branch) {
      metadata.englishName = branch;
      metadata.updatedAt = new Date().toISOString();
      const head = await this.github.getBranchHead(binding.repository, branch);
      binding.baseCommitOid = await this.github.updateVaultMetadata(binding.repository, branch, head, metadata);
      this.addActivity("rename", `Repaired vault metadata for ${branch}`, binding.baseCommitOid);
    }
    await this.saveSettings();
    return binding;
  }

  private async persistSharedPolicy(): Promise<void> {
    const binding = this.settings.binding;
    if (!binding) {
      await this.saveSettings();
      return;
    }
    if (this.settings.pendingReview) throw new Error("Complete or cancel the pending sync before changing shared policy.");
    const metadata = await this.github.getVaultMetadata(binding.repository, binding.branch);
    if (!metadata || metadata.vaultId !== binding.vaultId) throw new Error("Remote vault metadata could not be verified.");
    const head = await this.github.getBranchHead(binding.repository, binding.branch);
    metadata.syncPolicy = structuredClone(this.settings.policy);
    metadata.policyRevision += 1;
    metadata.updatedAt = new Date().toISOString();
    binding.baseCommitOid = await this.github.updateVaultMetadata(binding.repository, binding.branch, head, metadata);
    await this.saveSettings();
    this.scheduleLocalSync();
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
      void this.syncNow().catch(() => undefined);
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
    await this.syncNow().catch(() => undefined);
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
    this.status = {
      kind,
      message,
      ...(this.settings.lastSuccessAt ? { lastSuccessAt: this.settings.lastSuccessAt } : {}),
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
    } else if (error instanceof SyncBlockedError) {
      code = "blocked-files";
      kind = "needs-review";
    }
    this.addActivity("error", `${code}: ${message}`);
    void this.saveSettings();
    this.setStatus(kind, message, code);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function isReferenceAlreadyExistsError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && error.status === 422 && /reference already exists/i.test(error.message);
}
