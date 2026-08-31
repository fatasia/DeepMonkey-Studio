import type {
  SceneSnapshot,
  VirtualDebugAssertion,
  VirtualDebugResult,
  VirtualDebugScenario,
  VirtualDebugSignalBinding,
  VirtualDebugSignalValue,
  VirtualDebugSuite,
  VirtualDebugTrace
} from "@bim-studio/contracts";

export interface VirtualDebugObjectOption {
  id: string;
  name: string;
  kind: "model" | "primitive";
}

export interface VirtualDebugScenarioDraft {
  scenarioId: string;
  durationMs: number;
  tickMs: number;
  faultEnabled: boolean;
  faultAtMs: number;
  resetEnabled: boolean;
  resetAtMs: number;
  speedSetpoint: number;
  acceptanceAtMs: number;
  acceptanceSignal: string;
  acceptanceValue: VirtualDebugSignalValue;
  bindings: VirtualDebugSignalBinding[];
}

export interface VirtualDebugSuiteDraft {
  suiteId: string;
  durationMs: number;
  tickMs: number;
  speedSetpoint: number;
  bindings: VirtualDebugSignalBinding[];
}

/** 只列出已有场景对象，虚拟调试不创建第二份三维模型。 */
export function virtualDebugObjectOptions(scene: SceneSnapshot | undefined): VirtualDebugObjectOption[] {
  if (!scene) return [];
  return [
    ...scene.models.map((model) => ({ id: model.modelId, name: model.name, kind: "model" as const })),
    ...scene.primitives.map((primitive) => ({ id: primitive.modelId, name: primitive.name, kind: "primitive" as const }))
  ];
}

export function buildVirtualDebugScenario(draft: VirtualDebugScenarioDraft): VirtualDebugScenario {
  const durationMs = positiveInteger(draft.durationMs, "仿真时长");
  const tickMs = positiveInteger(draft.tickMs, "采样周期");
  if (durationMs % tickMs !== 0) throw new Error("仿真时长必须是采样周期的整数倍");
  const align = (value: number, label: string) => alignedTime(value, tickMs, durationMs, label);
  const assertions: VirtualDebugAssertion[] = [
    { id: "start-interlock", atMs: 0, expression: "running-implies-motor" },
    ...(draft.faultEnabled ? [{ id: "fault-alarm", atMs: align(draft.faultAtMs, "故障时间"), expression: "fault-implies-alarm" as const }] : []),
    {
      id: "acceptance-signal",
      atMs: align(draft.acceptanceAtMs, "验收检查时间"),
      expression: "signal-equals",
      signal: draft.acceptanceSignal,
      value: draft.acceptanceValue
    }
  ];
  return {
    id: draft.scenarioId.trim() || "virtual-commissioning",
    durationMs,
    tickMs,
    initialSignals: { speedSetpoint: 0 },
    commands: [
      { atMs: 0, type: "start" },
      { atMs: 0, type: "set", key: "speedSetpoint", value: draft.speedSetpoint },
      ...(draft.resetEnabled ? [{ atMs: align(draft.resetAtMs, "复位时间"), type: "reset" as const }] : [])
    ],
    faults: draft.faultEnabled ? [{ atMs: align(draft.faultAtMs, "故障时间"), code: "device-interlock" }] : [],
    assertions,
    bindings: draft.bindings.map((binding) => ({ ...binding, target: { ...binding.target } }))
  };
}

/**
 * 生成固定的控制逻辑黄金矩阵。第四个用例故意包含错误断言，用于证明验收器能检出故障，
 * 因此它的预期结果是 failed，而不是产品故障。
 */
export function buildVirtualDebugGoldenSuite(draft: VirtualDebugSuiteDraft): VirtualDebugSuite {
  const durationMs = positiveInteger(draft.durationMs, "仿真时长");
  const tickMs = positiveInteger(draft.tickMs, "采样周期");
  if (durationMs % tickMs !== 0) throw new Error("仿真时长必须是采样周期的整数倍");
  if (durationMs < tickMs * 4) throw new Error("黄金测试矩阵至少需要 4 个采样周期");
  const faultAtMs = Math.max(tickMs, Math.floor(durationMs * 0.4 / tickMs) * tickMs);
  const resetAtMs = Math.min(durationMs, Math.max(faultAtMs + tickMs, Math.floor(durationMs * 0.7 / tickMs) * tickMs));
  const bindings = draft.bindings.map((binding) => ({ ...binding, target: { ...binding.target } }));
  const scenario = (id: string, input: Pick<VirtualDebugScenario, "commands" | "faults" | "assertions">): VirtualDebugScenario => ({
    id: `${draft.suiteId}-${id}`,
    durationMs,
    tickMs,
    initialSignals: { speedSetpoint: 0 },
    bindings,
    ...input,
  });
  return {
    id: draft.suiteId,
    label: "控制逻辑黄金测试矩阵",
    cases: [
      {
        id: "normal-start",
        label: "正常启动与速度设定",
        expectedStatus: "passed",
        scenario: scenario("normal-start", {
          commands: [
            { atMs: 0, type: "start" },
            { atMs: 0, type: "set", key: "speedSetpoint", value: draft.speedSetpoint },
          ],
          assertions: [{ id: "motor-started", atMs: tickMs, expression: "signal-equals", signal: "motorRunning", value: true }],
        }),
      },
      {
        id: "fault-latch",
        label: "故障锁存与告警",
        expectedStatus: "passed",
        scenario: scenario("fault-latch", {
          commands: [{ atMs: 0, type: "start" }],
          faults: [{ atMs: faultAtMs, code: "device-interlock" }],
          assertions: [{ id: "alarm-latched", atMs: faultAtMs, expression: "signal-equals", signal: "alarm", value: true }],
        }),
      },
      {
        id: "manual-reset",
        label: "人工复位恢复",
        expectedStatus: "passed",
        scenario: scenario("manual-reset", {
          commands: [{ atMs: 0, type: "start" }, { atMs: resetAtMs, type: "reset" }],
          faults: [{ atMs: faultAtMs, code: "device-interlock" }],
          assertions: [{ id: "alarm-cleared", atMs: resetAtMs, expression: "signal-equals", signal: "alarm", value: false }],
        }),
      },
      {
        id: "fault-detection",
        label: "错误逻辑必须被检出",
        expectedStatus: "failed",
        scenario: scenario("fault-detection", {
          commands: [{ atMs: 0, type: "start" }],
          faults: [{ atMs: faultAtMs, code: "device-interlock" }],
          assertions: [{ id: "unsafe-alarm-rule", atMs: faultAtMs, expression: "signal-equals", signal: "alarm", value: false }],
        }),
      },
    ],
  };
}

export function virtualDebugFrameAt(result: VirtualDebugResult | undefined, atMs: number): VirtualDebugTrace | undefined {
  if (!result?.trace.length) return undefined;
  return result.trace.reduce((nearest, frame) => frame.atMs <= atMs ? frame : nearest, result.trace[0]);
}

export function parseSignalValue(value: string): VirtualDebugSignalValue {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正整数`);
  return value;
}

function alignedTime(value: number, tickMs: number, durationMs: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > durationMs) throw new Error(`${label}必须位于仿真时长内`);
  if (value % tickMs !== 0) throw new Error(`${label}必须与 ${tickMs}ms 采样周期对齐`);
  return value;
}
