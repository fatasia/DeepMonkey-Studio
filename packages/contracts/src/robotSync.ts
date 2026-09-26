/**
 * 多机器人信号互锁调度合同(对位 PS CEE:多机器人同步=信号互锁,操作默认带
 * "结束信号"作迁移条件)。只表达 emulated controller 层的调度语义;
 * OLP 程序导入导出、连续空间避让与外部轴联动不在本合同范围。
 */

export type RobotSyncTimelineEvent =
  | "step-start" /** 运动/延时步开始占用机器人 */
  | "step-complete" /** 步完成,对应 PS"操作结束"迁移条件 */
  | "signal-wait" /** 进入信号等待 */
  | "signal-acquired" /** 等待的迁移条件成立 */
  | "signal-set" /** 置位信号并唤醒全部等待者 */
  | "signal-timeout" /** 等待超时,场景终止 */
  | "deferred-clearance" /** 因 TCP 互斥被整体推迟 */
  | "deadlocked"; /** 死锁结算时仍挂起在该步 */

export interface RobotProgramStep {
  stepId: string;
  /** 冗余归属标注,必须与所在 program 的 robotStableId 一致,仿真显式拒绝漂移。 */
  robotStableId: string;
  /** 轨迹时长表键;与 durationSeconds 至少给一个,否则场景构造非法。 */
  trajectoryRef?: string;
  /** 迁移条件:挂起直到该信号为 true 才继续。 */
  waitSignal?: string;
  /** 本步获批执行时置 true,经中央信号表唤醒全部等待者。 */
  setSignal?: string;
  /** 纯延时秒;显式给出时优先于时长表。 */
  durationSeconds?: number;
  /** 仅对 waitSignal 步生效;超时判定为 signal-timeout 并终止场景。 */
  timeoutSeconds?: number;
}

export interface RobotSyncProgram {
  programId: string;
  robotStableId: string;
  steps: RobotProgramStep[];
}

export interface RobotSyncScenario {
  scenarioId: string;
  programs: RobotSyncProgram[];
  /** 声明即启用 TCP 互斥监督;调度层不掌握 TCP 几何,活动窗口重叠按潜在过近记录。 */
  clearMeters?: number;
  /** 轨迹时长表:键为 trajectoryRef,值为各段时长秒,仿真取累加值。 */
  trajectoryDurations?: Record<string, number[]>;
  /** 初始信号状态;未声明的信号为 false。 */
  signals?: Record<string, boolean>;
}

export interface RobotSyncTimelineEntry {
  atSeconds: number;
  programId: string;
  stepId: string;
  event: RobotSyncTimelineEvent;
}

export interface RobotSyncViolation {
  atSeconds: number;
  kind: "tcp-clearance";
  /** 被推迟的晚启动者。 */
  programId: string;
  /** 先占活动窗口的机器人 program。 */
  programIdOther?: string;
}

export interface RobotSyncResult {
  status: "completed" | "deadlock" | "signal-timeout";
  timeline: RobotSyncTimelineEntry[];
  /** completed 时为最后完成时刻;deadlock/signal-timeout 时为结算时刻。 */
  cycleSeconds: number;
  violations: RobotSyncViolation[];
}
