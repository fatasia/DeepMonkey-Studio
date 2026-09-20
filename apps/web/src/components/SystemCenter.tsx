import { useEffect, useState, type ReactNode } from "react";
import { Activity, BellRing, Box, Bot, Braces, CircleAlert, CloudCog, FileClock, KeyRound, Pencil, PlugZap, Plus, Power, Save, Trash2, Users } from "lucide-react";
import type {
  AiModelProviderSettings,
  AiProviderSettings,
  AiTelemetrySummary,
  AuditLogRecord,
  ConverterPluginDescriptor,
  ProjectRecord,
  ServiceHealthRecord,
  SystemUserRecord,
  SystemUserRole,
} from "@bim-studio/contracts";
import { api, type AiProviderDescriptor, type SystemPluginSummary } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import {
  buildAiSettingsPayload,
  describeFailoverCategory,
  describeModelCatalogFailure,
  describeServedSummary,
  type AiReasoningEffortChoice,
} from "../ai/aiSettingsDraft";
import { CloudRenderControl } from "./CloudRenderControl";
import { SystemNotificationPanel } from "./SystemNotificationPanel";
import { SecondaryPageBack } from "./SecondaryPageBack";
import { SystemHealthPanel, SystemLogPanel } from "./SystemObservabilityPanels";
import { McpSettingsPanel } from "./McpSettingsPanel";

export type SystemCenterTab = "users" | "health" | "audit" | "ai" | "mcp" | "cloud-render" | "notifications";
type Translate = (zh: string, en: string) => string;

