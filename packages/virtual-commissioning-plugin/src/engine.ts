import type { CapabilityProvider } from "@bim-studio/plugin-runtime";
import type {
  VirtualDebugAssertion,
  VirtualDebugCommand,
  VirtualDebugResult,
  VirtualDebugScenario,
  VirtualDebugSuite,
  VirtualDebugSuiteResult,
  VirtualDebugTrace
} from "@bim-studio/contracts";
import {
  virtualDebugInputSchema,
  virtualDebugOutputSchema,
  virtualDebugSuiteInputSchema,
  virtualDebugSuiteOutputSchema,
} from "./virtualDebugSchemas.js";

/**
 * 确定性虚拟调试器：同一场景、同一 tick 和同一命令序列必须得到相同证据指纹。
 * 这里只模拟控制逻辑与 I/O，不模拟渲染；因此可以在 Web Worker 或 Node Worker 中运行。
 */
export function runVirtualDebugScenario(scenario: VirtualDebugScenario): VirtualDebugResult {
  validateScenario(scenario);
  const tickMs = scenario.tickMs ?? 50;
  const commands = [...(scenario.commands ?? [])].sort((a, b) => a.atMs - b.atMs);
  const faults = [...(scenario.faults ?? [])].sort((a, b) => a.atMs - b.atMs);
  const assertions = scenario.assertions ?? [];
  let state: "idle" | "running" | "faulted" = "idle";
  let signals: Record<string, number | boolean | string> = { ...(scenario.initialSignals ?? {}) };
  const trace: VirtualDebugTrace[] = [];
  const failures: VirtualDebugResult["failures"] = [];
  for (let atMs = 0; atMs <= scenario.durationMs; atMs += tickMs) {
    const events: string[] = [];
    for (const command of commands.filter((item) => item.atMs === atMs)) {
      // 故障默认锁存，必须显式 reset，避免调试结果掩盖控制器的真实联锁行为。
      if (state === "faulted" && command.type !== "reset") continue;
      applyCommand(command, (next) => { state = next; }, signals, events);
    }
    for (const fault of faults.filter((item) => item.atMs === atMs)) {
      state = "faulted";
      if (fault.signal) signals[fault.signal] = fault.value ?? true;
      events.push(`fault:${fault.code}`);
    }
    // 回调修改后的状态需要显式展开，避免类型流分析误判为仅 idle/faulted。
    const currentState = state as "idle" | "running" | "faulted";
    signals.motorRunning = currentState === "running";
    signals.alarm = currentState === "faulted";
    const frame = { atMs, state: currentState, signals: { ...signals }, events };
    trace.push(frame);
    for (const assertion of assertions) {
      if (assertion.atMs !== undefined && assertion.atMs !== atMs) continue;
      const failure = checkAssertion(assertion, frame);
      if (failure) failures.push(resolveFailureTarget(assertion, atMs, failure, scenario));
    }
  }
  return { status: failures.length ? "failed" : "passed", scenarioId: scenario.id, tickMs, durationMs: scenario.durationMs, trace, bindings: structuredClone(scenario.bindings ?? []), failures, evidenceFingerprint: fingerprint({ scenario, trace, failures }) };
}

export function createVirtualDebugProvider(): CapabilityProvider<VirtualDebugScenario, VirtualDebugResult> {
  return {
    descriptor: {
      id: "simulation.virtual-debug.run",
      version: "1.0.0",
      label: "虚拟调试回放",
      kind: "simulation",
      execution: "worker",
      permissions: ["simulation.execute"],
      timeoutMs: 30_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: virtualDebugInputSchema,
      outputSchema: virtualDebugOutputSchema
    },
    async invoke(request) {
      const result = runVirtualDebugScenario(request.input);
      return {
        status: result.status === "passed" ? "completed" : "blocked",
        decisionStatus: "production",
        output: result,
        evidence: [{ id: result.evidenceFingerprint, kind: "simulation", label: "确定性虚拟调试轨迹", source: `scenario:${result.scenarioId}`, fingerprint: result.evidenceFingerprint }],
        ...(result.failures.length ? { warnings: result.failures.map((failure) => `${failure.assertionId}: ${failure.message}`) } : [])
      };
    }
  };
}

/** 执行黄金用例矩阵；预期失败被正确检出时，套件仍判为通过。 */
export function runVirtualDebugSuite(suite: VirtualDebugSuite): VirtualDebugSuiteResult {
  validateSuite(suite);
  const cases = suite.cases.map((testCase) => {
    const result = runVirtualDebugScenario(testCase.scenario);
    return {
      id: testCase.id,
      label: testCase.label,
      expectedStatus: testCase.expectedStatus,
      expectationMatched: result.status === testCase.expectedStatus,
      result,
    };
  });
  const matchedCases = cases.filter((item) => item.expectationMatched).length;
  return {
    status: matchedCases === cases.length ? "passed" : "failed",
    suiteId: suite.id,
    label: suite.label,
    totalCases: cases.length,
    matchedCases,
    cases,
    evidenceFingerprint: fingerprint({ suite, cases }),
  };
}

