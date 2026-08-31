import type {
  VirtualDebugAssertion,
  VirtualDebugCommand,
  VirtualDebugFault,
  VirtualDebugScenario,
  VirtualDebugSignalBinding,
  VirtualDebugSignalValue,
} from "@bim-studio/contracts";
import { buildVirtualDebugGoldenSuite } from "./virtualCommissioningModel";

export type VirtualTestCategory = "normal" | "boundary" | "fault" | "recovery";

export interface VirtualTestIoPoint {
  id: string;
  name: string;
  direction: "input" | "output" | "bidirectional";
  dataType: "boolean" | "number" | "string";
  normalValue?: VirtualDebugSignalValue;
  safeValue?: VirtualDebugSignalValue;
  minimum?: number;
  maximum?: number;
}

export interface VirtualTestState {
  id: string;
  name: string;
  initial?: boolean;
  safe?: boolean;
  expectedSignals: Readonly<Record<string, VirtualDebugSignalValue>>;
}

export interface VirtualTestTransition {
  id: string;
  name: string;
  fromStateId: string;
  toStateId: string;
  command: Omit<VirtualDebugCommand, "atMs">;
}

export interface VirtualTestInterlock {
  id: string;
  name: string;
  faultCode: string;
  alarmSignal: string;
  affectedTransitionIds: readonly string[];
  safeSignals?: Readonly<Record<string, VirtualDebugSignalValue>>;
}

export type VirtualTestSafetyConstraint =
  | { id: string; name: string; kind: "signal-equals"; signal: string; expected: VirtualDebugSignalValue; severity: "warning" | "critical" }
  | { id: string; name: string; kind: "signal-range"; signal: string; minimum?: number; maximum?: number; severity: "warning" | "critical" }
  | { id: string; name: string; kind: "state-equals"; expectedStateId: string; severity: "warning" | "critical" };

export interface VirtualCommissioningTestDesignInput {
  suiteId: string;
  durationMs: number;
  tickMs: number;
  ioPoints: readonly VirtualTestIoPoint[];
  states: readonly VirtualTestState[];
  transitions: readonly VirtualTestTransition[];
  interlocks: readonly VirtualTestInterlock[];
  safetyConstraints: readonly VirtualTestSafetyConstraint[];
  bindings?: readonly VirtualDebugSignalBinding[];
}

export interface VirtualTestDraftAssertion {
  id: string;
  kind: "signal-equals" | "signal-range" | "state-equals" | "transition-blocked" | "transition-available";
  signal?: string;
  expected?: VirtualDebugSignalValue;
  minimum?: number;
  maximum?: number;
  expectedStateId?: string;
  transitionId?: string;
  severity: "acceptance" | "warning" | "critical";
  runtimeAssertion?: VirtualDebugAssertion;
  editable: true;
}

export interface VirtualTestDraftStep {
  id: string;
  atMs: number;
  kind: "command" | "fault" | "observe";
  description: string;
  command?: VirtualDebugCommand;
  fault?: VirtualDebugFault;
  editable: true;
}

export interface VirtualCommissioningTestDraft {
  id: string;
  label: string;
  category: VirtualTestCategory;
  readiness: "ready-for-review" | "incomplete";
  requiresHumanConfirmation: true;
  executionPolicy: "draft-only";
  preconditions: {
    stateId?: string;
    signals: Record<string, VirtualDebugSignalValue>;
    descriptions: string[];
  };
  steps: VirtualTestDraftStep[];
  assertions: VirtualTestDraftAssertion[];
  coverageItems: Array<{ kind: "io" | "state" | "transition" | "interlock" | "safety"; id: string }>;
  expectedStatus: "passed" | "failed";
  scenario?: VirtualDebugScenario;
}

export interface VirtualTestDesignMissingInformation {
  code: "missing-initial-state" | "missing-transition" | "missing-interlock" | "missing-boundary"
    | "missing-binding" | "unknown-reference" | "unsupported-runtime-assertion" | "missing-expected-signal";
  subjectId?: string;
  message: string;
  blocking: boolean;
}