export function SystemCenter({
  locale,
  currentUser,
  projects,
  initialTab = "users",
  onTabChange,
  onBack,
}: {
  locale: AppLocale;
  currentUser: SystemUserRecord;
  projects: ProjectRecord[];
  initialTab?: SystemCenterTab;
  onTabChange?: (tab: SystemCenterTab) => void;
  onBack: () => void;
}) {
  const t: Translate = (zh, en) => tr(locale, zh, en);
  const [tab, setTab] = useState<SystemCenterTab>(initialTab);
  const [users, setUsers] = useState<SystemUserRecord[]>([]);
  const [health, setHealth] = useState<ServiceHealthRecord[]>([]);
  const [logs, setLogs] = useState<AuditLogRecord[]>([]);
  const [ai, setAi] = useState<AiProviderSettings>();
  const [aiProviders, setAiProviders] = useState<AiProviderDescriptor[]>([]);
  const [plugins, setPlugins] = useState<SystemPluginSummary[]>([]);
  const [converters, setConverters] = useState<ConverterPluginDescriptor[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SystemUserRecord | "new">();
  const selectTab = (next: SystemCenterTab) => { setTab(next); onTabChange?.(next); };

  async function load() {
    setError(undefined);
    try {
      const [u, h, l, a, p, c, providerCatalog] = await Promise.all([
        api.listUsers(),
        api.getSystemHealth(),
        api.listAuditLogs(),
        api.getAiSettings(),
        api.listPlugins(),
        api.listConverters(),
        api.listAiProviders(),
      ]);
      setUsers(u);
      setHealth(h);
      setLogs(l);
      setAi(a);
      setPlugins(p.plugins);
      setConverters(c);
      setAiProviders(providerCatalog.providers);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => setTab(initialTab), [initialTab]);

  return (
    <main className="system-center-page">
      <header className="secondary-page-header">
        <div className="secondary-page-heading-row">
          <SecondaryPageBack locale={locale} onBack={onBack} />
          <div className="secondary-page-title">
            <h1>{t("设置", "Settings")}</h1>
            <p>{t("用户授权、服务健康、MCP、云渲染、操作审计与 AI 配置", "Users, service health, MCP, cloud rendering, audit logs and AI settings")}</p>
          </div>
        </div>
      </header>
      {error && <div className="system-error">{error}</div>}
      <nav className="system-tabs">
        <TabButton active={tab === "users"} onClick={() => selectTab("users")} icon={<Users />} label={t("用户与权限", "Users & access")} />
        <TabButton active={tab === "health"} onClick={() => selectTab("health")} icon={<Activity />} label={t("服务健康", "Service health")} />
        <TabButton active={tab === "cloud-render"} onClick={() => selectTab("cloud-render")} icon={<CloudCog />} label={t("云渲染设置", "Cloud settings")} />
        <TabButton active={tab === "notifications"} onClick={() => selectTab("notifications")} icon={<BellRing />} label={t("通知与推送", "Notifications")} />
        <TabButton active={tab === "audit"} onClick={() => selectTab("audit")} icon={<FileClock />} label={t("审计与日志", "Audit & logs")} />
        <TabButton active={tab === "ai"} onClick={() => selectTab("ai")} icon={<Bot />} label={t("AI 大模型", "AI model")} />
        <TabButton active={tab === "mcp"} onClick={() => selectTab("mcp")} icon={<Braces />} label="MCP" />
      </nav>
      <section className="system-content">
        {tab === "users" && (
          <UserPanel t={t} users={users} projects={projects} currentUser={currentUser} editing={editing} setEditing={setEditing} onReload={load} onError={setError} />
        )}
        {tab === "health" && <SystemHealthPanel t={t} initialHealth={health} converters={converters} onError={setError} />}
        {tab === "cloud-render" && <CloudRenderControl locale={locale} />}
        {tab === "notifications" && <SystemNotificationPanel locale={locale} projects={projects} t={t} />}
        {tab === "audit" && <SystemLogPanel t={t} auditLogs={logs} onError={setError} />}
        {tab === "ai" && ai && (
          <div className="system-ai-layout">
            <AiSettingsPanel t={t} initial={ai} providers={aiProviders} onSaved={setAi} onError={setError} />
            <AiModelingSettingsPanel t={t} initial={ai.modeling3d} onSaved={setAi} onError={setError} />
            <AiPluginPanel t={t} plugins={plugins} onReload={load} onError={setError} />
          </div>
        )}
        {tab === "mcp" && <McpSettingsPanel locale={locale} />}
      </section>
    </main>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function UserPanel({
  t,
  users,
  projects,
  currentUser,
  editing,
  setEditing,
  onReload,
  onError,
}: {
  t: Translate;
  users: SystemUserRecord[];
  projects: ProjectRecord[];
  currentUser: SystemUserRecord;
  editing: SystemUserRecord | "new" | undefined;
  setEditing: (value?: SystemUserRecord | "new") => void;
  onReload: () => Promise<void>;
  onError: (value: string) => void;
}) {
  async function remove(user: SystemUserRecord) {
    if (!confirm(t(`删除用户“${user.displayName}”？`, `Delete user “${user.displayName}”?`))) return;
    try {
      await api.deleteUser(user.id);
      await onReload();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <div className="system-users">
      <header>
        <div>
          <strong>{t("用户与项目授权", "Users and project access")}</strong>
          <span>{t("管理员、编辑者、浏览者三种角色", "Admin, editor and viewer roles")}</span>
        </div>
        <button onClick={() => setEditing("new")}>
          <Plus size={14} />
          {t("新建用户", "New user")}
        </button>
      </header>
      {editing && (
        <UserForm
          t={t}
          initial={editing === "new" ? undefined : editing}
          projects={projects}
          onCancel={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await onReload();
          }}
          onError={onError}
        />
      )}
      <div className="system-user-grid">
        {users.map((user) => (
          <article key={user.id}>
            <div className={`system-user-avatar role-${user.role}`}>{user.displayName.slice(0, 1).toUpperCase()}</div>
            <span>
              <strong>
                {user.displayName}
                {user.id === currentUser.id && <i>{t("当前", "Current")}</i>}
              </strong>
              <small>
                @{user.username} · {roleName(t, user.role)}
              </small>
              <em>{user.role === "admin" ? t("全部项目", "All projects") : t(`${user.projectIds.length} 个项目`, `${user.projectIds.length} projects`)}</em>
            </span>
            <i className={user.enabled ? "enabled" : "disabled"}>{user.enabled ? t("启用", "Enabled") : t("停用", "Disabled")}</i>
            <button aria-label={t("编辑", "Edit")} onClick={() => setEditing(user)}>
              <Pencil size={13} />
            </button>
            <button aria-label={t("删除", "Delete")} disabled={user.id === currentUser.id} onClick={() => void remove(user)}>
              <Trash2 size={13} />
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}

function UserForm({
  t,
  initial,
  projects,
  onCancel,
  onSaved,
  onError,
}: {
  t: Translate;
  initial: SystemUserRecord | undefined;
  projects: ProjectRecord[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onError: (value: string) => void;
}) {
  const [username, setUsername] = useState(initial?.username ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<SystemUserRole>(initial?.role ?? "editor");
  const [projectIds, setProjectIds] = useState(initial?.projectIds ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  async function save() {
    try {
      if (initial) await api.updateUser(initial.id, { displayName, role, projectIds, enabled, ...(password ? { password } : {}) });
      else await api.createUser({ username, displayName, role, projectIds, enabled, password });
      await onSaved();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <div className="system-user-form">
      <header>
        <strong>{initial ? t("编辑用户", "Edit user") : t("新建用户", "New user")}</strong>
        <button onClick={onCancel}>×</button>
      </header>
      <label>
        <span>{t("用户名", "Username")}</span>
        <input disabled={Boolean(initial)} value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label>
        <span>{t("显示名称", "Display name")}</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label>
        <span>{initial ? t("新密码（留空不修改）", "New password (leave blank to keep)") : t("初始密码", "Initial password")}</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label>
        <span>{t("角色", "Role")}</span>
        <select value={role} onChange={(event) => setRole(event.target.value as SystemUserRole)}>
          <option value="admin">{t("管理员", "Admin")}</option>
          <option value="editor">{t("编辑者", "Editor")}</option>
          <option value="viewer">{t("浏览者", "Viewer")}</option>
        </select>
      </label>
      {role !== "admin" && (
        <fieldset>
          <legend>{t("可访问项目", "Accessible projects")}</legend>
          {projects.map((project) => (
            <label key={project.id}>
              <input
                type="checkbox"
                checked={projectIds.includes(project.id)}
                onChange={(event) => setProjectIds((items) => (event.target.checked ? [...items, project.id] : items.filter((id) => id !== project.id)))}
              />
              {project.name}
            </label>
          ))}
        </fieldset>
      )}
      <label className="system-user-enabled">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t("启用用户", "Enable user")}
      </label>
      <footer>
        <button onClick={onCancel}>{t("取消", "Cancel")}</button>
        <button className="primary" disabled={!displayName.trim() || (!initial && (!username.trim() || !password))} onClick={() => void save()}>
          <Save size={13} />
          {t("保存", "Save")}
        </button>
      </footer>
    </div>
  );
}

export function AiSettingsPanel({
  t,
  initial,
  providers,
  onSaved,
  onError,
}: {
  t: Translate;
  initial: AiProviderSettings;
  providers: AiProviderDescriptor[];
  onSaved: (value: AiProviderSettings) => void;
  onError: (value: string) => void;
}) {
  const [providerId, setProviderId] = useState(initial.providerId);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [protocol, setProtocol] = useState(initial.protocol);
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState(initial.temperature);
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffortChoice>(initial.reasoningEffort ?? "");
  const [failoverEnabled, setFailoverEnabled] = useState(initial.failover?.enabled ?? true);
  const [failoverBaseUrl, setFailoverBaseUrl] = useState(initial.failover?.baseUrl ?? "");
  const [failoverModel, setFailoverModel] = useState(initial.failover?.model ?? "");
  const [failoverApiKey, setFailoverApiKey] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [catalogNotice, setCatalogNotice] = useState<string>();
  const [telemetry, setTelemetry] = useState<AiTelemetrySummary>();
  const [busy, setBusy] = useState(false);

  // 渐进增强：观测快照拉取失败时保持界面现状，不阻塞配置编辑。
  useEffect(() => {
    let cancelled = false;
    api.getAiTelemetry().then((snapshot) => { if (!cancelled) setTelemetry(snapshot.telemetry); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function draft() {
    return buildAiSettingsPayload({
      current: { providerId, baseUrl, model, protocol, temperature, apiKey },
      initial,
      reasoningEffort,
      failover: { enabled: failoverEnabled, baseUrl: failoverBaseUrl, model: failoverModel, apiKey: failoverApiKey },
    });
  }

  async function refreshModels(force = false) {
    setBusy(true);
    setCatalogNotice(undefined);
    try {
      const result = await api.fetchAiModels({ ...draft(), ...(force ? { refresh: true } : {}) });
      if (result.ok) {
        setModelOptions(result.models);
        if (!result.models.includes(model.trim())) setCatalogNotice(t("列表已更新，请从下拉中选择或直接输入模型名。", "Catalog updated; pick from the list or type a model name."));
      } else {
        setCatalogNotice(describeModelCatalogFailure(result.category, result.message, t));
      }
    } catch (reason) {
      setCatalogNotice(describeModelCatalogFailure("network", reason instanceof Error ? reason.message : String(reason), t));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      onSaved(await api.saveAiSettings(draft()));
      setApiKey("");
      setFailoverApiKey("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      const result = await api.testAiSettings(draft());
      alert(t(`连接成功：${result.model}`, `Connected: ${result.model}`));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const credentialContextChanged = providerId !== initial.providerId || baseUrl.replace(/\/$/, "") !== initial.baseUrl;
  const reasoningSupported = providerId === "ai.openai-compatible";
  const failoverConfigured = Boolean((initial.failover?.apiKeyConfigured ?? initial.failover?.apiKey) || failoverBaseUrl);
  const servedSummary = telemetry ? describeServedSummary(telemetry, failoverModel.trim() || undefined, t) : undefined;
  const lastFailover = telemetry?.lastFailover;
  return (
    <div className="system-ai-settings">
      <div className="system-ai-intro">
        <Bot size={24} />
        <span>
          <strong>{selectedProvider?.label ?? t("AI 模型服务", "AI model service")}</strong>
          <small>{t("用于场景助手、构件问答、受控问数和看板生成", "Scene, component, controlled data and dashboard assistants")}</small>
        </span>
      </div>
      <label>
        <span>{t("模型服务插件", "Model provider plugin")}</span>
        <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
          {!providers.some((provider) => provider.id === providerId) && <option value={providerId}>{providerId}</option>}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label} · v{provider.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Base URL</span>
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
      </label>
      <label>
        <span>{t("模型名", "Model")}</span>
        <input value={model} list="ai-model-options" onChange={(event) => setModel(event.target.value)} />
        <datalist id="ai-model-options">
          {modelOptions.map((option) => <option key={option} value={option} />)}
        </datalist>
      </label>
      <label>
        <span>{t("接口协议", "API protocol")}</span>
        <select value={protocol} onChange={(event) => setProtocol(event.target.value as AiProviderSettings["protocol"])}>
          <option value="auto">{t("自动选择", "Auto")}</option>
          <option value="responses">Responses API</option>
          <option value="chat-completions">Chat Completions</option>
        </select>
      </label>
      <label>
        <span>API Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            credentialContextChanged
              ? t("服务已变化，请输入对应密钥", "Provider changed; enter its API key")
              : initial.apiKeyConfigured
                ? t("已配置，留空保持不变", "Configured; leave blank to keep")
                : "sk-..."
          }
        />
      </label>
      <label>
        <span>Temperature</span>
        <input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
      </label>
      <label>
        <span>{t("思考深度", "Reasoning effort")}</span>
        <select
          value={reasoningEffort}
          disabled={!reasoningSupported}
          title={reasoningSupported
            ? t("映射到 Responses reasoning.effort / Chat reasoning_effort", "Maps to Responses reasoning.effort / Chat reasoning_effort")
            : t("当前模型服务插件不支持推理深度控制", "Current model provider does not support reasoning effort control")}
          onChange={(event) => setReasoningEffort(event.target.value as AiReasoningEffortChoice)}
        >
          <option value="">{t("默认（保持现有行为）", "Default (keep current behavior)")}</option>
          <option value="minimal">{t("最省（快速回答）", "Minimal (fastest)")}</option>
          <option value="standard">{t("标准", "Standard")}</option>
          <option value="deep">{t("深度（更慢更严谨）", "Deep (slower, more thorough)")}</option>
        </select>
        {!reasoningSupported && <small>{t("该控制仅对 OpenAI 兼容插件生效，其他插件已禁用并按默认行为请求。", "Only the OpenAI-compatible plugin supports this; others request with defaults.")}</small>}
      </label>
      <div className="system-ai-section" data-testid="ai-failover-section">
        <header>
          <strong>{t("备用模型自动切换", "Fallback model failover")}</strong>
          <small>{t("主模型出现额度、限流、服务端、超时或网络错误时，自动用备用配置重试一次；鉴权错误不切换。", "Retries once via the fallback on quota, rate-limit, server, timeout or network errors; auth errors never switch.")}</small>
        </header>
        <label className="system-ai-toggle">
          <input type="checkbox" checked={failoverEnabled} onChange={(event) => setFailoverEnabled(event.target.checked)} />
          <span>{failoverEnabled ? t("已启用", "Enabled") : t("已关闭", "Disabled")}</span>
        </label>
        <div>
          <label>
            <span>{t("备用 Base URL", "Fallback Base URL")}</span>
            <input value={failoverBaseUrl} placeholder={t("留空则使用服务器 AI_FALLBACK_BASE_URL", "Blank uses server AI_FALLBACK_BASE_URL")} onChange={(event) => setFailoverBaseUrl(event.target.value)} />
          </label>
          <label>
            <span>{t("备用模型名", "Fallback model")}</span>
            <input value={failoverModel} onChange={(event) => setFailoverModel(event.target.value)} />
          </label>
          <label>
            <span>{t("备用 API Key", "Fallback API key")}</span>
            <input
              type="password"
              value={failoverApiKey}
              onChange={(event) => setFailoverApiKey(event.target.value)}
              placeholder={initial.failover?.apiKeyConfigured ? t("已配置，留空保持不变", "Configured; leave blank to keep") : t("未配置，留空则使用服务器环境变量", "Not set; blank uses server environment")}
            />
          </label>
          <label>
            <span>{t("备用接口协议", "Fallback protocol")}</span>
            <span>{t("跟随上方接口协议设置", "Follows the API protocol above")}</span>
          </label>
        </div>
        <p className="system-ai-status" data-testid="ai-failover-status">
          {servedSummary
            ?? (lastFailover
              ? undefined
              : t("尚未有请求记录；主配置健康路径不会产生额外请求。", "No requests recorded yet; a healthy primary path adds no extra requests."))}
          {lastFailover && (
            <small>
              {t("最近一次切换", "Latest failover")}：
              {t("由备用模型", "served by fallback")} {lastFailover.model}
              {lastFailover.errorCategory ? ` · ${describeFailoverCategory(lastFailover.errorCategory, t)}` : ""}
            </small>
          )}
          {!failoverConfigured && !failoverBaseUrl && (
            <small>{t("备用模型尚未配置端点，切换策略处于待命状态。", "No fallback endpoint configured; the policy is on standby.")}</small>
          )}
        </p>
      </div>
      {catalogNotice && <p className="system-ai-catalog-notice" role="status">{catalogNotice}</p>}
      {telemetry && telemetry.records.length > 0 && (
        <div className="system-ai-telemetry" data-testid="ai-telemetry">
          <header>{t("最近请求（最新在后）", "Recent requests (newest last)")}</header>
          <ul>
            {telemetry.records.slice(-5).map((record) => (
              <li key={record.id}>
                {new Date(record.occurredAt).toLocaleTimeString()} · {record.servedBy === "fallback" ? t("备用", "fallback") : t("主", "primary")} {record.model} · {record.latencyMs} ms · {record.status === "completed" ? t("成功", "ok") : record.status === "cancelled" ? t("已取消", "cancelled") : record.errorCategory ?? t("失败", "failed")}
                {record.outputTokens !== undefined ? ` · ${t("输出", "out")} ${record.outputTokens} tok` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer>
        <button disabled={busy} onClick={() => void refreshModels(false)} title={t("从模型服务拉取可用模型列表", "Fetch the model catalog from the provider")}>
          <Bot size={13} />
          {t("拉取模型列表", "Fetch models")}
        </button>
        {modelOptions.length > 0 && (
          <button disabled={busy} onClick={() => void refreshModels(true)}>
            {t("刷新列表", "Refresh list")}
          </button>
        )}
        <button disabled={busy} onClick={() => void test()}>
          <KeyRound size={13} />
          {t("测试连接", "Test")}
        </button>
        <button className="primary" disabled={busy || !baseUrl.trim() || !model.trim() || (credentialContextChanged && !apiKey.trim())} onClick={() => void save()}>
          <Save size={13} />
          {t("保存配置", "Save settings")}
        </button>
      </footer>
    </div>
  );
}

function AiPluginPanel({ t, plugins, onReload, onError }: { t: Translate; plugins: SystemPluginSummary[]; onReload: () => Promise<void>; onError: (value: string) => void }) {
  const [busyId, setBusyId] = useState("");
  const configurable = plugins.filter((plugin) => plugin.configurable);

  async function toggle(plugin: SystemPluginSummary) {
    const enabling = plugin.status !== "enabled";
    const name = pluginDisplayName(t, plugin);
    if (
      !confirm(enabling ? t(`启用“${name}”？`, `Enable “${name}”?`) : t(`停用“${name}”？相关入口会自动降级。`, `Disable “${name}”? Related entry points will degrade gracefully.`))
    )
      return;
    setBusyId(plugin.id);
    try {
      await api.setPluginEnabled(plugin.id, enabling);
      await onReload();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="system-ai-plugins">
      <header>
        <span>
          <PlugZap size={18} />
          <strong>{t("AI 能力插件", "AI capability plugins")}</strong>
        </span>
        <small>{t("按场景独立启停；确定性底座不会随模型插件停用", "Toggle scenarios independently; deterministic foundations remain available")}</small>
      </header>
      <div>
        {configurable.map((plugin) => {
          const enabled = plugin.status === "enabled";
          const diagnostic = plugin.diagnostics.at(-1);
          return (
            <article key={plugin.id} className={plugin.status}>
              <span>
                <strong>{pluginDisplayName(t, plugin)}</strong>
                <small>
                  {plugin.id} · v{plugin.version}
                </small>
                <em>{[...plugin.capabilityIds, ...plugin.providerIds].join(" · ") || plugin.capabilities.join(" · ")}</em>
                {diagnostic && <i>{diagnostic.message}</i>}
              </span>
              <b>{enabled ? t("运行中", "Running") : plugin.status === "faulted" ? t("故障", "Faulted") : t("已停用", "Disabled")}</b>
              <button disabled={Boolean(busyId)} onClick={() => void toggle(plugin)}>
                <Power size={13} />
                {enabled ? t("停用", "Disable") : t("启用", "Enable")}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type Modeling3dProviderKey = "tripo3d" | "tencentHunyuan";
type Modeling3dSettings = Record<Modeling3dProviderKey, AiModelProviderSettings>;

const DEFAULT_MODELING_3D_SETTINGS: Modeling3dSettings = {
  tripo3d: {
    providerId: "ai.tripo3d",
    baseUrl: "https://openapi.tripo3d.ai",
    model: "tripo-3d",
    protocol: "auto",
  },
  tencentHunyuan: {
    providerId: "ai.tencent-hunyuan-3d",
    baseUrl: "https://ai3d.tencentcloudapi.com",
    model: "3.1",
    protocol: "auto",
    region: "ap-guangzhou",
  },
};

function AiModelingSettingsPanel({
  t,
  initial,
  onSaved,
  onError,
}: {
  t: Translate;
  initial: AiProviderSettings["modeling3d"];
  onSaved: (value: AiProviderSettings) => void;
  onError: (value: string) => void;
}) {
  const [settings, setSettings] = useState<Modeling3dSettings>(() => ({
    tripo3d: { ...DEFAULT_MODELING_3D_SETTINGS.tripo3d, ...(initial?.tripo3d ?? {}) },
    tencentHunyuan: { ...DEFAULT_MODELING_3D_SETTINGS.tencentHunyuan, ...(initial?.tencentHunyuan ?? {}) },
  }));
  const [apiKeys, setApiKeys] = useState<Record<Modeling3dProviderKey, string>>({ tripo3d: "", tencentHunyuan: "" });
  const [secretIds, setSecretIds] = useState<Record<Modeling3dProviderKey, string>>({ tripo3d: "", tencentHunyuan: "" });
  const [busy, setBusy] = useState(false);
  const [activeProvider, setActiveProvider] = useState<Modeling3dProviderKey>("tripo3d");

  function update(provider: Modeling3dProviderKey, patch: Partial<AiModelProviderSettings>) {
    setSettings((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));
  }

  async function save() {
    setBusy(true);
    try {
      const modeling3d = {
        tripo3d: { ...settings.tripo3d, ...(apiKeys.tripo3d.trim() ? { apiKey: apiKeys.tripo3d.trim() } : {}) },
        tencentHunyuan: { ...settings.tencentHunyuan, ...(secretIds.tencentHunyuan.trim() ? { secretId: secretIds.tencentHunyuan.trim() } : {}), ...(apiKeys.tencentHunyuan.trim() ? { apiKey: apiKeys.tencentHunyuan.trim() } : {}) },
      };
      onSaved(await api.saveAiSettings({ modeling3d }));
      setApiKeys({ tripo3d: "", tencentHunyuan: "" });
      setSecretIds({ tripo3d: "", tencentHunyuan: "" });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="system-ai-3d-settings">
      <header>
        <span>
          <Box size={18} />
          <strong>{t("3D 生成", "3D generation")}</strong>
        </span>
      </header>
      <nav className="system-ai-provider-tabs" aria-label={t("3D 生成供应商", "3D generation provider")}>
        <button type="button" className={activeProvider === "tripo3d" ? "active" : ""} onClick={() => setActiveProvider("tripo3d")}>Tripo3D</button>
        <button type="button" className={activeProvider === "tencentHunyuan" ? "active" : ""} onClick={() => setActiveProvider("tencentHunyuan")}>{t("混元 3D", "Hunyuan 3D")}</button>
      </nav>
      {(() => {
        const provider = activeProvider;
        const value = settings[provider];
        return (
          <article>
            <div className="system-ai-3d-card-heading">
              <strong>{provider === "tripo3d" ? t("Tripo3D", "Tripo3D") : t("腾讯混元 3D", "Tencent Hunyuan 3D")}</strong>
              <span className={(value.apiKeyConfigured || apiKeys[provider].trim()) && (provider === "tripo3d" || value.secretIdConfigured || secretIds[provider].trim()) ? "configured" : ""}>
                {(value.apiKeyConfigured || apiKeys[provider].trim()) && (provider === "tripo3d" || value.secretIdConfigured || secretIds[provider].trim()) ? t("已配置", "Configured") : t("未配置", "Not configured")}
              </span>
            </div>
            <label>
              <span>Base URL</span>
              <input value={value.baseUrl} onChange={(event) => update(provider, { baseUrl: event.target.value })} />
            </label>
            {provider === "tencentHunyuan" && <label>
              <span>{t("地域", "Region")}</span>
              <select value={value.region ?? "ap-guangzhou"} onChange={(event) => update(provider, { region: event.target.value })}>
                <option value="ap-guangzhou">ap-guangzhou</option>
                <option value="ap-shanghai">ap-shanghai</option>
              </select>
            </label>}
            {provider === "tencentHunyuan" && <label>
              <span>Secret ID</span>
              <input type="password" value={secretIds[provider]} placeholder={value.secretIdConfigured ? t("已配置，留空保持不变", "Configured; leave blank to keep") : "SecretId"} onChange={(event) => setSecretIds((current) => ({ ...current, [provider]: event.target.value }))} />
            </label>}
            <label>
              <span>{provider === "tripo3d" ? "API Key" : "Secret Key"}</span>
              <input
                type="password"
                value={apiKeys[provider]}
                placeholder={value.apiKeyConfigured ? t("已配置，留空保持不变", "Configured; leave blank to keep") : t("输入密钥", "Enter key")}
                onChange={(event) => setApiKeys((current) => ({ ...current, [provider]: event.target.value }))}
              />
            </label>
          </article>
        );
      })()}
      <footer>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          <Save size={13} />
          {busy ? t("保存中…", "Saving…") : t("保存", "Save")}
        </button>
      </footer>
    </section>
  );
}

function pluginDisplayName(t: Translate, plugin: SystemPluginSummary): string {
  const names: Record<string, string> = {
    "bim.ai.openai-compatible": t("OpenAI 兼容模型", "OpenAI-compatible model"),
    "bim.ai.parametric-draft": t("AI 参数化建模草案", "AI parametric draft"),
    "bim.ai.data-query-draft": t("自然语言问数", "Natural-language Ask Data"),
    "bim.ai.industrial-diagnosis": t("工业证据诊断", "Industrial evidence diagnosis"),
  };
  return names[plugin.id] ?? plugin.name;
}

function roleName(t: Translate, role: SystemUserRole) {
  return role === "admin" ? t("管理员", "Admin") : role === "viewer" ? t("浏览者", "Viewer") : t("编辑者", "Editor");
}
