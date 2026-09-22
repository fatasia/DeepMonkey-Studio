import { useEffect, useState, type ReactNode } from "react";
import { Activity, BellRing, Bot, Braces, CloudCog, FileClock, Gauge, Users } from "lucide-react";
import type {
  AiProviderSettings,
  AuditLogRecord,
  ConverterPluginDescriptor,
  ProjectRecord,
  ServiceHealthRecord,
  SystemUserRecord,
} from "@bim-studio/contracts";
import { api, type AiProviderDescriptor, type SystemPluginSummary } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { PerformanceMaintenancePanel } from "./PerformanceMaintenancePanel.js";
import { CloudRenderControl } from "./CloudRenderControl";
import { SystemNotificationPanel } from "./SystemNotificationPanel";
import { SecondaryPageBack } from "./SecondaryPageBack";
import { SystemHealthPanel, SystemLogPanel } from "./SystemObservabilityPanels";
import { McpSettingsPanel } from "./McpSettingsPanel";

import { UserPanel } from "./SystemUserPanel";
import { AiSettingsPanel } from "./SystemAiSettingsPanel";
import { AiModelingSettingsPanel, AiPluginPanel } from "./SystemAiCapabilityPanels";
export { AiSettingsPanel } from "./SystemAiSettingsPanel";

export type SystemCenterTab = "users" | "health" | "audit" | "ai" | "mcp" | "cloud-render" | "notifications" | "performance";
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
        <TabButton active={tab === "performance"} onClick={() => selectTab("performance")} icon={<Gauge />} label={t("性能与维护", "Performance & maintenance")} />
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
        {tab === "performance" && <PerformanceMaintenancePanel locale={locale} onError={(message) => setError(message)} />}
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