export interface VirtualCommissioningTestDesignResult {
  generatedBy: "deterministic-virtual-test-designer-v1";
  aiPolicy: "explain-or-suggest-only";
  requiresHumanConfirmation: true;
  directExecutionAllowed: false;
  drafts: VirtualCommissioningTestDraft[];
  coverage: Array<{
    kind: "io" | "state" | "transition" | "interlock" | "safety";
    id: string;
    status: "covered" | "partial" | "missing";
    draftIds: string[];
  }>;
  missingInformation: VirtualTestDesignMissingInformation[];
  evidenceFingerprint: string;
}

/**
 * 只生成待编辑、待确认的测试设计，不调用 API 或运行仿真。基础时间点和故障/复位语义
 * 复用现有黄金矩阵，避免设计助手与正式虚拟调试器形成两套行为。
 */
export function designVirtualCommissioningTests(
  input: VirtualCommissioningTestDesignInput,
): VirtualCommissioningTestDesignResult {
  validateInput(input);
  const sorted = normalizeInput(input);
  const base = buildVirtualDebugGoldenSuite({
    suiteId: `${input.suiteId}-design-base`,
    durationMs: input.durationMs,
    tickMs: input.tickMs,
    speedSetpoint: normalNumber(sorted.ioPoints, "speedSetpoint") ?? 0,
    bindings: cloneBindings(sorted.bindings),
  });
  const initialState = sorted.states.find((state) => state.initial);
  const initialSignals = initialSignalValues(sorted.ioPoints, initialState);
  const missing = collectReferenceGaps(sorted, initialState);
  const drafts: VirtualCommissioningTestDraft[] = [];

  if (sorted.transitions.length > 0) {
    for (const transition of sorted.transitions) drafts.push(transitionDraft(input, transition, sorted.states, initialSignals));
  } else {
    missing.push({ code: "missing-transition", message: "未提供状态转换，正常用例只能保留黄金启动模板。", blocking: true });
    drafts.push(templateDraft("normal", base.cases[0]!.scenario, "正常流程待补充", initialState, initialSignals, "incomplete"));
  }

  const boundaryDrafts = sorted.ioPoints.filter(isBoundedNumericInput).map((point) => boundaryDraft(input, point, initialState, initialSignals));
  if (boundaryDrafts.length > 0) drafts.push(...boundaryDrafts);
  else {
    missing.push({ code: "missing-boundary", message: "没有带上下限的数值输入点，无法形成边界用例。", blocking: true });
    drafts.push(templateDraft("boundary", undefined, "边界条件待补充", initialState, initialSignals, "incomplete"));
  }

  if (sorted.interlocks.length > 0) {
    for (const interlock of sorted.interlocks) {
      drafts.push(interlockDraft("fault", input, interlock, base.cases[1]!.scenario, initialState, initialSignals));
      drafts.push(interlockDraft("recovery", input, interlock, base.cases[2]!.scenario, initialState, initialSignals));
    }
  } else {
    missing.push({ code: "missing-interlock", message: "未提供互锁定义，故障与恢复用例只能保留黄金模板。", blocking: true });
    drafts.push(templateDraft("fault", base.cases[1]!.scenario, "故障互锁待补充", initialState, initialSignals, "incomplete"));
    drafts.push(templateDraft("recovery", base.cases[2]!.scenario, "故障恢复待补充", initialState, initialSignals, "incomplete"));
  }

  applySafetyConstraints(drafts, sorted.safetyConstraints, missing, input.tickMs);
  const orderedDrafts = drafts.sort(compareDrafts);
  const coverage = buildCoverage(sorted, orderedDrafts);
  const normalizedMissing = deduplicateMissing(missing);
  const payload = { input: sorted, drafts: orderedDrafts, coverage, missingInformation: normalizedMissing };
  return {
    generatedBy: "deterministic-virtual-test-designer-v1",
    aiPolicy: "explain-or-suggest-only",
    requiresHumanConfirmation: true,
    directExecutionAllowed: false,
    drafts: orderedDrafts,
    coverage,
    missingInformation: normalizedMissing,
    evidenceFingerprint: fingerprint(payload),
  };
}

