import { useEffect, useState, type ReactNode } from "react";
import { Activity, BellRing, Bot, CheckCircle2, CloudCog, FileClock, KeyRound, Pencil, PlugZap, Plus, Power, Save, Trash2, Users, XCircle } from "lucide-react";
import type {
  AiProviderSettings,
  AuditLogRecord,
  ConverterPluginDescriptor,
  ProjectRecord,
  ServiceHealthRecord,
  ServiceLogRecord,
  SystemUserRecord,
  SystemUserRole,
} from "@bim-studio/contracts";
import { api, type AiProviderDescriptor, type SystemPluginSummary } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { CloudRenderControl } from "./CloudRenderControl";
import { SystemNotificationPanel } from "./SystemNotificationPanel";
import { SecondaryPageBack } from "./SecondaryPageBack";

export type SystemCenterTab = "users" | "health" | "audit" | "ai" | "cloud-render" | "notifications";
type Translate = (zh: string, en: string) => string;

export function SystemCenter({
  locale,
  currentUser,
  projects,
  initialTab = "users",
  onBack,
}: {
  locale: AppLocale;
  currentUser: SystemUserRecord;
  projects: ProjectRecord[];
  initialTab?: SystemCenterTab;
  onBack: () => void;
}) {
  const t: Translate = (zh, en) => tr(locale, zh, en);
  const [tab, setTab] = useState<SystemCenterTab>(initialTab);
  const [users, setUsers] = useState<SystemUserRecord[]>([]);
  const [health, setHealth] = useState<ServiceHealthRecord[]>([]);
  const [logs, setLogs] = useState<AuditLogRecord[]>([]);
  const [serviceLogs, setServiceLogs] = useState<ServiceLogRecord[]>([]);
  const [ai, setAi] = useState<AiProviderSettings>();
  const [aiProviders, setAiProviders] = useState<AiProviderDescriptor[]>([]);
  const [plugins, setPlugins] = useState<SystemPluginSummary[]>([]);
  const [converters, setConverters] = useState<ConverterPluginDescriptor[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SystemUserRecord | "new">();

  async function load() {
    setError(undefined);
    try {
      const [u, h, l, sl, a, p, c, providerCatalog] = await Promise.all([
        api.listUsers(),
        api.getSystemHealth(),
        api.listAuditLogs(),
        api.listServiceLogs(),
        api.getAiSettings(),
        api.listPlugins(),
        api.listConverters(),
        api.listAiProviders(),
      ]);
      setUsers(u);
      setHealth(h);
      setLogs(l);
      setServiceLogs(sl);
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

  return (
    <main className="system-center-page">
      <header className="secondary-page-header">
        <SecondaryPageBack locale={locale} onBack={onBack} />
        <div className="secondary-page-heading-row">
          <div className="secondary-page-title">
            <small>SYSTEM CONTROL</small>
            <h1>{t("系统管理", "System management")}</h1>
            <p>{t("用户授权、服务健康、通知推送、云渲染、操作审计与 AI 配置", "Users, service health, notifications, cloud rendering, audit logs and AI settings")}</p>
          </div>
        </div>
      </header>
      {error && <div className="system-error">{error}</div>}
      <nav className="system-tabs">
        <TabButton active={tab === "users"} onClick={() => setTab("users")} icon={<Users />} label={t("用户与权限", "Users & access")} />
        <TabButton active={tab === "health"} onClick={() => setTab("health")} icon={<Activity />} label={t("服务健康", "Service health")} />
        <TabButton active={tab === "cloud-render"} onClick={() => setTab("cloud-render")} icon={<CloudCog />} label={t("云渲染设置", "Cloud settings")} />
        <TabButton active={tab === "notifications"} onClick={() => setTab("notifications")} icon={<BellRing />} label={t("通知与推送", "Notifications")} />
        <TabButton active={tab === "audit"} onClick={() => setTab("audit")} icon={<FileClock />} label={t("审计与日志", "Audit & logs")} />
        <TabButton active={tab === "ai"} onClick={() => setTab("ai")} icon={<Bot />} label={t("AI 大模型", "AI model")} />
      </nav>
      <section className="system-content">
        {tab === "users" && (
          <UserPanel t={t} users={users} projects={projects} currentUser={currentUser} editing={editing} setEditing={setEditing} onReload={load} onError={setError} />
        )}
        {tab === "health" && <HealthPanel t={t} health={health} converters={converters} />}
        {tab === "cloud-render" && <CloudRenderControl locale={locale} />}
        {tab === "notifications" && <SystemNotificationPanel locale={locale} projects={projects} t={t} />}
        {tab === "audit" && <AuditPanel t={t} logs={logs} serviceLogs={serviceLogs} />}
        {tab === "ai" && ai && (
          <div className="system-ai-layout">
            <AiSettingsPanel t={t} initial={ai} providers={aiProviders} onSaved={setAi} onError={setError} />
            <AiPluginPanel t={t} plugins={plugins} onReload={load} onError={setError} />
          </div>
        )}
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

function HealthPanel({ t, health, converters }: { t: Translate; health: ServiceHealthRecord[]; converters: ConverterPluginDescriptor[] }) {
  return (
    <div className="system-health-layout">
      <div className="system-health-grid">
        {health.map((service) => (
          <article key={service.id}>
            <div className={service.status}>{service.status === "healthy" ? <CheckCircle2 /> : <XCircle />}</div>
            <span>
              <strong>{service.name}</strong>
              <small>{service.endpoint}</small>
            </span>
            <em>{service.status === "healthy" ? `${service.latencyMs ?? 0} ms` : (service.message ?? t("离线", "Offline"))}</em>
          </article>
        ))}
      </div>
      <section className="system-converter-health">
        <header>
          <span>
            <PlugZap size={17} />
            <strong>{t("工业格式转换器", "Industrial format converters")}</strong>
          </span>
          <small>
            {t("目录可见不代表运行时已安装；状态来自服务端命令探测。", "Catalog presence does not mean the runtime is installed; status comes from server-side probing.")}
          </small>
        </header>
        <div>
          {converters.map((converter) => (
            <article key={converter.manifest.id} className={converter.available ? "available" : "unavailable"}>
              <i>{converter.available ? <CheckCircle2 size={16} /> : <XCircle size={16} />}</i>
              <span>
                <strong>{converter.manifest.name}</strong>
                <small>
                  {converter.manifest.inputFormats.map((format) => format.toUpperCase()).join(" / ")} · v{converter.manifest.version}
                </small>
                <em>{converter.provider?.message ?? converter.unavailableReason}</em>
              </span>
              <b>{converter.available ? t("可执行", "Ready") : t("待部署", "Setup required")}</b>
              {!converter.available && converter.provider?.remediation && <p>{converter.provider.remediation}</p>}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function AuditPanel({ t, logs, serviceLogs }: { t: Translate; logs: AuditLogRecord[]; serviceLogs: ServiceLogRecord[] }) {
  return (
    <div className="system-audit-layout">
      <div className="system-audit">
        <header>
          <strong>{t("最近操作", "Recent activity")}</strong>
          <span>{t("最多保留 2,000 条", "Up to 2,000 records")}</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>{t("时间", "Time")}</th>
              <th>{t("用户", "User")}</th>
              <th>{t("动作", "Action")}</th>
              <th>{t("资源", "Resource")}</th>
              <th>{t("状态", "Status")}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{new Date(log.createdAt).toLocaleString()}</td>
                <td>{log.username ?? t("系统", "System")}</td>
                <td>{log.action}</td>
                <td title={log.resource}>{log.resource}</td>
                <td className={log.statusCode >= 400 ? "error" : "ok"}>{log.statusCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <aside className="system-service-logs">
        <header>
          <strong>{t("服务错误日志", "Service error logs")}</strong>
          <span>{t("每个服务最近 100 行", "Latest 100 lines per service")}</span>
        </header>
        {serviceLogs.map((log) => (
          <details key={log.file} open={log.lines.length > 0}>
            <summary>
              <span>{log.service}</span>
              <i>{log.lines.length}</i>
            </summary>
            <pre>{log.lines.length ? log.lines.join("\n") : t("无错误", "No errors")}</pre>
          </details>
        ))}
      </aside>
    </div>
  );
}

function AiSettingsPanel({
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
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      onSaved(await api.saveAiSettings({ providerId, baseUrl, model, protocol, temperature, ...(apiKey ? { apiKey } : {}) }));
      setApiKey("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      const result = await api.testAiSettings({
        providerId,
        baseUrl,
        model,
        protocol,
        temperature,
        ...(apiKey ? { apiKey } : {}),
      });
      alert(t(`连接成功：${result.model}`, `Connected: ${result.model}`));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const credentialContextChanged = providerId !== initial.providerId || baseUrl.replace(/\/$/, "") !== initial.baseUrl;
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
        <input value={model} onChange={(event) => setModel(event.target.value)} />
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
      <footer>
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
