import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardController, DashboardSnapshot } from "../controller";
import { translator, type TranslationKey } from "../i18n";
import type { SyncPlanSummary } from "../types";

export const DASHBOARD_VIEW_TYPE = "constellation-sync-dashboard";

type Page = "overview" | "vaults" | "history" | "conflicts" | "settings" | "diagnostics";

export class ConstellationDashboardView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly controller: DashboardController
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Constellation Sync";
  }

  override getIcon(): string {
    return "orbit";
  }

  override onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("constellation-sync-host");
    render(<Dashboard controller={this.controller} />, this.contentEl);
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    render(null, this.contentEl);
    return Promise.resolve();
  }
}

function Dashboard({ controller }: { controller: DashboardController }): preact.JSX.Element {
  const snapshot = useController(controller);
  const t = translator(snapshot.settings.locale);
  const [page, setPage] = useState<Page>("overview");
  const [error, setError] = useState<string | null>(null);
  const hadBinding = useRef(Boolean(snapshot.settings.binding));

  useEffect(() => {
    const bound = Boolean(snapshot.settings.binding);
    if (bound && !hadBinding.current) setPage("overview");
    hadBinding.current = bound;
  }, [snapshot.settings.binding?.vaultId]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div class="constellation-sync">
      <header class="cs-mobile-header">
        <Brand compact />
        <select value={page} onChange={(event) => setPage(event.currentTarget.value as Page)} aria-label="Navigation">
          {NAV_ITEMS.map((item) => <option value={item.id}>{t(item.label)}</option>)}
        </select>
      </header>
      <aside class="cs-sidebar">
        <Brand />
        <nav class="cs-nav" aria-label="Constellation Sync">
          {NAV_ITEMS.map((item) => (
            <button class={page === item.id ? "is-active" : ""} onClick={() => setPage(item.id)}>
              <Icon name={item.icon} />
              <span>{t(item.label)}</span>
              {item.id === "conflicts" && unresolvedCount(snapshot) > 0 ? <Badge>{unresolvedCount(snapshot)}</Badge> : null}
            </button>
          ))}
        </nav>
        <div class="cs-sidebar-footer">
          <span class={`cs-status-dot is-${snapshot.status.kind}`} />
          <div>
            <strong>{t("status")}</strong>
            <span>{snapshot.status.message}</span>
          </div>
        </div>
      </aside>
      <main class="cs-content">
        <div class="cs-page-heading">
          <div>
            <p class="cs-kicker">Constellation Sync</p>
            <h1>{t(NAV_ITEMS.find((item) => item.id === page)?.label ?? "overview")}</h1>
          </div>
          {snapshot.settings.binding ? (
            <button class="cs-button cs-button-primary" disabled={busy(snapshot)} onClick={() => void run(() => controller.syncNow())}>
              <Icon name="refresh-cw" /> {t("syncNow")}
            </button>
          ) : null}
        </div>
        {error ? <div class="cs-alert is-error"><Icon name="circle-alert" /><span>{error}</span></div> : null}
        {!snapshot.settings.account ? (
          <LoginPanel snapshot={snapshot} controller={controller} run={run} t={t} />
        ) : !snapshot.settings.binding && page !== "settings" && page !== "diagnostics" ? (
          <VaultSetup snapshot={snapshot} controller={controller} run={run} t={t} />
        ) : (
          <PageContent page={page} snapshot={snapshot} controller={controller} run={run} t={t} />
        )}
      </main>
    </div>
  );
}

