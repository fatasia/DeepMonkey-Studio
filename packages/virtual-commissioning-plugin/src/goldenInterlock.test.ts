// R0 黄金样例 golden-08(规格 ps-pd-plant-full-replacement-upgrade-plan-2026-09-25.md)
// PLC 互锁:输入 → runVirtualDebugScenario/Suite 运行 → 证据链指纹固化。
// 业务约束:故障默认锁存,互锁断言(running-implies-motor / fault-implies-alarm)在引擎
// 每帧强制回写 motorRunning/alarm 的前提下恒真;故障注入失败必须由 signal-equals
// 断言检出,这正是"互锁逻辑兜底 + 信号级断言补位"的分层设计。
import { describe, expect, it } from "vitest";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import type { VirtualDebugAssertion, VirtualDebugResult, VirtualDebugScenario } from "@bim-studio/contracts";
import { runVirtualDebugScenario, runVirtualDebugSuite } from "./engine.js";

describe("R0 golden-08 PLC 互锁证据链", () => {
  it("互锁通过样例:启动与急缩故障下运行/告警互锁全部成立", () => {
    const result = runVirtualDebugScenario(interlockPassScenario());

    expect(result.status).toBe("passed");
    expect(result.failures).toEqual([]);
    expect(result.trace[0]).toMatchObject({ state: "running", signals: { motorRunning: true, alarm: false } });
    expect(result.trace[2]).toMatchObject({
      atMs: 100, state: "faulted",
      signals: { motorRunning: false, alarm: true },
      events: ["fault:e-stop"],
    });
  });

  it("故障注入失败样例:信号级互锁检出故障,断言 id 可定位且带绑定目标", () => {
    const result = runVirtualDebugScenario(interlockFaultScenario());

    expect(result.status).toBe("failed");
    expect(result.failures.length).toBeGreaterThan(0);
    // 全部失败都来自信号级互锁断言,内置互锁不误报
    expect(result.failures.map((item) => item.assertionId)).toEqual(
      Array.from({ length: result.failures.length }, () => "part-present-guard"),
    );
    const first = result.failures[0]!;
    expect(first).toMatchObject({
      atMs: 100,
      message: "信号 partPresent 不等于期望值",
      signal: "partPresent",
      bindingId: "part-binding",
      target: { sceneId: "scene-08", objectId: "photo-sensor", objectKind: "primitive" },
    });
    // 断言 id 必须能回溯到场景内的互锁断言定义
    expect(failScenarioAssertions().some((item) => item.id === first.assertionId)).toBe(true);
    // 故障锁存:从注入时刻起每个 tick 持续失败
    expect(result.failures.map((item) => item.atMs)).toEqual([100, 150, 200]);
  });

  it("黄金矩阵:通过样例与预期失败样例双双命中预期", () => {
    const suiteResult = runVirtualDebugSuite({
      id: "golden-08-interlock-suite",
      label: "PLC 互锁黄金矩阵",
      cases: [
        { id: "interlock-pass", label: "互锁通过", expectedStatus: "passed", scenario: interlockPassScenario() },
        { id: "interlock-fail-detected", label: "故障注入被检出", expectedStatus: "failed", scenario: interlockFaultScenario() },
      ],
    });

    expect(suiteResult).toMatchObject({ status: "passed", totalCases: 2, matchedCases: 2 });
    expect(suiteResult.cases.map((item) => item.expectationMatched)).toEqual([true, true]);
  });

  it("同一输入两次运行产生同一证据指纹,通过与失败样例可被指纹区分", () => {
    const passedFirst = runVirtualDebugScenario(interlockPassScenario());
    const passedSecond = runVirtualDebugScenario(interlockPassScenario());
    const faulted = runVirtualDebugScenario(interlockFaultScenario());

    expect(passedFirst.evidenceFingerprint).toBe(passedSecond.evidenceFingerprint);
    expect(evidenceChainOf(passedFirst)).toBe(evidenceChainOf(passedSecond));
    expect(evidenceChainOf(passedFirst)).not.toBe(evidenceChainOf(faulted));
    expect(passedFirst.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

/** 黄金证据链指纹:场景、回放轨迹与失败记录分标签掺入,任一变化都会改变指纹。 */
function evidenceChainOf(result: VirtualDebugResult): string {
  return fingerprint64Labeled([
    ["scenarioId", result.scenarioId],
    ["trace", result.trace],
    ["failures", result.failures],
  ]);
}

function interlockPassScenario(): VirtualDebugScenario {
  return {
    id: "golden-08-interlock-pass",
    durationMs: 200,
    tickMs: 50,
    commands: [{ atMs: 0, type: "start" }],
    faults: [{ atMs: 100, code: "e-stop" }],
    assertions: [
      { id: "running-motor", expression: "running-implies-motor" },
      { id: "fault-alarm", expression: "fault-implies-alarm" },
    ],
  };
}

function failScenarioAssertions(): VirtualDebugAssertion[] {
  return [
    ...interlockPassScenario().assertions!,
    { id: "part-present-guard", expression: "signal-equals", signal: "partPresent", value: true },
  ];
}

function interlockFaultScenario(): VirtualDebugScenario {
  return {
    ...interlockPassScenario(),
    id: "golden-08-interlock-fault",
    initialSignals: { partPresent: true },
    faults: [
      { atMs: 100, code: "e-stop" },
      { atMs: 100, code: "part-missing", signal: "partPresent", value: false },
    ],
    assertions: failScenarioAssertions(),
    bindings: [{
      id: "part-binding", signal: "partPresent", presentation: "value",
      target: { sceneId: "scene-08", objectId: "photo-sensor", objectKind: "primitive" },
    }],
  };
}
