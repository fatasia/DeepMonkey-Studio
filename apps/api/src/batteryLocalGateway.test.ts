import { describe, expect, it, vi } from "vitest";
import { parseBatteryUpload } from "./batteryUpload.js";
import { batterySampleCsv } from "../../web/src/ai/batterySample.js";
import { loadBundledBatteryModels, bundledBatteryCatalog } from "./batteryBundledModels.js";
import { createLocalBatteryGateway } from "./batteryLocalGateway.js";
import { loadBatteryOnnxDeployment } from "./batteryOnnxDeployment.js";

describe("project-contained battery inference", () => {
  it("runs all three real ONNX models without network and keeps candidate authority", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const deployment = await loadBundledBatteryModels();
      const gateway = createLocalBatteryGateway(deployment);
      const records = parseBatteryUpload(Buffer.from(batterySampleCsv()));
      for (const model of deployment.requestedModels) {
        const output = await gateway.predict({ model, records, fileName: "synthetic-battery-sample.csv", chemistry: "lfp", nominalCapacityAh: 100 });
        expect(output).toMatchObject({ productionApproved: false, executionMode: "local-validation", runtimeExecution: { actual: "onnx", fellBack: false }, inferenceEvidence: { authority: "advisory", routingPolicy: "local-validation-onnx", model: { artifactSha256: expect.any(String) } } });
        const metric = model === "bmsformer" ? output.currentSoh : model === "socformer" ? output.finalSoc : output.predictedCycleLife;
        expect(typeof metric).toBe("number");
        expect(Number.isFinite(metric)).toBe(true);
      }
      expect(network).not.toHaveBeenCalled();
      expect(bundledBatteryCatalog()).toHaveLength(3);
      expect(bundledBatteryCatalog().every(item => !item.productionEligible && item.productionTraffic === 0)).toBe(true);
      await expect(loadBatteryOnnxDeployment({ BATTERY_ONNX_MANIFEST_FILE: `${deployment.artifactRoot}/candidate-manifests.json` })).rejects.toThrow("清单结构无效");
      await expect(gateway.initializeTwin({})).rejects.toThrow("未包含");
      await expect(gateway.predict({ model: "socformer", fileName: "invalid.csv", chemistry: "lfp", records: [{ voltage: 500, current: 1, time: 1 }] })).rejects.toThrow("输入不满足");
    } finally { network.mockRestore(); }
  }, 30_000);
});
