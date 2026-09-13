import { afterEach, describe, expect, it, vi } from "vitest";
import { batterySampleCsv } from "../../web/src/ai/batterySample.js";
import { parseBatteryUpload } from "./batteryUpload.js";
import { BatteryPinnRustRuntime } from "./batteryPinnRustRuntime.js";

describe("BatteryPinnRustRuntime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prepares the six-input contract and completes native PINN evidence", async () => {
    const normalized = Array.from({ length: 5000 }, (_, index) => 1 - index / 10_000);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      runtime: "rust-ort",
      output: {
        sohTrajectory: normalized,
        physicalSoh: normalized,
        physicsGate: 0.2,
        identifiabilityScore: 0.68,
        physicalObservationRmse: 0.02,
        physicalFitScore: 0.82,
        nominalCapacityAh: 100,
        equivalentResistanceOhm: 0.0012,
        effectiveDiffusionTimeHours: [28.1, 29.2],
        normalizedFadeRatePerCycle: 0.0002,
        chemistryFadeScale: 1,
        ocvMinimumV: 2.8,
        ocvSpanV: 1.2,
        exchangeCRate: 1.1,
        overpotentialScaleV: 0.08,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runtime = new BatteryPinnRustRuntime("http://native.test");
    const output = await runtime.predict({
      model: "batterymformer", variant: "physics", routingMode: "physics",
      fileName: "CALB_25_test.csv", records: parseBatteryUpload(Buffer.from(batterySampleCsv())),
      chemistry: "lfp", nominalCapacityAh: 100,
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.curves).toHaveLength(100 * 4 * 300);
    expect(request.physics_condition).toHaveLength(11);
    expect(output).toMatchObject({
      physicsArchitecture: "learnable-spm-pinn",
      serviceVariant: "physics",
      runtimeExecution: { actual: "onnx", runtime: "rust-ort", fellBack: false },
      identifiedPhysicsParameters: { identifiabilityScore: 0.68, equivalentResistanceOhm: 0.0012 },
      rulObservation: { targetThresholdPct: 80 },
    });
  });
});
