import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash2, Copy, Download, PlugZap, RefreshCw, Search, XCircle } from "lucide-react";
import type {
  AuditLogRecord,
  ConverterPluginDescriptor,
  ServiceHealthRecord,
  ServiceLogLevel,
  ServiceLogQueryResult,
} from "@bim-studio/contracts";
import { api } from "../api";
import { downloadBlob } from "../browserDownload";

type Translate = (zh: string, en: string) => string;
type LogFilters = {
  service: string;
  level: "" | ServiceLogLevel;
  from: string;
  to: string;
  keyword: string;
  limit: number;
};
const EMPTY_FILTERS: LogFilters = { service: "", level: "", from: "", to: "", keyword: "", limit: 300 };
const EMPTY_LOGS: ServiceLogQueryResult = { items: [], total: 0, truncated: false, services: [], generatedAt: "" };

export function SystemHealthPanel({
  t,
  initialHealth,
  converters,
  onError,
}: {
  t: Translate;
  initialHealth: ServiceHealthRecord[];
  converters: ConverterPluginDescriptor[];
  onError: (message: string) => void;
}) {
  const [health, setHealth] = useState(initialHealth);
  const [busy, setBusy] = useState<"refresh" | "copy" | "download">();
  const [notice, setNotice] = useState<string>();
  useEffect(() => setHealth(initialHealth), [initialHealth]);

  async function run(action: "refresh" | "copy" | "download") {
    setBusy(action);
    setNotice(undefined);
    try {
      if (action === "refresh") {
        setHealth(await api.getSystemHealth());
        setNotice(t("健康状态已刷新", "Health refreshed"));
      } else if (action === "copy") {
        const snapshot = await api.getSystemDiagnostics();
        await copyText(JSON.stringify(snapshot, null, 2));
        setNotice(t("诊断信息已复制（已脱敏）", "Redacted diagnostics copied"));
      } else {
        const blob = await api.downloadSystemDiagnostics();
        downloadBlob(blob, `bim-studio-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
        setNotice(t("诊断包已下载", "Diagnostic bundle downloaded"));
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="system-health-layout">
      <header className="system-observability-toolbar">
        <span>
          <strong>{t("运行健康", "Runtime health")}</strong>
          <small>{t("状态来自实时服务探针，不以端口占用代替健康。", "States come from live probes, not port occupancy alone.")}</small>
        </span>
        <div>
          <button className="system-icon-action" title={t("刷新健康状态", "Refresh health")} aria-label={t("刷新健康状态", "Refresh health")} disabled={Boolean(busy)} onClick={() => void run("refresh")}><RefreshCw size={15} /></button>
          <button className="system-icon-action" title={t("复制脱敏诊断", "Copy redacted diagnostics")} aria-label={t("复制脱敏诊断", "Copy redacted diagnostics")} disabled={Boolean(busy)} onClick={() => void run("copy")}><Copy size={15} /></button>
          <button className="system-icon-action primary" title={t("下载诊断包", "Download diagnostic bundle")} aria-label={t("下载诊断包", "Download diagnostic bundle")} disabled={Boolean(busy)} onClick={() => void run("download")}><Download size={15} /></button>
        </div>
      </header>
      {notice && <p className="system-observability-notice" role="status">{notice}</p>}
      <div className="system-health-grid">
        {health.map((service) => {
          const Icon = service.status === "healthy" ? CheckCircle2 : service.status === "degraded" ? AlertTriangle : service.status === "not-configured" ? CircleSlash2 : XCircle;
          return (
            <article key={service.id}>
              <div className={service.status}><Icon /></div>
              <span>
                <strong>{service.name}</strong>
                <small>{service.endpoint}</small>
                <small>{t("检查于", "Checked")} {new Date(service.checkedAt).toLocaleString()}</small>
              </span>
              <em>
                <b>{healthLabel(t, service.status)}</b>
                {service.latencyMs !== undefined && <small>{service.latencyMs} ms</small>}
                {service.message && <small title={service.message}>{service.message}</small>}
              </em>
            </article>
          );
        })}
      </div>
      <section className="system-converter-health">
        <header>
          <span><PlugZap size={17} /><strong>{t("工业格式转换器", "Industrial format converters")}</strong></span>
          <small>{t("目录可见不代表运行时已安装；状态来自服务端命令探测。", "Catalog presence does not mean the runtime is installed; status comes from server-side probing.")}</small>
        </header>
        <div>
          {converters.map((converter) => (
            <article key={converter.manifest.id} className={converter.available ? "available" : "unavailable"}>
              <i>{converter.available ? <CheckCircle2 size={16} /> : <XCircle size={16} />}</i>
              <span>
                <strong>{converter.manifest.name}</strong>
                <small>{converter.manifest.inputFormats.map((format) => format.toUpperCase()).join(" / ")} · v{converter.manifest.version}</small>
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

export function SystemLogPanel({ t, auditLogs, onError, initialResult = EMPTY_LOGS }: { t: Translate; auditLogs: AuditLogRecord[]; onError: (message: string) => void; initialResult?: ServiceLogQueryResult }) {
  const [draft, setDraft] = useState<LogFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [result, setResult] = useState<ServiceLogQueryResult>(initialResult);
  const [busy, setBusy] = useState(false);
  const serviceOptions = useMemo(() => [...new Set([...result.services, ...(draft.service ? [draft.service] : [])])].sort(), [draft.service, result.services]);

  async function load(next = filters) {
    setBusy(true);
    try {
      setResult(await api.queryServiceLogs(toApiFilters(next)));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(EMPTY_FILTERS); }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    setFilters(draft);
    void load(draft);
  }

  async function exportLogs() {
    setBusy(true);
    try {
      const blob = await api.exportServiceLogs(toApiFilters(filters));
      downloadBlob(blob, `bim-studio-service-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="system-audit-layout system-observability-layout">
      <section className="system-service-log-manager">
        <header>
          <span><strong>{t("服务日志", "Service logs")}</strong><small>{t("查询结果始终由服务端脱敏", "Results are always redacted server-side")}</small></span>
          <button disabled={busy || result.items.length === 0} onClick={() => void exportLogs()}><Download size={14} />{t("导出当前筛选", "Export filtered")}</button>
        </header>
        <form className="system-log-filters" onSubmit={submit}>
          <label>{t("服务", "Service")}<select value={draft.service} onChange={(event) => setDraft({ ...draft, service: event.target.value })}><option value="">{t("全部服务", "All services")}</option>{serviceOptions.map((service) => <option key={service}>{service}</option>)}</select></label>
          <label>{t("级别", "Level")}<select value={draft.level} onChange={(event) => setDraft({ ...draft, level: event.target.value as "" | ServiceLogLevel })}><option value="">{t("全部级别", "All levels")}</option><option value="debug">DEBUG</option><option value="info">INFO</option><option value="warn">WARN</option><option value="error">ERROR</option></select></label>
          <label>{t("开始", "From")}<input type="datetime-local" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
          <label>{t("结束", "To")}<input type="datetime-local" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
          <label className="system-log-keyword">{t("关键词", "Keyword")}<span><Search size={14} /><input value={draft.keyword} placeholder={t("消息或服务名", "Message or service")} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} /></span></label>
          <button className="primary" disabled={busy} type="submit">{busy ? t("查询中…", "Searching…") : t("查询", "Search")}</button>
        </form>
        <div className="system-log-summary"><span>{t("匹配", "Matched")} {result.total} {t("条", "entries")}</span>{result.truncated && <b>{t("结果已按安全上限截断", "Result capped for safety")}</b>}</div>
        <div className="system-log-table-wrap">
          <table className="system-log-table">
            <thead><tr><th>{t("时间", "Time")}</th><th>{t("级别", "Level")}</th><th>{t("服务", "Service")}</th><th>{t("消息", "Message")}</th></tr></thead>
            <tbody>{result.items.map((entry) => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleString()}</td><td><b className={`log-level ${entry.level}`}>{entry.level.toUpperCase()}</b></td><td>{entry.service}</td><td><pre>{entry.message}</pre></td></tr>)}</tbody>
          </table>
          {!busy && result.items.length === 0 && <p className="system-log-empty">{t("当前筛选没有日志", "No logs match the current filters")}</p>}
        </div>
      </section>
      <section className="system-audit">
        <header><strong>{t("最近操作", "Recent activity")}</strong><span>{t("最多保留 2,000 条；本页不提供审计导出", "Up to 2,000 records; audit export is not provided here")}</span></header>
        <table><thead><tr><th>{t("时间", "Time")}</th><th>{t("用户", "User")}</th><th>{t("动作", "Action")}</th><th>{t("资源", "Resource")}</th><th>{t("状态", "Status")}</th></tr></thead><tbody>
          {auditLogs.map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.username ?? t("系统", "System")}</td><td>{log.action}</td><td title={log.resource}>{log.resource}</td><td className={log.statusCode >= 400 ? "error" : "ok"}>{log.statusCode}</td></tr>)}
        </tbody></table>
      </section>
    </div>
  );
}

function healthLabel(t: Translate, status: ServiceHealthRecord["status"]): string {
  if (status === "healthy") return t("健康", "Healthy");
  if (status === "degraded") return t("降级", "Degraded");
  if (status === "not-configured") return t("未配置", "Not configured");
  return t("离线", "Offline");
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("当前浏览器不允许复制，请下载诊断包");
}

function toApiFilters(filters: LogFilters): { service?: string; level?: ServiceLogLevel; from?: string; to?: string; keyword?: string; limit: number } {
  return {
    ...(filters.service ? { service: filters.service } : {}),
    ...(filters.level ? { level: filters.level } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.keyword ? { keyword: filters.keyword } : {}),
    limit: filters.limit,
  };
}
