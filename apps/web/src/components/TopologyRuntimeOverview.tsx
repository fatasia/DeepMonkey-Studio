import { AlertTriangle, CircleDot, Gauge, HelpCircle, ShieldCheck, WifiOff } from "lucide-react";
import type { TopologyScadaRuntimeSummary } from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";

export function TopologyRuntimeOverview({ summary, locale }: { summary: TopologyScadaRuntimeSummary; locale: AppLocale }) {
  if (!summary.total) return null;
  const items = [
    { count: summary.missing, waiting: true, label: tr(locale, "待数据", "awaiting data"), icon: CircleDot, title: tr(locale, "尚未收到运行快照，不代表设备离线", "No runtime snapshot received; not an offline diagnosis") },
    { count: summary.unknown, label: tr(locale, "未知", "unknown"), icon: HelpCircle, title: tr(locale, "已收到数据，但运行状态未知", "Data received; operating state is unknown") },
    { count: summary.offline, label: tr(locale, "离线", "offline"), icon: WifiOff },
    { count: summary.stale + summary.undated + summary.invalidTimestamp, label: tr(locale, "时效异常", "timestamp issues"), icon: CircleDot },
    { count: summary.badQuality + summary.uncertainQuality, label: tr(locale, "质量异常", "quality issues"), icon: Gauge },
  ];
  return (
    <div className="topology-editor__runtime-overview" role="status" aria-label={tr(locale, "SCADA 运行诊断", "SCADA runtime diagnostics")}>
      <span className="is-healthy"><ShieldCheck size={13} /><strong>{summary.healthy}/{summary.total}</strong>{tr(locale, "健康", "healthy")}</span>
      {items.filter(item => item.count > 0).map(({ count, label, icon: Icon, title, waiting }) => (
        <span key={label} className={waiting ? "is-waiting" : "has-issue"} title={title}><Icon size={13} /><strong>{count}</strong>{label}</span>
      ))}
      {summary.activeAlarms > 0 && <span className="has-alarm"><AlertTriangle size={13} /><strong>{summary.activeAlarms}</strong>{tr(locale, "告警", "alarms")}
        {summary.unacknowledgedAlarms > 0 && <em>{summary.unacknowledgedAlarms} {tr(locale, "未确认", "unacknowledged")}</em>}
      </span>}
    </div>
  );
}
