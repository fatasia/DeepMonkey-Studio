/**
 * 统一仿真引擎端口(PS/PD/Plant R0 合同)。
 * 所有求解内核(DES、机器人、控制、物理、实验)共用一条生命周期:
 * validate → prepare → run(progress/cancel) → result → trace。
 * 本合同只定义协议,不实现求解;各引擎通过适配器接入。
 */

/** 冻结的时间协议:仿真时间一律分钟(浮点);墙钟时间一律 ISO 8601 字符串。 */
export const SIMULATION_TIME_UNIT = "minute" as const;

/** 冻结的单位协议:与 plantLiteModel / plantTransportNetwork 既有口径一致,只集中声明。 */
export const SIMULATION_LENGTH_UNIT = "meter" as const;
export const SIMULATION_SPEED_UNIT = "meters-per-minute" as const;
export const SIMULATION_POWER_UNIT = "kilowatt" as const;
export const SIMULATION_ENERGY_UNIT = "kilowatt-hour" as const;
export const SIMULATION_CURRENCY = "CNY" as const;

/**
 * 冻结的场景规范坐标帧(与 vision.ts 的权威声明一致):
 * 右手系、Y 轴向上、长度单位米;场景对象绑定一律归一到该帧,禁止各引擎私有坐标。
 */
export const SCENE_CANONICAL_COORDINATE_FRAME = {
  handedness: "right-handed",
  upAxis: "y",
  lengthUnit: SIMULATION_LENGTH_UNIT,
} as const;

export type SimulationEngineCapability =
  | "discrete-event"
  | "robot-kinematics"
  | "collision"
  | "control-cosim"
  | "physics"
  | "experiment";

export interface SimulationEngineDescriptor {
  /** 稳定引擎标识,如 "plant-lite-des";变更语义必须伴随版本号变更。 */
  engineId: string;
  engineVersion: string;
  capabilities: SimulationEngineCapability[];
  /** false 的引擎禁止进入黄金样例与复现门禁。 */
  deterministic: boolean;
  timeUnit: typeof SIMULATION_TIME_UNIT;
}

export type SimulationIssueSeverity = "error" | "warning" | "info";

export interface SimulationValidationIssue {
  severity: SimulationIssueSeverity;
  /** 问题定位路径,如 "nodes[3].interarrivalTime.mean"。 */
  path?: string;
  message: string;
  /** 给人的可操作修复动作;error 必须尽量给出。 */
  fix?: string;
}

export interface SimulationValidationReport {
  valid: boolean;
  errors: SimulationValidationIssue[];
  warnings: SimulationValidationIssue[];
  notes: SimulationValidationIssue[];
}

export type SimulationLifecyclePhase =
  | "validating"
  | "preparing"
  | "running"
  | "tracing"
  | "completed";

export interface SimulationProgress {
  phase: SimulationLifecyclePhase;
  completedReplications?: number;
  totalReplications?: number;
  processedEvents?: number;
  message?: string;
}

export type SimulationProgressListener = (progress: SimulationProgress) => void;

export type SimulationTermination = "completed" | "cancelled" | "limit-reached";

export interface SimulationRunRequest<TInput> {
  input: TInput;
  /** 字符串或数字种子;确定性引擎同输入同种子必须同指纹。 */
  seed: string | number;
  replications?: number;
  /** 进程内协作取消;Worker 边界另有 AbortSignal。 */
  shouldCancel?: () => boolean;
  onProgress?: SimulationProgressListener;
}

export interface SimulationWallClock {
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/** trace 信封:各引擎保留自有事件格式,以 formatId 显式声明,指纹进证据链。 */
export interface SimulationTraceEnvelope<TTrace> {
  formatId: string;
  trace: TTrace;
  fingerprint: string;
}

export interface SimulationRunRecord<TResult, TTrace = unknown> {
  descriptor: SimulationEngineDescriptor;
  seed: string | number;
  replications: number;
  termination: SimulationTermination;
  /** 终止原因;completed 时省略。 */
  terminationReason?: "cancelled" | "max-events";
  inputFingerprint: string;
  resultFingerprint: string;
  trace?: SimulationTraceEnvelope<TTrace>;
  result: TResult;
  wallClock: SimulationWallClock;
}

export class SimulationPortError extends Error {
  public readonly issues: SimulationValidationIssue[];

  constructor(message: string, issues: SimulationValidationIssue[] = []) {
    super(message);
    this.name = "SimulationPortError";
    this.issues = issues;
  }
}

export interface SimulationEngineRunOptions {
  /** Worker/请求边界的外部取消信号;与 shouldCancel 任一触发即终止。 */
  signal?: AbortSignal;
}

/**
 * 统一端口:调用方只面对 validate 与 run 两个入口;
 * prepare 是引擎内部生命周期阶段(经 onProgress 可观测),不把中间态泄漏给调用方。
 */
export interface SimulationEnginePort<TInput, TResult, TTrace = unknown> {
  descriptor: SimulationEngineDescriptor;
  validate(input: TInput): SimulationValidationReport;
  run(
    request: SimulationRunRequest<TInput>,
    options?: SimulationEngineRunOptions,
  ): Promise<SimulationRunRecord<TResult, TTrace>>;
}

/** error 为空即 valid;由 errors/warnings/notes 三档构成,禁止把警告算进 valid。 */
export function summarizeValidation(issues: SimulationValidationIssue[]): SimulationValidationReport {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const notes = issues.filter((issue) => issue.severity === "info");
  return { valid: errors.length === 0, errors, warnings, notes };
}
