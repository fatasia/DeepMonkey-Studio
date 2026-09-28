/**
 * T29 告警声运行时·端口化调度器。
 *
 * 职责:把 AlertEvent 流(来自 studio-core AlertEngine.evaluate 或
 * alertAudioRules.snapshotTransitionEvents 的快照差分)按绑定规则映射为
 * 每台设备的告警声启停,经 AlarmSink 端口出口;自身零 Web Audio 依赖,
 * 可在 node 环境做泄漏与幂等测试。
 *
 * 出口适配:AlarmSink 的生产实现是 ViewerEngineSpatialAudio 的
 * startAlertOverride / stopAlertOverride(告警音独占该模型声源,清除后恢复);
 * 测试实现是记录调用的 spy。
 */

import type { AlertEvent, AlertSeverity } from "@bim-studio/studio-core";
import { matchesAlarmBinding, nextAlarmCommand, type AlarmBinding, type AlarmPolicy } from "./alertAudioRules";

/** 告警声出口端口:把 modelId 的声源切入/切出告警循环。 */
export interface AlarmSink {
  startAlarm(modelId: string): void;
  stopAlarm(modelId: string): void;
}

interface RingingState {
  ruleId: string;
  modelId: string;
  severity: AlertSeverity;
}

export interface AlertAudioDirectorOptions {
  bindings: readonly AlarmBinding[];
  policy?: AlarmPolicy;
}

export class AlertAudioDirector {
  private readonly ringing = new Map<string, RingingState>();
  private disposed = false;

  constructor(
    private readonly sink: AlarmSink,
    private readonly bindings: readonly AlarmBinding[],
    private readonly policy: AlarmPolicy = { silenceOnAcknowledge: true },
  ) {}

  /** 正在鸣响的设备数(泄漏与状态断言用)。 */
  get ringingCount(): number {
    return this.ringing.size;
  }

  isRinging(modelId: string): boolean {
    return this.ringing.has(modelId);
  }

  ringingRuleId(modelId: string): string | undefined {
    return this.ringing.get(modelId)?.ruleId;
  }

  /** 消费一批告警事件;幂等:重复事件不会重复启停声源。 */
  handleEvents(events: readonly AlertEvent[]): void {
    if (this.disposed) return;
    for (const event of events) {
      const binding = this.bindings.find((candidate) => matchesAlarmBinding(candidate, event.ruleId));
      if (!binding) continue;
      const modelId = binding.modelId;
      const current = this.ringing.get(modelId);
      const command = nextAlarmCommand(event, current?.ruleId, binding, this.policy);
      if (command === "start") {
        this.ringing.set(modelId, { ruleId: event.ruleId, modelId, severity: event.severity });
        this.sink.startAlarm(modelId);
      } else if (command === "stop") {
        this.ringing.delete(modelId);
        this.sink.stopAlarm(modelId);
      }
    }
  }

  /**
   * 释放:停掉所有在响的声源并清空登记。幂等,dispose 后 handleEvents 无操作。
   * 与引擎侧 disposeSpatialAudioRuntime 的分工:这里管"谁在响"的登记,
   * 引擎侧管节点 stop/disconnect;两侧都必须被调用,缺一即泄漏。
   */
  dispose(): void {
    if (this.disposed) return;
    for (const modelId of [...this.ringing.keys()]) this.sink.stopAlarm(modelId);
    this.ringing.clear();
    this.disposed = true;
  }
}