function transitionDraft(
  input: VirtualCommissioningTestDesignInput,
  transition: VirtualTestTransition,
  states: readonly VirtualTestState[],
  initialSignals: Record<string, VirtualDebugSignalValue>,
): VirtualCommissioningTestDraft {
  const fromState = states.find((state) => state.id === transition.fromStateId);
  const toState = states.find((state) => state.id === transition.toStateId);
  const command = { ...transition.command, atMs: input.tickMs };
  const assertions = Object.entries(toState?.expectedSignals ?? {}).map(([signal, expected], index) => equalityAssertion(
    `${transition.id}-expected-${index + 1}`, signal, expected, input.tickMs * 2,
  ));
  const scenario = scenarioOf(input, `${input.suiteId}-${transition.id}`, fromState?.expectedSignals ?? initialSignals, [command], [], assertions);
  return {
    id: `normal-${transition.id}`,
    label: `正常转换：${transition.name}`,
    category: "normal",
    readiness: fromState && toState && assertions.length > 0 ? "ready-for-review" : "incomplete",
    requiresHumanConfirmation: true,
    executionPolicy: "draft-only",
    preconditions: { ...(fromState ? { stateId: fromState.id } : {}), signals: { ...(fromState?.expectedSignals ?? initialSignals) }, descriptions: [`从 ${transition.fromStateId} 进入 ${transition.toStateId}`] },
    steps: [{ id: `${transition.id}-command`, atMs: input.tickMs, kind: "command", description: `执行 ${transition.command.type}`, command, editable: true }],
    assertions,
    coverageItems: [{ kind: "transition", id: transition.id }, { kind: "state", id: transition.fromStateId }, { kind: "state", id: transition.toStateId }],
    expectedStatus: "passed",
    scenario,
  };
}

function boundaryDraft(
  input: VirtualCommissioningTestDesignInput,
  point: VirtualTestIoPoint,
  initialState: VirtualTestState | undefined,
  initialSignals: Record<string, VirtualDebugSignalValue>,
): VirtualCommissioningTestDraft {
  const values = [...new Set([point.minimum, point.maximum].filter((value): value is number => value !== undefined))];
  const commands = values.map((value, index) => ({ atMs: input.tickMs * (index + 1), type: "set" as const, key: point.id, value }));
  const assertions = values.map((value, index) => equalityAssertion(`boundary-${point.id}-${index + 1}`, point.id, value, input.tickMs * (index + 1)));
  return {
    id: `boundary-${point.id}`,
    label: `边界输入：${point.name}`,
    category: "boundary",
    readiness: "ready-for-review",
    requiresHumanConfirmation: true,
    executionPolicy: "draft-only",
    preconditions: { ...(initialState ? { stateId: initialState.id } : {}), signals: { ...initialSignals }, descriptions: ["边界值来自 I/O 点显式上下限"] },
    steps: commands.map((command, index) => ({ id: `boundary-${point.id}-step-${index + 1}`, atMs: command.atMs, kind: "command", description: `设置 ${point.id}=${String(command.value)}`, command, editable: true })),
    assertions,
    coverageItems: [{ kind: "io", id: point.id }],
    expectedStatus: "passed",
    scenario: scenarioOf(input, `${input.suiteId}-boundary-${point.id}`, initialSignals, commands, [], assertions),
  };
}

