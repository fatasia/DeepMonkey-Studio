import { AlertTriangle, Check } from "lucide-react";
import type { JsonValue, TopologyEdge, TopologyNode, TopologyScadaRuntimeState } from "@bim-studio/contracts";
import type { TopologyScadaRuntimeAssessment } from "@bim-studio/studio-core";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

export type TopologyViewMode = "2d" | "2.5d";
export type TopologyEdgeMedium = "signal" | "power" | "water" | "air" | "material";

const TOPOLOGY_ISOMETRIC_X_SCALE = Math.sqrt(3) / 2;
const TOPOLOGY_ISOMETRIC_Y_SCALE = 0.5;
const TOPOLOGY_ISOMETRIC_ORIGIN_X = 600;
const TOPOLOGY_ISOMETRIC_ORIGIN_Y = 40;

export function topologyEdgeLabel(edge: Pick<TopologyEdge, "properties">): string {
  return typeof edge.properties.label === "string" ? edge.properties.label.trim() : "";
}

export function topologyEdgeMedium(edge: Pick<TopologyEdge, "properties">): TopologyEdgeMedium {
  const value = edge.properties.medium;
  return value === "power" || value === "water" || value === "air" || value === "material" ? value : "signal";
}

export function topologyEdgeAnimated(edge: Pick<TopologyEdge, "properties">): boolean {
  return edge.properties.animated === true;
}

export function topologyEdgeStateClass(source: TopologyScadaRuntimeState | undefined, target: TopologyScadaRuntimeState | undefined): string {
  if (source?.state === "offline" || target?.state === "offline") return "is-offline";
  if ([source,target].some(state => state?.state === "alarm" || state?.alarm?.active && state.alarm.severity === "critical")) return "has-alarm";
  if ([source,target].some(state => state?.state === "warning" || state?.alarm?.active)) return "has-warning";
  return "";
}

/** 2.5D 仅改变投影，不改写拓扑文档中的工程坐标。 */
export function topologyNodeElevation(node: Pick<TopologyNode, "properties">): number {
  const value = Number(node.properties.elevation ?? 0);
  return Number.isFinite(value) ? Math.max(-200, Math.min(500, value)) : 0;
}

export function topologyProjectionOffset(elevation: number, viewMode: TopologyViewMode): { x: number; y: number } {
  if (viewMode === "2d") return { x: 0, y: 0 };
  return { x: 0, y: elevation * -0.6 };
}

export function topologyProjectedPosition(node: Pick<TopologyNode, "x" | "y" | "properties">, viewMode: TopologyViewMode): { x: number; y: number } {
  const offset = topologyProjectionOffset(topologyNodeElevation(node), viewMode);
  if (viewMode === "2d") return { x: node.x, y: node.y };
  return {
    x: TOPOLOGY_ISOMETRIC_ORIGIN_X + (node.x - node.y) * TOPOLOGY_ISOMETRIC_X_SCALE,
    y: TOPOLOGY_ISOMETRIC_ORIGIN_Y + (node.x + node.y) * TOPOLOGY_ISOMETRIC_Y_SCALE + offset.y,
  };
}

/** 将拖拽后的屏幕投影坐标还原成工程平面坐标，避免 2.5D 编辑污染持久化坐标。 */
export function topologyPlanPositionFromProjected(
  position: { x: number; y: number },
  elevation: number,
  viewMode: TopologyViewMode,
): { x: number; y: number } {
  if (viewMode === "2d") return position;
  const offset = topologyProjectionOffset(elevation, viewMode);
  const difference = (position.x - TOPOLOGY_ISOMETRIC_ORIGIN_X) / TOPOLOGY_ISOMETRIC_X_SCALE;
  const sum = (position.y - TOPOLOGY_ISOMETRIC_ORIGIN_Y - offset.y) / TOPOLOGY_ISOMETRIC_Y_SCALE;
  return {
    x: (sum + difference) / 2,
    y: (sum - difference) / 2,
  };
}