function LoginPanel(props: PanelProps): preact.JSX.Element {
  const { snapshot, controller, run, t } = props;
  return (
    <section class="cs-auth-shell">
      <div class="cs-card cs-auth-card">
        <div class="cs-orbit-mark"><Icon name="orbit" /></div>
        <p class="cs-kicker">GitHub OAuth</p>
        <h2>{t("connectGithub")}</h2>
        <p>{t("connectDescription")}</p>
        <div class="cs-alert is-warning"><Icon name="shield-alert" /><span>{t("privateNotEncrypted")}</span></div>
        {!snapshot.githubConfigured ? <div class="cs-alert is-error">{t("appNotConfigured")}</div> : null}
        {snapshot.deviceCode ? (
          <div class="cs-device-flow">
            <span>{t("userCode")}</span>
            <code>{snapshot.deviceCode.userCode}</code>
            <div class="cs-actions">
              <button class="cs-button" onClick={() => void navigator.clipboard.writeText(snapshot.deviceCode?.userCode ?? "")}>{t("copyCode")}</button>
              <button class="cs-button cs-button-primary" onClick={() => controller.openExternal(snapshot.deviceCode?.verificationUri ?? "")}>{t("openGithub")}</button>
              <button class="cs-button cs-button-quiet" onClick={() => controller.cancelLogin()}>{t("cancel")}</button>
            </div>
            <p class="cs-muted cs-pulse">{t("authorizeWaiting")}</p>
          </div>
        ) : (
          <button class="cs-button cs-button-primary" disabled={!snapshot.githubConfigured || busy(snapshot)} onClick={() => void run(() => controller.startLogin())}>
            <Icon name="github" /> {t("startLogin")}
          </button>
        )}
      </div>
    </section>
  );
}