function interlockDraft(
  category: "fault" | "recovery",
  input: VirtualCommissioningTestDesignInput,
  interlock: VirtualTestInterlock,
  template: VirtualDebugScenario,
  initialState: VirtualTestState | undefined,
  initialSignals: Record<string, VirtualDebugSignalValue>,
): VirtualCommissioningTestDraft {
  const faultAtMs = template.faults?.[0]?.atMs ?? input.tickMs;
  const resetAtMs = template.commands?.find((command) => command.type === "reset")?.atMs ?? Math.min(input.durationMs, faultAtMs + input.tickMs);
  const observationAtMs = category === "fault" ? faultAtMs : resetAtMs;
  const fault = { atMs: faultAtMs, code: interlock.faultCode };
  const commands = (template.commands ?? []).map((command) => ({ ...command }));
  const expected = category === "fault" ? true : false;
  const assertions = [equalityAssertion(`${category}-${interlock.id}-alarm`, interlock.alarmSignal, expected, observationAtMs)];
  if (category === "fault") for (const [signal, value] of Object.entries(interlock.safeSignals ?? {})) {
    assertions.push(equalityAssertion(`fault-${interlock.id}-safe-${signal}`, signal, value, observationAtMs));
  }
  const steps: VirtualTestDraftStep[] = [
    { id: `${category}-${interlock.id}-fault`, atMs: faultAtMs, kind: "fault", description: `注入 ${interlock.faultCode}`, fault, editable: true },
    ...commands.map((command, index) => ({
      id: `${category}-${interlock.id}-command-${index + 1}`,
      atMs: command.atMs,
      kind: "command" as const,
      description: command.type === "reset" ? "执行人工复位" : `执行 ${command.type}`,
      command,
      editable: true as const,
    })),
    { id: `${category}-${interlock.id}-observe`, atMs: observationAtMs, kind: "observe", description: "检查互锁、告警与安全输出", editable: true },
  ];
  return {
    id: `${category}-${interlock.id}`,
    label: `${category === "fault" ? "故障互锁" : "恢复复位"}：${interlock.name}`,
    category,
    readiness: interlock.affectedTransitionIds.length > 0 ? "ready-for-review" : "incomplete",
    requiresHumanConfirmation: true,
    executionPolicy: "draft-only",
    preconditions: { ...(initialState ? { stateId: initialState.id } : {}), signals: { ...initialSignals }, descriptions: ["互锁触发前系统处于已知初始状态"] },
    steps,
    assertions: [
      ...assertions,
      ...interlock.affectedTransitionIds.map((transitionId) => ({
        id: `${category}-${interlock.id}-${category === "fault" ? "blocks" : "allows"}-${transitionId}`,
        kind: category === "fault" ? "transition-blocked" as const : "transition-available" as const,
        transitionId, severity: "critical" as const, editable: true as const,
      })),
    ],
    coverageItems: [{ kind: "interlock", id: interlock.id }, ...interlock.affectedTransitionIds.map((id) => ({ kind: "transition" as const, id }))],
    expectedStatus: "passed",
    scenario: scenarioOf(input, `${input.suiteId}-${category}-${interlock.id}`, initialSignals, commands, [fault], assertions),
  };
}

function applySafetyConstraints(
  drafts: VirtualCommissioningTestDraft[],
  constraints: readonly VirtualTestSafetyConstraint[],
  missing: VirtualTestDesignMissingInformation[],
  tickMs: number,
): void {
  for (const constraint of constraints) for (const draft of drafts) {
    const atMs = Math.min(draft.scenario?.durationMs ?? tickMs, Math.max(tickMs, draft.steps.at(-1)?.atMs ?? tickMs));
    let assertion: VirtualTestDraftAssertion;
    if (constraint.kind === "signal-equals") {
      assertion = equalityAssertion(`safety-${constraint.id}`, constraint.signal, constraint.expected, atMs, constraint.severity);
      if (draft.scenario) draft.scenario.assertions = [...(draft.scenario.assertions ?? []), assertion.runtimeAssertion!];
    } else if (constraint.kind === "signal-range") {
      assertion = { id: `safety-${constraint.id}`, kind: "signal-range", signal: constraint.signal, ...(constraint.minimum !== undefined ? { minimum: constraint.minimum } : {}), ...(constraint.maximum !== undefined ? { maximum: constraint.maximum } : {}), severity: constraint.severity, editable: true };
      missing.push({ code: "unsupported-runtime-assertion", subjectId: constraint.id, message: "现有确定性运行时尚不支持范围断言；草稿可编辑，但确认执行前必须转换或扩展运行时。", blocking: true });
    } else {
      assertion = { id: `safety-${constraint.id}`, kind: "state-equals", expectedStateId: constraint.expectedStateId, severity: constraint.severity, editable: true };
      missing.push({ code: "unsupported-runtime-assertion", subjectId: constraint.id, message: "现有确定性运行时尚不支持显式状态断言；草稿可编辑，但确认执行前必须转换或扩展运行时。", blocking: true });
    }
    draft.assertions.push(assertion);
    draft.coverageItems.push({ kind: "safety", id: constraint.id });
  }
}

