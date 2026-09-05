import type { JsonValue, TopologyNode, TopologyScadaDataQuality, TopologyScadaOperatingState, TopologyScadaRuntimeState } from "@bim-studio/contracts";
import { isTopologyScadaNode, topologyNodeDataBinding, topologyNodeLabel, topologyNodeScadaConfig } from "@bim-studio/studio-core";
import type { DataProductPreview } from "./sceneDataBindings";

export interface TopologyRuntimeBindingGroup {
  readonly key: string;
  readonly productType: "dataset" | "pipeline";
  readonly productId: string;
  readonly nodes: readonly TopologyNode[];
}

export function groupTopologyRuntimeBindings(nodes: readonly TopologyNode[]): TopologyRuntimeBindingGroup[] {
  const groups = new Map<string, { productType: "dataset" | "pipeline"; productId: string; nodes: TopologyNode[] }>();
  for (const node of nodes) {
    if (!isTopologyScadaNode(node)) continue;
    const binding = topologyNodeDataBinding(node);
    if (!binding) continue;
    const key = `${binding.productType}:${binding.productId}`;
    const group = groups.get(key) ?? { productType: binding.productType, productId: binding.productId, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}

export function createTopologyRuntimeSnapshot(nodes: readonly TopologyNode[], preview: DataProductPreview, sampledAt = new Date().toISOString()): Record<string, TopologyScadaRuntimeState> {
  const row = preview.rows[0];
  return Object.fromEntries(nodes.map((node) => [node.id, runtimeStateForNode(node, row, sampledAt)]));
}

export function createTopologyRuntimeFailure(nodes: readonly TopologyNode[], sampledAt = new Date().toISOString()): Record<string, TopologyScadaRuntimeState> {
  return Object.fromEntries(nodes.map((node) => [node.id, { state: "offline", quality: "bad", updatedAt: sampledAt } satisfies TopologyScadaRuntimeState]));
}

/** Preserve acknowledgement only while the same active alarm remains present. */
export function mergeTopologyRuntimeAcknowledgements(current: Readonly<Record<string, TopologyScadaRuntimeState>>, next: Record<string, TopologyScadaRuntimeState>): Record<string, TopologyScadaRuntimeState> {
  return Object.fromEntries(Object.entries(next).map(([nodeId, state]) => {
    const previousAlarm = current[nodeId]?.alarm;
    if (!state.alarm?.active || !previousAlarm?.active || !previousAlarm.acknowledged || previousAlarm.id !== state.alarm.id) return [nodeId, state];
    return [nodeId, { ...state, alarm: { ...state.alarm, acknowledged: true, ...(previousAlarm.acknowledgedAt ? { acknowledgedAt: previousAlarm.acknowledgedAt } : {}), ...(previousAlarm.acknowledgedBy ? { acknowledgedBy: previousAlarm.acknowledgedBy } : {}) } }];
  }));
}

function runtimeStateForNode(node: TopologyNode, row: Record<string, unknown> | undefined, sampledAt: string): TopologyScadaRuntimeState {
  const binding = topologyNodeDataBinding(node);
  const config = topologyNodeScadaConfig(node);
  if (!binding || !row || !(binding.field in row)) return { state: "unknown", quality: "bad", updatedAt: sampledAt };

  const rawValue = row[binding.field];
  const numericValue = finiteNumber(rawValue);
  const lowAlarm = config?.lowAlarm;
  const highAlarm = config?.highAlarm;
  const lowActive = numericValue !== undefined && lowAlarm !== undefined && numericValue <= lowAlarm;
  const highActive = numericValue !== undefined && highAlarm !== undefined && numericValue >= highAlarm;
  const alarm = lowActive || highActive
    ? {
        id: `${node.id}:${lowActive ? "low" : "high"}`,
        active: true,
        severity: config?.alarmSeverity ?? "warning" as const,
        message: `${topologyNodeLabel(node)}${lowActive ? "低于" : "高于"}阈值 ${lowActive ? lowAlarm : highAlarm}`,
        occurredAt: timestampFromRow(row, binding.field, sampledAt)
      }
    : undefined;

  return {
    state: alarm ? "alarm" : operatingStateFromRow(row, binding.field, rawValue),
    value: toJsonValue(rawValue),
    ...(config?.unit ? { unit: config.unit } : {}),
    quality: qualityFromRow(row, binding.field),
    ...(alarm ? { alarm } : {}),
    updatedAt: timestampFromRow(row, binding.field, sampledAt)
  };
}

function operatingStateFromRow(row: Record<string, unknown>, field: string, value: unknown): TopologyScadaOperatingState {
  const explicit = row[`${field}State`] ?? row[`${field}_state`] ?? row.state ?? row.status;
  if (typeof explicit === "string") {
    const normalized = explicit.trim().toLowerCase();
    if (["unknown", "未知"].includes(normalized)) return "unknown";
    if (["offline", "disconnected", "down", "离线", "断开"].includes(normalized)) return "offline";
    if (["alarm", "critical", "fault", "error", "告警", "故障"].includes(normalized)) return "alarm";
    if (["warning", "warn", "异常", "预警"].includes(normalized)) return "warning";
    if (["idle", "standby", "stopped", "空闲", "待机", "停止"].includes(normalized)) return "idle";
    if (["running", "online", "active", "ok", "运行", "在线", "正常"].includes(normalized)) return "running";
  }
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "running" : "idle";
  return "running";
}

function qualityFromRow(row: Record<string, unknown>, field: string): TopologyScadaDataQuality {
  const value = row[`${field}Quality`] ?? row[`${field}_quality`] ?? row.quality;
  if (typeof value !== "string") return "good";
  const normalized = value.trim().toLowerCase();
  if (["bad", "invalid", "error", "无效", "错误"].includes(normalized)) return "bad";
  if (["uncertain", "stale", "questionable", "不确定", "过期"].includes(normalized)) return "uncertain";
  return "good";
}

function timestampFromRow(row: Record<string, unknown>, field: string, fallback: string): string {
  const value = row[`${field}UpdatedAt`] ?? row[`${field}_timestamp`] ?? row.updatedAt ?? row.timestamp ?? row.time ?? row.ts;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : JSON.parse(serialized) as JsonValue;
  } catch {
    return String(value);
  }
}