function VaultSetup(props: PanelProps): preact.JSX.Element {
  const { snapshot, controller, run, t } = props;
  const [name, setName] = useState(snapshot.suggestedBranch ?? "");
  const selected = snapshot.selectedRepository;

  useEffect(() => {
    if (!name && snapshot.suggestedBranch) setName(snapshot.suggestedBranch);
  }, [name, snapshot.suggestedBranch]);

  return (
    <div class="cs-stack">
      <div class="cs-alert is-info"><Icon name="lock-keyhole" /><span>{t("selectRepository")} {t("repositoryPrivateOnly")}</span></div>
      <section class="cs-card">
        <div class="cs-card-header">
          <div><p class="cs-kicker">GitHub</p><h2>{t("repositories")}</h2></div>
          <div class="cs-actions">
            {snapshot.appInstallUrl ? <button class="cs-button" onClick={() => controller.openExternal(snapshot.appInstallUrl)}>{t("installApp")}</button> : null}
            <button class="cs-button" disabled={busy(snapshot)} onClick={() => void run(() => controller.refreshRepositories())}><Icon name="refresh-cw" /> {t("refresh")}</button>
          </div>
        </div>
        {snapshot.repositories.length === 0 ? <Empty>{t("noRepositories")}</Empty> : (
          <div class="cs-repo-grid">
            {snapshot.repositories.map((repository) => (
              <button class={`cs-repo-card ${selected?.id === repository.id ? "is-selected" : ""}`} onClick={() => void run(() => controller.selectRepository(repository))}>
                <Icon name="lock-keyhole" />
                <span><strong>{repository.fullName}</strong><small>{repository.defaultBranch}</small></span>
              </button>
            ))}
          </div>
        )}
      </section>
      {selected ? (
        <div class="cs-two-column">
          <section class="cs-card">
            <p class="cs-kicker">New branch</p>
            <h2>{t("createVault")}</h2>
            {snapshot.suggestedBranch ? <p class="cs-muted">{t("localVault")}: <strong>{snapshot.localVaultName}</strong> → <code>{snapshot.suggestedBranch}</code><br />{t("autoBranchHelp")}</p> : null}
            <label class="cs-field"><span>{t("englishName")}</span><input value={name} placeholder="work-notes" onInput={(event) => setName(event.currentTarget.value)} /><small>{t("branchHelp")}</small></label>
            <button class="cs-button cs-button-primary" disabled={!name.trim() || busy(snapshot)} onClick={() => void run(() => controller.createVault(selected, name))}>{t("createVault")}</button>
          </section>
          <section class="cs-card">
            <p class="cs-kicker">Existing branches</p>
            <h2>{t("vaults")}</h2>
            {snapshot.remoteVaults.length === 0 ? <Empty>{t("installRequired")}</Empty> : (
              <div class="cs-list">
                {snapshot.remoteVaults.map((vault) => (
                  <div class="cs-list-row">
                    <Icon name="git-branch" />
                    <span><strong>{vault.branch.name}</strong><small>{vault.metadata.vaultId.slice(0, 8)}</small></span>
                    <button class="cs-button" onClick={() => void run(() => controller.joinVault(selected, vault))}>{t("joinVault")}</button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PageContent(props: PanelProps & { page: Page }): preact.JSX.Element {
  if (props.page === "overview") return <Overview {...props} />;
  if (props.page === "vaults") return <VaultPage {...props} />;
  if (props.page === "history") return <HistoryPage {...props} />;
  if (props.page === "conflicts") return <ConflictsPage {...props} />;
  if (props.page === "settings") return <SettingsPage {...props} />;
  return <DiagnosticsPage {...props} />;
}

function Overview({ snapshot, controller, run, t }: PanelProps): preact.JSX.Element {
  const binding = snapshot.settings.binding;
  if (!binding) return <Empty>{t("notBound")}</Empty>;
  const pending = snapshot.settings.pendingReview?.plan;
  return (
    <div class="cs-stack">
      <div class="cs-metric-grid">
        <Metric icon="activity" label={t("status")} value={snapshot.status.message} tone="violet" />
        <Metric icon="git-branch" label={t("branch")} value={binding.branch} tone="cyan" mono />
        <Metric icon="clock-3" label={t("lastSync")} value={snapshot.settings.lastSuccessAt ? formatDate(snapshot.settings.lastSuccessAt) : t("never")} tone="orange" />
      </div>
      {pending ? (
        <section class="cs-card cs-review-card">
          <div class="cs-card-header"><div><p class="cs-kicker">Safety gate</p><h2>{t("pendingReview")}</h2></div><Badge>{pending.id.slice(0, 8)}</Badge></div>
          <p>{t("pendingReviewText")}</p>
          <PlanMetrics summary={pending.summary} t={t} />
          {pending.blockedFiles.length > 0 ? <PathList title={t("blocked")} paths={pending.blockedFiles} /> : null}
          {pending.largeFileWarnings.length > 0 ? <PathList title={t("warnings")} paths={pending.largeFileWarnings} /> : null}
          <div class="cs-actions">
            <button class="cs-button cs-button-primary" disabled={busy(snapshot)} onClick={() => void run(() => controller.approvePendingSync())}>{t("confirmSync")}</button>
            <button class="cs-button" onClick={() => void run(() => controller.cancelPendingSync())}>{t("cancelPlan")}</button>
          </div>
        </section>
      ) : (
        <section class="cs-card cs-hero-card">
          <div><p class="cs-kicker">{binding.repository.fullName}</p><h2>{binding.branch}</h2><p>{t("mobileNotice")}</p></div>
          <button class="cs-button cs-button-primary cs-button-large" disabled={busy(snapshot)} onClick={() => void run(() => controller.syncNow())}><Icon name="refresh-cw" /> {t("syncNow")}</button>
        </section>
      )}
      {snapshot.settings.skippedFiles.length > 0 ? (
        <section class="cs-card">
          <div class="cs-alert is-warning"><Icon name="triangle-alert" /><span>{t("skippedHelp")}</span></div>
          <PathList title={t("skippedTitle")} paths={snapshot.settings.skippedFiles} />
        </section>
      ) : null}
      <section class="cs-card"><div class="cs-card-header"><div><p class="cs-kicker">Recent</p><h2>{t("history")}</h2></div></div><ActivityList snapshot={snapshot} t={t} limit={8} /></section>
    </div>
  );
}

function VaultPage({ snapshot, controller, run, t }: PanelProps): preact.JSX.Element {
  const binding = snapshot.settings.binding;
  const [name, setName] = useState(binding?.branch ?? "");
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  useEffect(() => setName(binding?.branch ?? ""), [binding?.branch]);
  if (!binding) return <Empty>{t("notBound")}</Empty>;
  return (
    <div class="cs-two-column">
      <section class="cs-card">
        <p class="cs-kicker">{t("currentVault")}</p>
        <h2>{binding.branch}</h2>
        <Definition label={t("repository")} value={binding.repository.fullName} />
        <Definition label={t("branch")} value={binding.branch} mono />
        <Definition label={t("vaultId")} value={binding.vaultId} mono />
        <div class="cs-actions cs-vault-actions">
          <button class="cs-button is-danger" disabled={busy(snapshot)} onClick={() => setConfirmingDisconnect(true)}>{t("disconnect")}</button>
        </div>
        {confirmingDisconnect ? (
          <div class="cs-alert is-warning cs-confirmation" role="alertdialog" aria-live="polite">
            <span>{t("disconnectConfirm")}</span>
            <div class="cs-actions">
              <button class="cs-button" onClick={() => setConfirmingDisconnect(false)}>{t("cancel")}</button>
              <button class="cs-button is-danger" disabled={busy(snapshot)} onClick={() => {
                setConfirmingDisconnect(false);
                void run(() => controller.disconnectVault());
              }}>{t("disconnect")}</button>
            </div>
          </div>
        ) : null}
      </section>
      <section class="cs-card">
        <p class="cs-kicker">Shared identity</p>
        <h2>{t("rename")}</h2>
        <p>{t("renameHelp")}</p>
        <label class="cs-field"><span>{t("englishName")}</span><input value={name} onInput={(event) => setName(event.currentTarget.value)} /><small>{t("branchHelp")}</small></label>
        <button class="cs-button cs-button-primary" disabled={name === binding.branch || busy(snapshot)} onClick={() => void run(() => controller.renameVault(name))}>{t("rename")}</button>
      </section>
    </div>
  );
}

function HistoryPage({ snapshot, controller, run, t }: PanelProps): preact.JSX.Element {
  const [path, setPath] = useState("");
  const [commit, setCommit] = useState("");
  return (
    <div class="cs-stack">
      <section class="cs-card">
        <div class="cs-card-header"><div><p class="cs-kicker">Local activity</p><h2>{t("history")}</h2></div><button class="cs-button" onClick={() => void run(() => controller.loadHistory())}>{t("historyLoad")}</button></div>
        <ActivityList snapshot={snapshot} t={t} />
      </section>
      {snapshot.commits.length > 0 ? <section class="cs-card"><div class="cs-list">{snapshot.commits.map((entry) => <div class="cs-list-row"><Icon name="git-commit-horizontal" /><span><strong>{entry.message.split("\n")[0]}</strong><small>{entry.oid.slice(0, 8)} · {formatDate(entry.authoredAt)} · {entry.author}</small></span><button class="cs-button" onClick={() => controller.openExternal(entry.htmlUrl)}>{t("openCommit")}</button></div>)}</div></section> : null}
      <section class="cs-card">
        <p class="cs-kicker">Non-destructive restore</p><h2>{t("restore")}</h2><p>{t("restoreHelp")}</p>
        <div class="cs-form-grid"><label class="cs-field"><span>{t("restorePath")}</span><input value={path} onInput={(event) => setPath(event.currentTarget.value)} placeholder="Notes/example.md" /></label><label class="cs-field"><span>{t("restoreCommit")}</span><input value={commit} onInput={(event) => setCommit(event.currentTarget.value)} placeholder="commit SHA" /></label></div>
        <button class="cs-button cs-button-primary" disabled={!path || !commit || busy(snapshot)} onClick={() => void run(() => controller.restoreFile(path, commit))}>{t("restore")}</button>
      </section>
    </div>
  );
}

function ConflictsPage({ snapshot, controller, run, t }: PanelProps): preact.JSX.Element {
  const conflicts = snapshot.settings.conflicts.filter((item) => !item.resolved);
  return <section class="cs-card">{conflicts.length === 0 ? <Empty>{t("noConflicts")}</Empty> : <div class="cs-list">{conflicts.map((item) => <div class="cs-list-row cs-conflict-row"><Icon name="triangle-alert" /><span><strong>{item.path}</strong><small>{item.reason}{item.conflictPath ? ` · ${item.conflictPath}` : ""} · {formatDate(item.createdAt)}</small></span><button class="cs-button" onClick={() => void run(() => controller.resolveConflict(item.id))}>{t("markResolved")}</button></div>)}</div>}</section>;
}

function SettingsPage({ snapshot, controller, run, t }: PanelProps): preact.JSX.Element {
  const settings = snapshot.settings;
  const [deviceName, setDeviceName] = useState(settings.deviceName);
  const [ignores, setIgnores] = useState(settings.policy.ignorePatterns.join("\n"));
  const [plugins, setPlugins] = useState(settings.policy.obsidian.communityPluginData.join("\n"));
  return (
    <div class="cs-stack">
      <section class="cs-card cs-settings-list">
        <Toggle label={t("automaticSync")} checked={settings.autoSync} onChange={(value) => void run(() => controller.updatePreference("autoSync", value))} />
        <Toggle label={t("paused")} checked={settings.paused} onChange={(value) => void run(() => controller.updatePreference("paused", value))} />
        <Toggle label={t("coreSettings")} checked={settings.policy.obsidian.coreSettings} onChange={(value) => void run(() => controller.updateObsidianPolicy("coreSettings", value))} />
        <Toggle label={t("themesSnippets")} checked={settings.policy.obsidian.themesAndSnippets} onChange={(value) => void run(() => controller.updateObsidianPolicy("themesAndSnippets", value))} />
        <label class="cs-setting-row"><span><strong>{t("language")}</strong></span><select value={settings.locale} onChange={(event) => void run(() => controller.updatePreference("locale", event.currentTarget.value as "auto" | "zh-CN" | "en"))}><option value="auto">{t("followObsidian")}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <label class="cs-setting-row"><span><strong>{t("deviceName")}</strong></span><div class="cs-inline-field"><input value={deviceName} onInput={(event) => setDeviceName(event.currentTarget.value)} /><button class="cs-button" onClick={() => void run(() => controller.updatePreference("deviceName", deviceName))}>{t("save")}</button></div></label>
      </section>
      <section class="cs-card"><label class="cs-field"><span>{t("ignores")}</span><textarea rows={8} value={ignores} onInput={(event) => setIgnores(event.currentTarget.value)} /><small>{t("ignoresHelp")}</small></label><button class="cs-button cs-button-primary" onClick={() => void run(() => controller.updateIgnorePatterns(ignores))}>{t("save")}</button></section>
      <section class="cs-card"><label class="cs-field"><span>{t("communityPlugins")}</span><textarea rows={5} value={plugins} placeholder="dataview" onInput={(event) => setPlugins(event.currentTarget.value)} /><small>{t("communityPluginsHelp")}</small></label><button class="cs-button cs-button-primary" onClick={() => void run(() => controller.updateCommunityPluginData(plugins.split(/\r?\n/)))}>{t("save")}</button></section>
      <section class="cs-card cs-danger-zone"><p class="cs-kicker">{t("danger")}</p><div class="cs-actions"><button class="cs-button" disabled={!settings.binding} onClick={() => void run(() => controller.disconnectVault())}>{t("disconnect")}</button><button class="cs-button is-danger" disabled={!settings.account} onClick={() => void run(() => controller.signOut())}>{t("signOut")}</button></div></section>
    </div>
  );
}

function DiagnosticsPage({ snapshot, t }: PanelProps): preact.JSX.Element {
  const binding = snapshot.settings.binding;
  return (
    <div class="cs-two-column">
      <section class="cs-card"><p class="cs-kicker">Runtime</p><h2>{t("diagnostics")}</h2><Definition label={t("status")} value={snapshot.status.kind} /><Definition label={t("diagnosticsRate")} value={snapshot.rateLimit.remaining === null ? "—" : String(snapshot.rateLimit.remaining)} /><Definition label={t("schema")} value={String(snapshot.settings.schemaVersion)} /><Definition label="GitHub App" value={snapshot.githubConfigured ? "configured" : "not configured"} /></section>
      <section class="cs-card"><p class="cs-kicker">Binding</p><h2>{binding?.branch ?? t("notBound")}</h2><Definition label={t("vaultId")} value={binding?.vaultId ?? "—"} mono /><Definition label={t("baseCommit")} value={binding?.baseCommitOid ?? "—"} mono /><Definition label={t("repository")} value={binding?.repository.fullName ?? "—"} /></section>
    </div>
  );
}

interface PanelProps {
  snapshot: DashboardSnapshot;
  controller: DashboardController;
  run: (action: () => Promise<void>) => Promise<void>;
  t: (key: TranslationKey) => string;
}

const NAV_ITEMS: Array<{ id: Page; label: TranslationKey; icon: string }> = [
  { id: "overview", label: "overview", icon: "layout-dashboard" },
  { id: "vaults", label: "vaults", icon: "boxes" },
  { id: "history", label: "history", icon: "history" },
  { id: "conflicts", label: "conflicts", icon: "triangle-alert" },
  { id: "settings", label: "settings", icon: "settings-2" },
  { id: "diagnostics", label: "diagnostics", icon: "stethoscope" }
];

function useController(controller: DashboardController): DashboardSnapshot {
  const [snapshot, setSnapshot] = useState(() => controller.snapshot());
  useEffect(() => controller.subscribe(() => setSnapshot(controller.snapshot())), [controller]);
  return snapshot;
}

function Icon({ name }: { name: string }): preact.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) setIcon(ref.current, name);
  }, [name]);
  return <span ref={ref} class="cs-icon" aria-hidden="true" />;
}

function Brand({ compact = false }: { compact?: boolean }): preact.JSX.Element {
  return <div class={`cs-brand ${compact ? "is-compact" : ""}`}><span class="cs-brand-icon"><Icon name="orbit" /></span><span><strong>Constellation</strong><small>Sync</small></span></div>;
}

function Badge({ children }: { children: preact.ComponentChildren }): preact.JSX.Element {
  return <span class="cs-badge">{children}</span>;
}

function Empty({ children }: { children: preact.ComponentChildren }): preact.JSX.Element {
  return <div class="cs-empty"><Icon name="sparkles" /><p>{children}</p></div>;
}

function Metric({ icon, label, value, tone, mono = false }: { icon: string; label: string; value: string; tone: string; mono?: boolean }): preact.JSX.Element {
  return <article class={`cs-metric is-${tone}`}><span class="cs-metric-icon"><Icon name={icon} /></span><span><small>{label}</small><strong class={mono ? "cs-mono" : ""}>{value}</strong></span></article>;
}

function PlanMetrics({ summary, t }: { summary: SyncPlanSummary; t: (key: TranslationKey) => string }): preact.JSX.Element {
  const values: Array<[TranslationKey, number]> = [["uploads", summary.uploads], ["downloads", summary.downloads], ["localDeletes", summary.localDeletes], ["remoteDeletes", summary.remoteDeletes], ["merges", summary.merges], ["conflictCount", summary.conflicts]];
  return <div class="cs-plan-grid">{values.map(([label, value]) => <div><strong>{value}</strong><span>{t(label)}</span></div>)}</div>;
}

function PathList({ title, paths }: { title: string; paths: string[] }): preact.JSX.Element {
  return <details class="cs-paths"><summary>{title} · {paths.length}</summary><ul>{paths.slice(0, 200).map((path) => <li><code>{path}</code></li>)}</ul></details>;
}

function ActivityList({ snapshot, t, limit }: { snapshot: DashboardSnapshot; t: (key: TranslationKey) => string; limit?: number }): preact.JSX.Element {
  const activity = [...snapshot.settings.activity].reverse().slice(0, limit);
  if (activity.length === 0) return <Empty>{t("activityEmpty")}</Empty>;
  return <div class="cs-list">{activity.map((item) => <div class="cs-list-row"><Icon name={item.kind === "error" ? "circle-alert" : item.kind === "rename" ? "git-branch" : "activity"} /><span><strong>{item.message}</strong><small>{formatDate(item.time)}{item.commitOid ? ` · ${item.commitOid.slice(0, 8)}` : ""}</small></span></div>)}</div>;
}

function Definition({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): preact.JSX.Element {
  return <div class="cs-definition"><span>{label}</span><strong class={mono ? "cs-mono" : ""}>{value}</strong></div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): preact.JSX.Element {
  return <label class="cs-setting-row"><span><strong>{label}</strong></span><input class="cs-switch" type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /></label>;
}

function unresolvedCount(snapshot: DashboardSnapshot): number {
  return snapshot.settings.conflicts.filter((item) => !item.resolved).length;
}

function busy(snapshot: DashboardSnapshot): boolean {
  return snapshot.status.kind === "scanning" || snapshot.status.kind === "syncing";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
