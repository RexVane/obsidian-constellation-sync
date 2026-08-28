import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardController, DashboardSnapshot } from "../controller";
import { translator, type TranslationKey } from "../i18n";
import type { ConflictRecord, SyncPlanSummary } from "../types";

export const DASHBOARD_VIEW_TYPE = "constellation-sync-dashboard";

const TOKEN_CREATION_URL = "https://github.com/settings/tokens/new?description=Constellation%20Sync&scopes=repo";

type Page = "overview" | "settings";

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
              {item.id === "overview" && unresolvedConflicts(snapshot).length > 0 ? <Badge>{unresolvedConflicts(snapshot).length}</Badge> : null}
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
        ) : !snapshot.settings.binding && page !== "settings" ? (
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
  const [token, setToken] = useState("");
  return (
    <section class="cs-auth-shell">
      <div class="cs-card cs-auth-card">
        <div class="cs-orbit-mark"><Icon name="orbit" /></div>
        <p class="cs-kicker">GitHub</p>
        <h2>{t("connectGithub")}</h2>
        <p>{t("connectDescription")}</p>
        <div class="cs-alert is-warning"><Icon name="shield-alert" /><span>{t("privateNotEncrypted")}</span></div>
        <div class="cs-actions">
          <button class="cs-button" onClick={() => controller.openExternal(TOKEN_CREATION_URL)}>
            <Icon name="key-round" /> {t("createToken")}
          </button>
        </div>
        <p class="cs-muted">{t("tokenClassicHelp")}</p>
        <label class="cs-field">
          <span>{t("tokenField")}</span>
          <input
            type="password"
            value={token}
            placeholder="ghp_… / github_pat_…"
            onInput={(event) => setToken(event.currentTarget.value)}
          />
          <small>{t("tokenHelp")}</small>
        </label>
        <button
          class="cs-button cs-button-primary"
          disabled={!token.trim() || busy(snapshot)}
          onClick={() => void run(() => controller.connectWithToken(token))}
        >
          {t("connectGithub")}
        </button>
        <p class="cs-muted">{t("tokenFineHelp")}</p>
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
            <p class="cs-kicker">New vault</p>
            <h2>{t("createVault")}</h2>
            <button class="cs-button cs-button-primary" disabled={busy(snapshot)} onClick={() => void run(() => controller.useDefaultBranch(selected))}>
              <Icon name="corner-down-right" /> {t("useDefaultBranch").replace("{branch}", selected.defaultBranch)}
            </button>
            <p class="cs-muted">{t("defaultBranchHelp")}</p>
            {snapshot.suggestedBranch ? <p class="cs-muted">{t("localVault")}: <strong>{snapshot.localVaultName}</strong> → <code>{snapshot.suggestedBranch}</code><br />{t("autoBranchHelp")}</p> : null}
            <label class="cs-field"><span>{t("englishName")}</span><input value={name} placeholder="work-notes" onInput={(event) => setName(event.currentTarget.value)} /><small>{t("branchHelp")}</small></label>
            <button class="cs-button" disabled={!name.trim() || busy(snapshot)} onClick={() => void run(() => controller.createVault(selected, name))}>{t("newBranchCta")}</button>
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
  return <SettingsPage {...props} />;
}

function Overview({ snapshot, controller, run, t }: PanelProps): preact.JSX.Element {
  const binding = snapshot.settings.binding;
  if (!binding) return <Empty>{t("notBound")}</Empty>;
  const pending = snapshot.settings.pendingReview?.plan;
  const conflicts = unresolvedConflicts(snapshot);
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
      {conflicts.length > 0 ? (
        <section class="cs-card">
          <div class="cs-card-header"><div><p class="cs-kicker">{t("conflicts")}</p><h2>{t("unresolved")}</h2></div><Badge>{conflicts.length}</Badge></div>
          <p class="cs-muted">{t("conflictHelp")}</p>
          <div class="cs-list">
            {conflicts.map((item) => (
              <div class="cs-list-row cs-conflict-row">
                <Icon name="triangle-alert" />
                <span><strong>{item.path}</strong><small>{item.reason}{item.conflictPath ? ` · ${item.conflictPath}` : ""} · {formatDate(item.createdAt)}</small></span>
                <button class="cs-button" onClick={() => void run(() => controller.resolveConflict(item.id))}>{t("markResolved")}</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
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

function SettingsPage({ snapshot, controller, run, t }: PanelProps): preact.JSX.Element {
  const settings = snapshot.settings;
  const binding = settings.binding;
  const [name, setName] = useState(binding?.branch ?? "");
  const [deviceName, setDeviceName] = useState(settings.deviceName);
  const [ignores, setIgnores] = useState(settings.policy.ignorePatterns.join("\n"));
  const [plugins, setPlugins] = useState(settings.policy.obsidian.communityPluginData.join("\n"));
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [restorePath, setRestorePath] = useState("");
  const [restoreCommit, setRestoreCommit] = useState("");

  useEffect(() => setName(binding?.branch ?? ""), [binding?.branch]);

  return (
    <div class="cs-stack">
      {binding ? (
        <section class="cs-card">
          <p class="cs-kicker">{t("currentVault")}</p>
          <h2>{binding.branch}</h2>
          <Definition label={t("repository")} value={binding.repository.fullName} />
          <Definition label={t("vaultId")} value={binding.vaultId} mono />
          <p class="cs-muted">{t("renameHelp")}</p>
          <label class="cs-field"><span>{t("englishName")}</span><input value={name} onInput={(event) => setName(event.currentTarget.value)} /><small>{t("branchHelp")}</small></label>
          <div class="cs-actions">
            <button class="cs-button cs-button-primary" disabled={name === binding.branch || busy(snapshot)} onClick={() => void run(() => controller.renameVault(name))}>{t("rename")}</button>
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
      ) : null}
      <section class="cs-card cs-settings-list">
        <Toggle label={t("automaticSync")} checked={settings.autoSync} onChange={(value) => void run(() => controller.updatePreference("autoSync", value))} />
        <Toggle label={t("paused")} checked={settings.paused} onChange={(value) => void run(() => controller.updatePreference("paused", value))} />
        <label class="cs-setting-row"><span><strong>{t("language")}</strong></span><select value={settings.locale} onChange={(event) => void run(() => controller.updatePreference("locale", event.currentTarget.value as "auto" | "zh-CN" | "en"))}><option value="auto">{t("followObsidian")}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <label class="cs-setting-row"><span><strong>{t("checkInterval")}</strong></span><select value={String(settings.remotePollMs)} onChange={(event) => void run(() => controller.updatePreference("remotePollMs", Number(event.currentTarget.value)))}>{POLL_OPTIONS.map(([ms, key]) => <option value={String(ms)}>{t(key)}</option>)}</select></label>
        <label class="cs-setting-row"><span><strong>{t("deviceName")}</strong></span><div class="cs-inline-field"><input value={deviceName} onInput={(event) => setDeviceName(event.currentTarget.value)} /><button class="cs-button" onClick={() => void run(() => controller.updatePreference("deviceName", deviceName))}>{t("save")}</button></div></label>
      </section>
      <section class="cs-card"><label class="cs-field"><span>{t("ignores")}</span><textarea rows={8} value={ignores} onInput={(event) => setIgnores(event.currentTarget.value)} /><small>{t("ignoresHelp")}</small></label><button class="cs-button cs-button-primary" onClick={() => void run(() => controller.updateIgnorePatterns(ignores))}>{t("save")}</button></section>
      <section class="cs-card"><label class="cs-field"><span>{t("communityPlugins")}</span><textarea rows={5} value={plugins} placeholder="dataview" onInput={(event) => setPlugins(event.currentTarget.value)} /><small>{t("communityPluginsHelp")}</small></label><button class="cs-button cs-button-primary" onClick={() => void run(() => controller.updateCommunityPluginData(plugins.split(/\r?\n/)))}>{t("save")}</button></section>
      <section class="cs-card">
        <details class="cs-advanced">
          <summary>{t("advanced")}</summary>
          <div class="cs-advanced-body">
            <Definition label={t("status")} value={snapshot.status.kind} />
            <Definition label={t("diagnosticsRate")} value={snapshot.rateLimit.remaining === null ? "—" : String(snapshot.rateLimit.remaining)} />
            <Definition label={t("schema")} value={String(settings.schemaVersion)} />
            <Definition label={t("baseCommit")} value={binding?.baseCommitOid ?? "—"} mono />
            <p class="cs-kicker">{t("restore")}</p>
            <p class="cs-muted">{t("restoreHelp")}</p>
            <div class="cs-form-grid">
              <label class="cs-field"><span>{t("restorePath")}</span><input value={restorePath} onInput={(event) => setRestorePath(event.currentTarget.value)} placeholder="Notes/example.md" /></label>
              <label class="cs-field"><span>{t("restoreCommit")}</span><input value={restoreCommit} onInput={(event) => setRestoreCommit(event.currentTarget.value)} placeholder="commit SHA" /></label>
            </div>
            <button class="cs-button" disabled={!restorePath || !restoreCommit || busy(snapshot)} onClick={() => void run(() => controller.restoreFile(restorePath, restoreCommit))}>{t("restore")}</button>
          </div>
        </details>
      </section>
      <section class="cs-card cs-danger-zone"><p class="cs-kicker">{t("danger")}</p><div class="cs-actions"><button class="cs-button is-danger" disabled={!settings.account} onClick={() => void run(() => controller.signOut())}>{t("signOut")}</button></div></section>
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
  { id: "settings", label: "settings", icon: "settings-2" }
];

const POLL_OPTIONS: Array<[number, TranslationKey]> = [
  [15_000, "interval15s"],
  [30_000, "interval30s"],
  [60_000, "interval60s"],
  [300_000, "interval300s"]
];

function unresolvedConflicts(snapshot: DashboardSnapshot): ConflictRecord[] {
  return snapshot.settings.conflicts.filter((item) => !item.resolved);
}

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

function busy(snapshot: DashboardSnapshot): boolean {
  return snapshot.status.kind === "scanning" || snapshot.status.kind === "syncing";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
