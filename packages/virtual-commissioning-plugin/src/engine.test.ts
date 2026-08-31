import { describe, expect, it } from "vitest";
import {
  createVirtualDebugProvider,
  createVirtualDebugSuiteProvider,
  runVirtualDebugScenario,
  runVirtualDebugSuite,
} from "./engine.js";

describe("virtual commissioning core", () => {
  it("replays a deterministic control sequence with a fault and evidence", () => {
    const scenario = { id: "line-1", durationMs: 200, tickMs: 50, commands: [{ atMs: 0, type: "start" as const }], faults: [{ atMs: 100, code: "over-temperature" }], assertions: [{ id: "motor", expression: "running-implies-motor" as const }] };
    const first = runVirtualDebugScenario(scenario);
    const second = runVirtualDebugScenario(scenario);
    expect(first.status).toBe("passed");
    expect(first.trace[2]).toMatchObject({ state: "faulted", signals: { alarm: true, motorRunning: false }, events: ["fault:over-temperature"] });
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);
  });

  it("returns blocked provider output when an assertion fails", async () => {
    const provider = createVirtualDebugProvider();
    const result = await provider.invoke({ requestId: "1", projectId: "p", input: { id: "line-1", durationMs: 50, commands: [{ atMs: 0, type: "start" }] } }, { pluginId: "simulation", pluginVersion: "1.0.0", descriptor: provider.descriptor, signal: new AbortController().signal });
    expect(result.status).toBe("completed");
    expect(result.output?.evidenceFingerprint).toHaveLength(64);
  });

  it("attaches the mapped scene object to assertion evidence", () => {
    const result = runVirtualDebugScenario({
      id: "line-binding",
      durationMs: 100,
      tickMs: 50,
      initialSignals: { pressureOk: false },
      assertions: [{ id: "pressure", atMs: 50, expression: "signal-equals", signal: "pressureOk", value: true }],
      bindings: [{ id: "pressure-binding", signal: "pressureOk", presentation: "alarm", target: { sceneId: "scene-1", objectId: "pump-1", objectKind: "model" } }]
    });

    expect(result.failures[0]).toMatchObject({
      assertionId: "pressure",
      signal: "pressureOk",
      bindingId: "pressure-binding",
      target: { sceneId: "scene-1", objectId: "pump-1" }
    });
    expect(result.bindings).toHaveLength(1);
  });

  it("passes a golden matrix when normal and expected-failure cases both match", async () => {
    const suite = {
      id: "line-golden",
      label: "产线黄金测试",
      cases: [
        {
          id: "normal-start",
          label: "正常启动",
          expectedStatus: "passed" as const,
          scenario: {
            id: "normal-start",
            durationMs: 50,
            tickMs: 50,
            commands: [{ atMs: 0, type: "start" as const }],
            assertions: [{ id: "motor", atMs: 0, expression: "running-implies-motor" as const }],
          },
        },
        {
          id: "stuck-sensor-detected",
          label: "传感器卡滞被检出",
          expectedStatus: "failed" as const,
          scenario: {
            id: "stuck-sensor-detected",
            durationMs: 50,
            tickMs: 50,
            initialSignals: { sensorHealthy: false },
            assertions: [{ id: "sensor", atMs: 0, expression: "signal-equals" as const, signal: "sensorHealthy", value: true }],
          },
        },
      ],
    };

    const first = runVirtualDebugSuite(suite);
    const second = runVirtualDebugSuite(suite);
    expect(first).toMatchObject({ status: "passed", totalCases: 2, matchedCases: 2 });
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);

    const provider = createVirtualDebugSuiteProvider();
    const response = await provider.invoke(
      { requestId: "suite-1", projectId: "p", input: suite },
      { pluginId: "simulation", pluginVersion: "1.0.0", descriptor: provider.descriptor, signal: new AbortController().signal },
    );
    expect(response.status).toBe("completed");
    expect(response.warnings).toBeUndefined();
  });
});