function collectReferenceGaps(
  input: ReturnType<typeof normalizeInput>,
  initialState: VirtualTestState | undefined,
): VirtualTestDesignMissingInformation[] {
  const missing: VirtualTestDesignMissingInformation[] = [];
  const ioIds = new Set(input.ioPoints.map((point) => point.id));
  const stateIds = new Set(input.states.map((state) => state.id));
  const transitionIds = new Set(input.transitions.map((transition) => transition.id));
  if (!initialState || input.states.filter((state) => state.initial).length !== 1) missing.push({ code: "missing-initial-state", message: "必须且只能声明一个初始状态，前置条件需要人工确认。", blocking: true });
  const bindingSignals = new Set(input.bindings.map((binding) => binding.signal));
  for (const point of input.ioPoints.filter((point) => point.direction !== "input" && !bindingSignals.has(point.id))) missing.push({ code: "missing-binding", subjectId: point.id, message: "输出点尚未映射到场景对象，逻辑测试可设计但三维反馈不可验收。", blocking: false });
  for (const state of input.states) for (const signal of Object.keys(state.expectedSignals)) if (!ioIds.has(signal)) missing.push({ code: "unknown-reference", subjectId: state.id, message: `状态引用未知 I/O 点 ${signal}`, blocking: true });
  for (const transition of input.transitions) {
    for (const stateId of [transition.fromStateId, transition.toStateId]) if (!stateIds.has(stateId)) missing.push({ code: "unknown-reference", subjectId: transition.id, message: `转换引用未知状态 ${stateId}`, blocking: true });
    const target = input.states.find((state) => state.id === transition.toStateId);
    if (target && Object.keys(target.expectedSignals).length === 0) missing.push({ code: "missing-expected-signal", subjectId: transition.id, message: "目标状态没有期望信号，正常用例缺少可执行断言。", blocking: true });
    if (transition.command.type === "set" && transition.command.key && !ioIds.has(transition.command.key)) missing.push({ code: "unknown-reference", subjectId: transition.id, message: `转换设置未知 I/O 点 ${transition.command.key}`, blocking: true });
  }
  for (const interlock of input.interlocks) {
    if (!ioIds.has(interlock.alarmSignal)) missing.push({ code: "unknown-reference", subjectId: interlock.id, message: `互锁引用未知告警点 ${interlock.alarmSignal}`, blocking: true });
    for (const signal of Object.keys(interlock.safeSignals ?? {})) if (!ioIds.has(signal)) missing.push({ code: "unknown-reference", subjectId: interlock.id, message: `互锁引用未知安全输出 ${signal}`, blocking: true });
    for (const transitionId of interlock.affectedTransitionIds) if (!transitionIds.has(transitionId)) missing.push({ code: "unknown-reference", subjectId: interlock.id, message: `互锁引用未知转换 ${transitionId}`, blocking: true });
    if (interlock.affectedTransitionIds.length > 0) missing.push({ code: "unsupported-runtime-assertion", subjectId: interlock.id, message: "现有运行时不能直接断言转换被阻止或恢复可用；确认执行前需转换为可观测 I/O 断言。", blocking: true });
  }
  for (const constraint of input.safetyConstraints) {
    if (constraint.kind !== "state-equals" && !ioIds.has(constraint.signal)) missing.push({ code: "unknown-reference", subjectId: constraint.id, message: `安全约束引用未知 I/O 点 ${constraint.signal}`, blocking: true });
    if (constraint.kind === "state-equals" && !stateIds.has(constraint.expectedStateId)) missing.push({ code: "unknown-reference", subjectId: constraint.id, message: `安全约束引用未知状态 ${constraint.expectedStateId}`, blocking: true });
  }
  return missing;
}

