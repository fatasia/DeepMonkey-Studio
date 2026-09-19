// P3 告警与事件引擎·切片一（2026-09-19 用户批准的轻量切片）：
// 数据信号 → 规则评估 → 告警生命周期（激活/确认/清除）的纯逻辑核心。
// 带迟滞防抖动、状态去重（状态未变不重复发事件）、显式缺信号处理；
// deviceSignalPresentation.ts 的语义色/文案仍由呈现层承担，不在此重复。

export type AlertSeverity = "info" | "warning" | "alarm";

export interface AlertRule {
  id: string;
  label: string;
  signalId: string;
  kind: "threshold-above" | "threshold-below";
  threshold: number;
  severity: AlertSeverity;
  /** 清除迟滞（与阈值同单位）：激活后需越过 threshold ∓ hysteresis 才允许清除，防贴线抖动。 */
  hysteresis?: number;
}

export type AlertStatus = "active" | "acknowledged" | "cleared";

export interface AlertStateSnapshot {
  ruleId: string;
  label: string;
  signalId: string;
  severity: AlertSeverity;
  status: AlertStatus;
  since: number;
  lastValue: number | null;
  acknowledgedAt: number | null;
  clearedAt: number | null;
}

export interface AlertEvent {
  type: "active" | "acknowledged" | "cleared";
  ruleId: string;
  severity: AlertSeverity;
  value: number | null;
  at: number;
}

export interface SignalSample {
  values: Record<string, number>;
  at: number;
}

export interface AlertEngineOptions {
  /** 信号停止更新的宽限期：超过后规则按缺信号显式跳过（不误报、也不静默）。 */
  staleAfterMs?: number;
}

interface InternalState extends AlertStateSnapshot {
  violated: boolean;
  lastSeenAt: number;
}

export class AlertEngine {
  private readonly states = new Map<string, InternalState>();

  constructor(private readonly rules: AlertRule[], private readonly options: AlertEngineOptions = {}) {}

  /** 推入一个采样时刻，返回本时刻产生的事件（状态未变则返回空数组）。 */
  evaluate(sample: SignalSample): AlertEvent[] {
    const events: AlertEvent[] = [];
    for (const rule of this.rules) {
      let state = this.states.get(rule.id);
      if (!state) {
        state = {
          ruleId: rule.id, label: rule.label, signalId: rule.signalId, severity: rule.severity,
          status: "cleared", since: sample.at, lastValue: null, acknowledgedAt: null, clearedAt: sample.at,
          violated: false, lastSeenAt: sample.at,
        };
        this.states.set(rule.id, state);
      }
      const raw = sample.values[rule.signalId];
      const stale = this.options.staleAfterMs !== undefined && sample.at - state.lastSeenAt > this.options.staleAfterMs;
      const hasValue = typeof raw === "number" && Number.isFinite(raw);
      if (!hasValue) {
        // 缺信号：保持现状但记录在案——不虚构数值，也不重复发事件。
        if (stale && state.status !== "cleared") {
          state.status = "cleared";
          state.clearedAt = sample.at;
          state.violated = false;
          events.push({ type: "cleared", ruleId: rule.id, severity: rule.severity, value: null, at: sample.at });
        }
        continue;
      }
      state.lastSeenAt = sample.at;
      state.lastValue = raw;

      const violated = rule.kind === "threshold-above" ? raw > rule.threshold : raw < rule.threshold;
      const hysteresis = rule.hysteresis ?? 0;
      const recovered = rule.kind === "threshold-above"
        ? raw <= rule.threshold - hysteresis
        : raw >= rule.threshold + hysteresis;

      if (violated && !state.violated) {
        state.violated = true;
        state.status = "active";
        state.since = sample.at;
        state.acknowledgedAt = null;
        state.clearedAt = null;
        events.push({ type: "active", ruleId: rule.id, severity: rule.severity, value: raw, at: sample.at });
      } else if (!violated && state.violated && recovered) {
        state.violated = false;
        state.status = "cleared";
        state.clearedAt = sample.at;
        events.push({ type: "cleared", ruleId: rule.id, severity: rule.severity, value: raw, at: sample.at });
      } else if (violated && state.violated) {
        // 持续越限：状态不变（active 保持，acknowledged 保持），无事件。
      }
    }
    return events;
  }

  acknowledge(ruleId: string, at: number): boolean {
    const state = this.states.get(ruleId);
    if (!state || state.status !== "active") return false;
    state.status = "acknowledged";
    state.acknowledgedAt = at;
    return true;
  }

  snapshot(): AlertStateSnapshot[] {
    return [...this.states.values()].map(({ violated: _violated, lastSeenAt: _lastSeenAt, ...snapshot }) => snapshot);
  }
}