export function ScadaRuntimeCard({
  locale,
  state,
  assessment,
  unit,
  canAcknowledge,
  acknowledgePending,
  onAcknowledge,
}: {
  locale: AppLocale;
  state: TopologyScadaRuntimeState | undefined;
  assessment: TopologyScadaRuntimeAssessment;
  unit: string;
  canAcknowledge: boolean;
  acknowledgePending: boolean;
  onAcknowledge: () => void;
}) {
  if (!state)
    return (
      <div className="topology-editor__runtime-card is-unknown">
        <span className="topology-editor__runtime-dot" />
        <div>
          <strong>{tr(locale, "等待实时数据", "Waiting for live data")}</strong>
          <small>{tr(locale, "发布运行态后由 SCADA 适配器注入", "Injected by the SCADA adapter at runtime")}</small>
        </div>
      </div>
    );
  const alarm = state.alarm;
  return (
    <div className={`topology-editor__runtime-card is-${state.state} is-freshness-${assessment.freshness} is-quality-${assessment.quality} ${alarm?.active ? "has-alarm" : ""}`}>
      <span className="topology-editor__runtime-dot" />
      <div>
        <strong>
          {scadaStateLabel(locale, state.state)}
          {state.value !== undefined ? ` · ${formatScadaValue(state.value, state.unit ?? unit)}` : ""}
        </strong>
        <small>
          {alarm?.active
            ? alarm.message
            : state.updatedAt
              ? `${tr(locale, "采集", "Sampled")} ${formatRuntimeTimestamp(state.updatedAt, locale)}`
              : tr(locale, "缺少采集时间", "Missing sample timestamp")}
        </small>
        <span className="topology-editor__runtime-diagnostics">
          <em className={`is-${assessment.quality}`}>{qualityLabel(locale, assessment.quality)}</em>
          <em className={`is-${assessment.freshness}`}>{runtimeAssessmentLabel(locale, assessment)}</em>
        </span>
        {alarm?.active && (
          <span className="topology-editor__alarm-acknowledgement">
            {alarm.acknowledged ? (
              <span>
                <Check size={11} />
                {tr(locale, "已确认", "Acknowledged")}
              </span>
            ) : canAcknowledge ? (
              <button type="button" disabled={acknowledgePending} onClick={onAcknowledge}>
                {acknowledgePending ? tr(locale, "确认中…", "Acknowledging…") : tr(locale, "确认告警", "Acknowledge alarm")}
              </button>
            ) : (
              <span className="is-pending">
                <AlertTriangle size={11} />
                {tr(locale, "未确认", "Unacknowledged")}
              </span>
            )}
          </span>
        )}
      </div>
      {alarm?.active && <AlertTriangle size={15} />}
    </div>
  );
}

export function formatScadaValue(value: JsonValue, unit?: string): string {
  const rendered = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—";
  return unit?.trim() ? `${rendered} ${unit.trim()}` : rendered;
}

export function runtimeAssessmentLabel(locale: AppLocale, assessment: TopologyScadaRuntimeAssessment): string {
  if (assessment.freshness === "fresh")
    return assessment.ageMs === undefined ? tr(locale, "实时", "Live") : tr(locale, `${formatAge(assessment.ageMs)}前`, `${formatAge(assessment.ageMs)} ago`);
  const labels: Record<Exclude<TopologyScadaRuntimeAssessment["freshness"], "fresh">, readonly [string, string]> = {
    missing: ["无数据", "No data"],
    undated: ["无时间戳", "No timestamp"],
    stale: ["数据已过期", "Stale"],
    invalid: ["时间戳无效", "Invalid timestamp"],
  };
  return tr(locale, labels[assessment.freshness][0], labels[assessment.freshness][1]);
}

export function qualityLabel(locale: AppLocale, quality: TopologyScadaRuntimeAssessment["quality"]): string {
  const labels: Record<TopologyScadaRuntimeAssessment["quality"], readonly [string, string]> = {
    good: ["质量良好", "Good quality"],
    uncertain: ["质量存疑", "Uncertain quality"],
    bad: ["质量无效", "Bad quality"],
  };
  return tr(locale, labels[quality][0], labels[quality][1]);
}

function formatAge(ageMs: number): string {
  if (ageMs < 1_000) return "<1s";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  return `${Math.floor(ageMs / 3_600_000)}h`;
}

function formatRuntimeTimestamp(timestamp: string, locale: AppLocale): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return timestamp;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
}

export function scadaStateLabel(locale: AppLocale, state: TopologyScadaRuntimeState["state"]): string {
  const labels: Record<TopologyScadaRuntimeState["state"], readonly [string, string]> = {
    unknown: ["未知", "Unknown"],
    offline: ["离线", "Offline"],
    idle: ["待机", "Idle"],
    running: ["运行", "Running"],
    warning: ["预警", "Warning"],
    alarm: ["告警", "Alarm"],
  };
  return tr(locale, labels[state][0], labels[state][1]);
}