function buildCoverage(
  input: ReturnType<typeof normalizeInput>,
  drafts: readonly VirtualCommissioningTestDraft[],
): VirtualCommissioningTestDesignResult["coverage"] {
  const items = [
    ...input.ioPoints.map((item) => ({ kind: "io" as const, id: item.id })),
    ...input.states.map((item) => ({ kind: "state" as const, id: item.id })),
    ...input.transitions.map((item) => ({ kind: "transition" as const, id: item.id })),
    ...input.interlocks.map((item) => ({ kind: "interlock" as const, id: item.id })),
    ...input.safetyConstraints.map((item) => ({ kind: "safety" as const, id: item.id })),
  ];
  return items.map((item) => {
    const direct = drafts.filter((draft) => draft.coverageItems.some((candidate) => candidate.kind === item.kind && candidate.id === item.id)).map((draft) => draft.id);
    const signalUse = item.kind === "io" ? drafts.filter((draft) => JSON.stringify({ preconditions: draft.preconditions, steps: draft.steps, assertions: draft.assertions }).includes(`\"${item.id}\"`)).map((draft) => draft.id) : [];
    const draftIds = [...new Set([...direct, ...signalUse])].sort();
    const ready = draftIds.some((id) => drafts.find((draft) => draft.id === id)?.readiness === "ready-for-review");
    return { ...item, status: draftIds.length === 0 ? "missing" as const : ready ? "covered" as const : "partial" as const, draftIds };
  });
}

function templateDraft(
  category: VirtualTestCategory,
  scenario: VirtualDebugScenario | undefined,
  label: string,
  initialState: VirtualTestState | undefined,
  initialSignals: Record<string, VirtualDebugSignalValue>,
  readiness: "ready-for-review" | "incomplete",
): VirtualCommissioningTestDraft {
  return {
    id: `${category}-placeholder`, label, category, readiness, requiresHumanConfirmation: true, executionPolicy: "draft-only",
    preconditions: { ...(initialState ? { stateId: initialState.id } : {}), signals: { ...initialSignals }, descriptions: ["基于现有黄金测试模板，需补齐工程语义"] },
    steps: [], assertions: [], coverageItems: [], expectedStatus: "passed", ...(scenario ? { scenario: structuredClone(scenario) } : {}),
  };
}

function equalityAssertion(
  id: string,
  signal: string,
  expected: VirtualDebugSignalValue,
  atMs: number,
  severity: "acceptance" | "warning" | "critical" = "acceptance",
): VirtualTestDraftAssertion {
  return { id, kind: "signal-equals", signal, expected, severity, editable: true, runtimeAssertion: { id, atMs, expression: "signal-equals", signal, value: expected } };
}

function scenarioOf(
  input: VirtualCommissioningTestDesignInput,
  id: string,
  initialSignals: Readonly<Record<string, VirtualDebugSignalValue>>,
  commands: VirtualDebugCommand[],
  faults: VirtualDebugFault[],
  assertions: VirtualTestDraftAssertion[],
): VirtualDebugScenario {
  return { id, durationMs: input.durationMs, tickMs: input.tickMs, initialSignals: { ...initialSignals }, commands, faults, assertions: assertions.flatMap((item) => item.runtimeAssertion ? [item.runtimeAssertion] : []), bindings: cloneBindings(input.bindings ?? []).sort(byId) };
}

