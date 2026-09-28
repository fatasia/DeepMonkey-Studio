/**
 * T29 告警声触发·纯启停规则。
 *
 * 复用既有接口,不定义第二套告警语义:
 * - 事件流直接吃 @bim-studio/studio-core AlertEngine 的 AlertEvent
 *   (阈值/迟滞评估已在 studio-core,零重复);
 * - 绑定形状对齐数据绑定合同的 target.modelId(SceneDataBindingState)与
 *   API alert-state 端点的 AlertStateSnapshot;
 * - 确认消音语义按 ISA-18.2 惯例(acknowledge = 停止声响),可关。
 */

import type { AlertEvent, AlertSeverity, AlertStateSnapshot } from "@bim-studio/studio-core";

export type AlarmCommand = "start" | "stop" | "none";

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, alarm: 2 };

export function severityAtLeast(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

/**
 * 告警声绑定:某台设备(modelId)在哪些规则越限时鸣响。
 * ruleIds 任一命中即绑定;ruleIds 为空 = 全局兜底绑定(所有规则都归它)。
 * 数组序即优先级(director 取第一个命中的绑定)。
 * 注:AlertEvent 不携带 signalId(规则→信号的映射留在 AlertRule),
 * 因此按 signalId 绑定经由 DataEvent(alarm action,自带 target.modelId)路径完成。
 */
export interface AlarmBinding {
  modelId: string;
  /** 告警声最低严重级;info 级不扰民的场景传 "warning"/"alarm"。 */
  minSeverity: AlertSeverity;
  ruleIds?: string[];
}

export interface AlarmPolicy {
  /** 确认即消音(ISA-18.2 audible silencing);默认 true。 */
  silenceOnAcknowledge: boolean;
}

export const DEFAULT_ALARM_POLICY: AlarmPolicy = { silenceOnAcknowledge: true };

export function matchesAlarmBinding(binding: AlarmBinding, ruleId: string): boolean {
  const rules = binding.ruleIds;
  if (!rules || rules.length === 0) return true;
  return rules.includes(ruleId);
}

/**
 * 单条告警事件 → 单台设备的启停命令。
 * ringingRuleId:该设备当前是否在响、由哪条规则触发(undefined = 未响)。
 *
 * 语义(全部可单测):
 * - active + 未响 + 严重级达标 → start;
 * - active + 已响(同规则或他规则)→ none:先响优先、不重启,避免爆音与音量跳变;
 * - acknowledged → stop(仅消音触发它的那条规则在响时);silenceOnAcknowledge=false → none;
 * - cleared → stop(仅当正在响的规则就是被清除的规则;他规则清除不影响本设备)。
 */
export function nextAlarmCommand(
  event: AlertEvent,
  ringingRuleId: string | undefined,
  binding: AlarmBinding,
  policy: AlarmPolicy = DEFAULT_ALARM_POLICY,
): AlarmCommand {
  if (!severityAtLeast(event.severity, binding.minSeverity)) return "none";
  if (event.type === "active") return ringingRuleId ? "none" : "start";
  if (event.type === "acknowledged") {
    if (!policy.silenceOnAcknowledge) return "none";
    return ringingRuleId === event.ruleId ? "stop" : "none";
  }
  return ringingRuleId === event.ruleId ? "stop" : "none";
}

/**
 * web 侧 alert-state 轮询快照差分 → AlertEvent 流。
 * AlertIngestPanel 的数据源是 API alert-state 端点的快照数组而非事件流;
 * 本桥把两次快照的状态转换转成 AlertEvent,让 AlertAudioDirector 直接消费轮询数据。
 *
 * 转换规则:
 * - 之前非 cleared(或不在上一帧)→ 本帧非 cleared:active;
 * - 之前非 cleared → 本帧 cleared(或从快照中消失,视为清除):cleared;
 * - active → acknowledged:acknowledged;
 * - 其余(状态不变、acknowledged→acknowledged、缺失→cleared)不发事件。
 * value 取快照 lastValue,消失的规则取其最后已知值;at 由调用方时钟给出。
 */
export function snapshotTransitionEvents(
  prev: readonly AlertStateSnapshot[],
  next: readonly AlertStateSnapshot[],
  now: number,
): AlertEvent[] {
  const prevByRule = new Map(prev.map((item) => [item.ruleId, item] as const));
  const events: AlertEvent[] = [];
  const seen = new Set<string>();
  for (const item of next) {
    seen.add(item.ruleId);
    const before = prevByRule.get(item.ruleId);
    const wasActive = before !== undefined && before.status !== "cleared";
    const isActive = item.status !== "cleared";
    if (!wasActive && isActive) {
      events.push({ type: "active", ruleId: item.ruleId, severity: item.severity, value: item.lastValue, at: now });
    } else if (wasActive && !isActive) {
      events.push({ type: "cleared", ruleId: item.ruleId, severity: item.severity, value: item.lastValue, at: now });
    } else if (before?.status === "active" && item.status === "acknowledged") {
      events.push({ type: "acknowledged", ruleId: item.ruleId, severity: item.severity, value: item.lastValue, at: now });
    }
  }
  for (const before of prev) {
    if (!seen.has(before.ruleId) && before.status !== "cleared") {
      events.push({ type: "cleared", ruleId: before.ruleId, severity: before.severity, value: before.lastValue, at: now });
    }
  }
  return events;
}
