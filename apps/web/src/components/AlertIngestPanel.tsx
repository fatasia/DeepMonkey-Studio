import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { DataEvent, NotificationSeverity } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { DeviceSignalView } from "../components/DeviceSignalView";
import "./AlertIngestPanel.css";

// P3 UI 呈现切片:告警状态面板。数据源 = API 的 alert-state/acknowledge 端点
// (背后是 AlertRuleRuntime + DataEventBus);呈现复用 DeviceSignalView 的
// 语义色/文案合同,不引入第二套告警视觉。

export interface AlertStateSnapshot {
  ruleId: string;
  label: string;
  signalId: string;
  severity: "info" | "warning" | "alarm";
  status: "active" | "acknowledged" | "cleared";
  since: number;
  lastValue: number | null;
  acknowledgedAt: number | null;
  clearedAt: number | null;
}

interface AlertRuleSummary {
  id: string;
  label: string;
  signalId: string;
  kind: string;
  threshold: number;
}

const SEVERITY_TOKEN: Record<AlertStateSnapshot["severity"], string> = {
  info: "info",
  warning: "warning",
  alarm: "danger",
};

function toSignalSnapshot(snapshot: AlertStateSnapshot) {
  const active = snapshot.status !== "cleared";
  const severity: NotificationSeverity = snapshot.severity === "alarm" ? "critical" : snapshot.severity === "warning" ? "warning" : "info";
  return {
    state: snapshot.status === "cleared" ? "normal" : snapshot.severity === "alarm" ? "alarm" : "warning",
    active: snapshot.status !== "cleared",
    acknowledged: snapshot.status === "acknowledged",
    severity,
    value: snapshot.lastValue,
    message: snapshot.label,
  } as const;
}

export function AlertIngestPanel({ projectId, request, locale }: {
  projectId: string;
  /** 注入的传输通道(raw fetch 只允许在 api.ts;面板只持有此函数)。 */
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  locale: AppLocale;
}) {
  const [rules, setRules] = useState<AlertRuleSummary[]>([]);
  const [states, setStates] = useState<AlertStateSnapshot[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const [rules, states] = await Promise.all([
        request<AlertRuleSummary[]>(`/api/projects/${projectId}/alert-rules`),
        request<AlertStateSnapshot[]>(`/api/projects/${projectId}/alert-state`),
      ]);
      setRules(rules);
      setStates(states);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [projectId, request]);

  useEffect(() => { void refresh(); }, [refresh]);

  const acknowledge = useCallback(async (ruleId: string) => {
    setPending(ruleId);
    try {
      await request(`/api/projects/${projectId}/alert-rules/${ruleId}/acknowledge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  }, [projectId, request, refresh]);

  const removeRule = useCallback(async (ruleId: string) => {
    setPending(ruleId);
    try {
      await request(`/api/projects/${projectId}/alert-rules/${ruleId}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  }, [projectId, request, refresh]);

  const statesByRule = useMemo(() => new Map(states.map((state) => [state.ruleId, state])), [states]);
  const activeCount = states.filter((state) => state.status === "active").length;

  return <section className="alert-ingest-panel" aria-label={tr(locale, "告警规则与状态", "Alert rules and states")}>
    <header className="alert-ingest-panel__header">
      <h3>{tr(locale, "告警规则与状态", "Alert rules and states")}</h3>
      <span className="alert-ingest-panel__badge" data-active={activeCount > 0 || undefined}>
        {activeCount > 0 ? tr(locale, `${activeCount} 条激活`, `${activeCount} active`) : tr(locale, "无激活告警", "No active alerts")}
      </span>
      <button type="button" onClick={() => void refresh()}>{tr(locale, "刷新", "Refresh")}</button>
    </header>
    {error && <p role="alert" className="alert-ingest-panel__error">{error}</p>}
    {rules.length === 0 && states.length === 0
      ? <p className="alert-ingest-panel__empty">{tr(locale, "尚未定义告警规则。", "No alert rules defined.")}</p>
      : <ul className="alert-ingest-panel__list">
        {states.map((state) => {
          const rule = rules.find((item) => item.id === state.ruleId);
          return <li key={state.ruleId}>
            <DeviceSignalView
              signal={toSignalSnapshot(state) as never}
              title={`${state.label} · ${state.signalId}`}
              locale={locale}
              pending={pending === state.ruleId}
              {...(state.status === "active" ? { onAcknowledge: () => void acknowledge(state.ruleId) } : {})}
            />
            {rule && <small className="alert-ingest-panel__rule">
              {rule.kind === "threshold-above" ? ">" : "<"} {rule.threshold}
              <button type="button" className="alert-ingest-panel__remove" disabled={pending === state.ruleId}
                onClick={() => void removeRule(state.ruleId)}>{tr(locale, "删除规则", "Delete rule")}</button>
            </small>}
          </li>;
        })}
      </ul>}
  </section>;
}

export function alertEventToSnapshot(event: DataEvent): AlertStateSnapshot {
  const value = event.value as { state?: string; active?: boolean; severity?: AlertStateSnapshot["severity"]; acknowledged?: boolean; value?: number; ruleId?: string };
  const status = value.state === "active" ? "active" : value.state === "acknowledged" ? "acknowledged" : "cleared";
  return {
    ruleId: value.ruleId ?? event.key.replace(/^alert\//, ""),
    label: String((event.value as { message?: string }).message ?? event.key),
    signalId: event.source,
    severity: value.severity ?? "info",
    status,
    since: Date.parse(event.timestamp),
    lastValue: typeof value.value === "number" ? value.value : null,
    acknowledgedAt: status === "acknowledged" ? Date.parse(event.timestamp) : null,
    clearedAt: status === "cleared" ? Date.parse(event.timestamp) : null,
  };
}