function initialSignalValues(points: readonly VirtualTestIoPoint[], state: VirtualTestState | undefined): Record<string, VirtualDebugSignalValue> {
  return { ...Object.fromEntries(points.flatMap((point) => point.normalValue === undefined ? [] : [[point.id, point.normalValue]])), ...(state?.expectedSignals ?? {}) };
}

function validateInput(input: VirtualCommissioningTestDesignInput): void {
  if (!input.suiteId.trim()) throw new Error("测试设计必须包含 suiteId");
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0 || !Number.isSafeInteger(input.tickMs) || input.tickMs <= 0 || input.durationMs % input.tickMs !== 0 || input.durationMs < input.tickMs * 4) throw new Error("测试时长必须至少包含 4 个完整采样周期");
  assertUnique(input.ioPoints.map((item) => item.id), "I/O 点 ID");
  assertUnique(input.states.map((item) => item.id), "状态 ID");
  assertUnique(input.transitions.map((item) => item.id), "转换 ID");
  assertUnique(input.interlocks.map((item) => item.id), "互锁 ID");
  assertUnique(input.safetyConstraints.map((item) => item.id), "安全约束 ID");
  for (const point of input.ioPoints) {
    if (!point.name.trim()) throw new Error(`I/O 点 ${point.id} 缺少名称`);
    if (point.minimum !== undefined && point.maximum !== undefined && point.minimum > point.maximum) throw new Error(`I/O 点 ${point.id} 上下限倒置`);
  }
  for (const constraint of input.safetyConstraints) if (constraint.kind === "signal-range" && constraint.minimum === undefined && constraint.maximum === undefined) throw new Error(`范围约束 ${constraint.id} 必须包含上下限`);
}

function normalizeInput(input: VirtualCommissioningTestDesignInput) {
  return {
    suiteId: input.suiteId,
    durationMs: input.durationMs,
    tickMs: input.tickMs,
    ioPoints: [...input.ioPoints].sort(byId),
    states: [...input.states].sort(byId),
    transitions: [...input.transitions].sort(byId),
    interlocks: [...input.interlocks].sort(byId),
    safetyConstraints: [...input.safetyConstraints].sort(byId),
    bindings: cloneBindings(input.bindings ?? []).sort(byId),
  };
}

function deduplicateMissing(items: VirtualTestDesignMissingInformation[]): VirtualTestDesignMissingInformation[] {
  return [...new Map(items.map((item) => [`${item.code}/${item.subjectId ?? ""}/${item.message}`, item])).values()]
    .sort((left, right) => left.code.localeCompare(right.code) || (left.subjectId ?? "").localeCompare(right.subjectId ?? "") || left.message.localeCompare(right.message));
}

function isBoundedNumericInput(point: VirtualTestIoPoint): boolean {
  return point.dataType === "number" && point.direction !== "output" && (point.minimum !== undefined || point.maximum !== undefined);
}

function normalNumber(points: readonly VirtualTestIoPoint[], id: string): number | undefined {
  const value = points.find((point) => point.id === id)?.normalValue;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cloneBindings(bindings: readonly VirtualDebugSignalBinding[]): VirtualDebugSignalBinding[] {
  return bindings.map((binding) => ({ ...binding, target: { ...binding.target } }));
}

function assertUnique(values: readonly string[], label: string): void {
  if (values.some((value) => !value.trim()) || new Set(values).size !== values.length) throw new Error(`${label} 必须非空且唯一`);
}

function compareDrafts(left: VirtualCommissioningTestDraft, right: VirtualCommissioningTestDraft): number {
  const order: Record<VirtualTestCategory, number> = { normal: 0, boundary: 1, fault: 2, recovery: 3 };
  return order[left.category] - order[right.category] || left.id.localeCompare(right.id);
}

function byId<T extends { id: string }>(left: T, right: T): number { return left.id.localeCompare(right.id); }

function fingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64-canonical-v1:${hash.toString(16).padStart(16, "0")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