export function createVirtualDebugSuiteProvider(): CapabilityProvider<VirtualDebugSuite, VirtualDebugSuiteResult> {
  return {
    descriptor: {
      id: "simulation.virtual-debug.run-suite",
      version: "1.0.0",
      label: "虚拟调试黄金测试矩阵",
      kind: "simulation",
      execution: "worker",
      permissions: ["simulation.execute"],
      timeoutMs: 30_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: virtualDebugSuiteInputSchema,
      outputSchema: virtualDebugSuiteOutputSchema,
    },
    async invoke(request) {
      const result = runVirtualDebugSuite(request.input);
      const mismatches = result.cases.filter((item) => !item.expectationMatched);
      return {
        status: result.status === "passed" ? "completed" : "blocked",
        decisionStatus: "production",
        output: result,
        evidence: [{
          id: result.evidenceFingerprint,
          kind: "simulation",
          label: "虚拟调试黄金测试矩阵",
          source: `suite:${result.suiteId}`,
          fingerprint: result.evidenceFingerprint,
        }],
        ...(mismatches.length
          ? { warnings: mismatches.map((item) => `${item.id}: 预期 ${item.expectedStatus}，实际 ${item.result.status}`) }
          : {}),
      };
    },
  };
}

function applyCommand(command: VirtualDebugCommand, setState: (state: "idle" | "running" | "faulted") => void, signals: Record<string, number | boolean | string>, events: string[]): void {
  if (command.type === "start") { setState("running"); events.push("command:start"); return; }
  if (command.type === "stop") { setState("idle"); events.push("command:stop"); return; }
  if (command.type === "reset") { setState("idle"); events.push("command:reset"); return; }
  if (command.type === "set" && command.key) { signals[command.key] = command.value ?? ""; events.push(`command:set:${command.key}`); }
}

function checkAssertion(assertion: VirtualDebugAssertion, frame: VirtualDebugTrace): string | undefined {
  if (assertion.expression === "running-implies-motor" && frame.state === "running" && frame.signals.motorRunning !== true) return "运行状态下 motorRunning 必须为 true";
  if (assertion.expression === "fault-implies-alarm" && frame.state === "faulted" && frame.signals.alarm !== true) return "故障状态下 alarm 必须为 true";
  if (assertion.expression === "signal-equals" && assertion.signal && frame.signals[assertion.signal] !== assertion.value) return `信号 ${assertion.signal} 不等于期望值`;
  return undefined;
}

function resolveFailureTarget(assertion: VirtualDebugAssertion, atMs: number, message: string, scenario: VirtualDebugScenario): VirtualDebugResult["failures"][number] {
  const signal = assertionSignal(assertion);
  const binding = signal ? scenario.bindings?.find((item) => item.signal === signal) : undefined;
  return {
    assertionId: assertion.id,
    atMs,
    message,
    ...(signal ? { signal } : {}),
    ...(binding ? { bindingId: binding.id, target: { ...binding.target } } : {})
  };
}

function assertionSignal(assertion: VirtualDebugAssertion): string | undefined {
  if (assertion.expression === "running-implies-motor") return "motorRunning";
  if (assertion.expression === "fault-implies-alarm") return "alarm";
  return assertion.signal;
}

function validateScenario(scenario: VirtualDebugScenario): void {
  if (!scenario.id?.trim()) throw new Error("虚拟调试场景必须包含 id");
  if (!Number.isSafeInteger(scenario.durationMs) || scenario.durationMs <= 0 || scenario.durationMs > 24 * 60 * 60 * 1000) throw new Error("durationMs 必须为 1 至 86400000 的整数");
  if (scenario.tickMs !== undefined && (!Number.isSafeInteger(scenario.tickMs) || scenario.tickMs <= 0 || scenario.tickMs > 10_000)) throw new Error("tickMs 必须为 1 至 10000 的整数");
  if (scenario.tickMs !== undefined && scenario.durationMs % scenario.tickMs !== 0) throw new Error("durationMs 必须是 tickMs 的整数倍，确保轨迹可复现");
  for (const item of [...(scenario.commands ?? []), ...(scenario.faults ?? [])]) if (!Number.isSafeInteger(item.atMs) || item.atMs < 0 || item.atMs > scenario.durationMs) throw new Error("命令或故障时间超出场景范围");
  const bindingIds = new Set<string>();
  for (const binding of scenario.bindings ?? []) {
    if (!binding.id?.trim() || bindingIds.has(binding.id)) throw new Error("信号映射 id 不能为空或重复");
    if (!binding.signal?.trim() || !binding.target.sceneId?.trim() || !binding.target.objectId?.trim()) throw new Error("信号映射缺少信号、场景或对象");
    bindingIds.add(binding.id);
  }
}

function validateSuite(suite: VirtualDebugSuite): void {
  if (!suite.id?.trim() || !suite.label?.trim()) throw new Error("黄金测试矩阵必须包含 id 和名称");
  if (!Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > 50) {
    throw new Error("黄金测试矩阵必须包含 1 至 50 个用例");
  }
  const ids = new Set<string>();
  for (const testCase of suite.cases) {
    if (!testCase.id?.trim() || !testCase.label?.trim() || ids.has(testCase.id)) {
      throw new Error("黄金测试用例 id/名称不能为空，且 id 不能重复");
    }
    ids.add(testCase.id);
  }
}

/** 同步、跨浏览器的稳定指纹；服务端如需审计级 SHA-256 可在边界层再次封装。 */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  const parts = [0xcbf29ce484222325n, 0x84222325cbf29ce4n, 0x9e3779b185ebca87n, 0x517cc1b727220a95n];
  return parts.map((seed) => {
    let hash = seed;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= BigInt(text.charCodeAt(index));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
  }).join("");
}
