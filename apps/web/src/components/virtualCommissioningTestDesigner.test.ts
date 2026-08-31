import { describe, expect, it } from "vitest";
import {
  designVirtualCommissioningTests,
  type VirtualCommissioningTestDesignInput,
} from "./virtualCommissioningTestDesigner";

describe("virtual commissioning test designer", () => {
  it("generates editable drafts for normal, boundary, fault and recovery paths", () => {
    const result = designVirtualCommissioningTests(baseInput());

    expect(result.drafts.map((draft) => draft.category)).toEqual(["normal", "boundary", "fault", "recovery"]);
    expect(result).toMatchObject({
      generatedBy: "deterministic-virtual-test-designer-v1",
      aiPolicy: "explain-or-suggest-only",
      requiresHumanConfirmation: true,
      directExecutionAllowed: false,
    });
    expect(result.drafts.every((draft) => draft.requiresHumanConfirmation && draft.executionPolicy === "draft-only")).toBe(true);
    expect(result.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f\d]{16}$/);
  });

  it("reuses the runtime scenario model for transition preconditions and assertions", () => {
    const result = designVirtualCommissioningTests(baseInput());
    const normal = result.drafts.find((draft) => draft.category === "normal")!;

    expect(normal).toMatchObject({
      id: "normal-start-line",
      readiness: "ready-for-review",
      preconditions: { stateId: "idle", signals: { motorRunning: false, alarm: false } },
      expectedStatus: "passed",
    });
    expect(normal.steps[0]).toMatchObject({ kind: "command", atMs: 50, command: { type: "start", atMs: 50 } });
    expect(normal.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: "motorRunning", expected: true, runtimeAssertion: expect.objectContaining({ expression: "signal-equals", atMs: 100 }) }),
    ]));
    expect(normal.scenario).toMatchObject({ durationMs: 1_000, tickMs: 50, commands: [{ type: "start", atMs: 50 }] });
  });

  it("uses declared numeric limits for a deterministic boundary draft", () => {
    const result = designVirtualCommissioningTests(baseInput());
    const boundary = result.drafts.find((draft) => draft.category === "boundary")!;

    expect(boundary.id).toBe("boundary-speedSetpoint");
    expect(boundary.steps.map((step) => step.command)).toEqual([
      { atMs: 50, type: "set", key: "speedSetpoint", value: 0 },
      { atMs: 100, type: "set", key: "speedSetpoint", value: 1_500 },
    ]);
    expect(boundary.assertions.map((assertion) => assertion.expected)).toEqual([0, 1_500]);
    expect(result.coverage.find((item) => item.kind === "io" && item.id === "speedSetpoint")).toMatchObject({ status: "covered" });
  });

  it("derives fault and recovery timing from the existing golden suite", () => {
    const result = designVirtualCommissioningTests(baseInput());
    const fault = result.drafts.find((draft) => draft.category === "fault")!;
    const recovery = result.drafts.find((draft) => draft.category === "recovery")!;

    expect(fault.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "fault", atMs: 400, fault: { code: "guard-open", atMs: 400 } }),
      expect.objectContaining({ kind: "command", command: { type: "start", atMs: 0 } }),
    ]));
    expect(fault.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "signal-equals", signal: "alarm", expected: true }),
      expect.objectContaining({ kind: "signal-equals", signal: "motorRunning", expected: false }),
      expect.objectContaining({ kind: "transition-blocked", transitionId: "start-line" }),
    ]));
    expect(recovery.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "command", atMs: 700, command: expect.objectContaining({ type: "reset" }) }),
    ]));
    expect(recovery.assertions).toContainEqual(expect.objectContaining({ kind: "transition-available", transitionId: "start-line" }));
    expect(result.missingInformation).toContainEqual(expect.objectContaining({
      code: "unsupported-runtime-assertion",
      subjectId: "guard-door",
      blocking: true,
    }));
  });

  it("keeps unsupported safety assertions editable and blocks direct execution", () => {
    const input = baseInput();
    input.safetyConstraints = [{
      id: "speed-safe",
      name: "速度安全范围",
      kind: "signal-range",
      signal: "speedSetpoint",
      minimum: 0,
      maximum: 1_500,
      severity: "critical",
    }];
    const result = designVirtualCommissioningTests(input);

    expect(result.drafts.every((draft) => draft.assertions.some((assertion) => assertion.kind === "signal-range"))).toBe(true);
    expect(result.missingInformation).toContainEqual(expect.objectContaining({
      code: "unsupported-runtime-assertion",
      subjectId: "speed-safe",
      blocking: true,
    }));
    expect(result.directExecutionAllowed).toBe(false);
  });

  it("returns incomplete placeholders and actionable gaps for missing engineering data", () => {
    const input = baseInput();
    input.ioPoints = [];
    input.states = [];
    input.transitions = [];
    input.interlocks = [];
    input.bindings = [];
    const result = designVirtualCommissioningTests(input);

    expect(result.drafts.map((draft) => draft.category)).toEqual(["normal", "boundary", "fault", "recovery"]);
    expect(result.drafts.every((draft) => draft.readiness === "incomplete")).toBe(true);
    expect(result.missingInformation.map((item) => item.code)).toEqual(expect.arrayContaining([
      "missing-initial-state", "missing-transition", "missing-boundary", "missing-interlock",
    ]));
  });

  it("produces the same evidence for the same engineering model regardless of list ordering", () => {
    const firstInput = baseInput();
    const secondInput = baseInput();
    secondInput.ioPoints = [...secondInput.ioPoints].reverse();
    secondInput.states = [...secondInput.states].reverse();
    secondInput.bindings = [...(secondInput.bindings ?? [])].reverse();
    const first = designVirtualCommissioningTests(firstInput);
    const second = designVirtualCommissioningTests(secondInput);
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);
    expect(first.drafts).toEqual(second.drafts);
  });

  it("rejects duplicate engineering identifiers", () => {
    const input = baseInput();
    input.states = [...input.states, { id: "idle", name: "重复", expectedSignals: {} }];
    expect(() => designVirtualCommissioningTests(input)).toThrow("状态 ID 必须非空且唯一");
  });
});

function baseInput(): VirtualCommissioningTestDesignInput {
  return {
    suiteId: "line-a",
    durationMs: 1_000,
    tickMs: 50,
    ioPoints: [
      { id: "motorRunning", name: "电机运行", direction: "output", dataType: "boolean", normalValue: false, safeValue: false },
      { id: "alarm", name: "告警", direction: "output", dataType: "boolean", normalValue: false, safeValue: true },
      { id: "speedSetpoint", name: "速度给定", direction: "input", dataType: "number", normalValue: 1_000, minimum: 0, maximum: 1_500 },
    ],
    states: [
      { id: "idle", name: "待机", initial: true, expectedSignals: { motorRunning: false, alarm: false } },
      { id: "running", name: "运行", expectedSignals: { motorRunning: true, alarm: false } },
      { id: "faulted", name: "故障", safe: true, expectedSignals: { motorRunning: false, alarm: true } },
    ],
    transitions: [{ id: "start-line", name: "启动产线", fromStateId: "idle", toStateId: "running", command: { type: "start" } }],
    interlocks: [{
      id: "guard-door",
      name: "防护门互锁",
      faultCode: "guard-open",
      alarmSignal: "alarm",
      affectedTransitionIds: ["start-line"],
      safeSignals: { motorRunning: false },
    }],
    safetyConstraints: [],
    bindings: [
      { id: "binding-motor", signal: "motorRunning", presentation: "running", target: { sceneId: "scene-a", objectId: "motor-a", objectKind: "model" } },
      { id: "binding-alarm", signal: "alarm", presentation: "alarm", target: { sceneId: "scene-a", objectId: "motor-a", objectKind: "model" } },
    ],
  };
}
