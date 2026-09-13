import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../serverOptions.js";
import { executeAiSample, registerAiSampleRoutes } from "./aiSampleRoutes.js";

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(closeTasks.splice(0).map(close => close())); });

describe("isolated runnable AI samples", () => {
  it("executes a real query plan over local rows without a connection or project dataset", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const sample = await executeAiSample("qa-query", "query");
    expect(sample.output).toMatchObject({ plan: { groupBy: ["device"] }, result: { matchedRows: 4, returnedRows: 2, rows: [{ device: "设备 A", mean_temperature: 42 }, { device: "设备 B", mean_temperature: 56 }] } });
    expect(sample.engine).toBe("data-query-plan-and-read");
    expect(network).not.toHaveBeenCalled();
  });
  it("runs real native scoring and preserves benchmark/production boundaries", async () => {
    const result = await executeAiSample("project-a", "maintenance");
    expect(result.output).toMatchObject({ projectId: "project-a", riskLevel: "critical", decisionStatus: "shadow", dataQuality: 1 });
    expect(result.engine).toBe("maintenance-native-json");
    expect(result.metrics[1]?.value).toBe("76.9%");
    const rerun = await executeAiSample("project-b", "maintenance");
    expect(rerun.runId).not.toBe(result.runId);
    expect(rerun.inputFingerprint).toBe(result.inputFingerprint);
    expect(rerun.output).toMatchObject({ projectId: "project-b", decisionStatus: "shadow" });
    expect(JSON.stringify(rerun)).not.toContain("project-a");
  });

  it("executes bundled YOLOX weights and decodes real model output without network or project assets", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network available"));
    const result = await executeAiSample("project-a", "vision");
    expect(result.output).toMatchObject({ modelInferenceExecuted: true, executionProvider: "cpu", inputTensorDimensions: [1, 3, 416, 416] });
    const output = result.output as { detections: Array<{ label: string; confidence: number }> };
    expect(output.detections.map(item => item.label)).toEqual(expect.arrayContaining(["dog", "bicycle"]));
    expect(output.detections.every(item => item.confidence >= 0.4 && item.confidence <= 1)).toBe(true);
    expect(result.engine).toBe("vision-onnxruntime-yolox-nano");
    expect(result.input).not.toHaveProperty("syntheticOutput");
    expect(result.execution).toBe("local-sample");
    const independent = await executeAiSample("independent-project", "vision");
    expect(independent.projectId).toBe("independent-project");
    expect(independent.inputFingerprint).toBe(result.inputFingerprint);
    expect(independent.output).toMatchObject({ detections: output.detections });
    expect(JSON.stringify(independent)).not.toContain("project-a");
    expect(network).not.toHaveBeenCalled();
  });

  it("returns a meaningful energy deviation from the production analysis kernel", async () => {
    const result = await executeAiSample("project-a", "energy");
    expect(result.output).toMatchObject({ projectId: "project-a", severity: "critical" });
    expect(JSON.stringify(result.output)).toContain("空转");
  });

  it("requires an existing scoped project and rejects unknown sample kinds over HTTP", async () => {
    const app = createApiServer(); closeTasks.push(() => app.close());
    await registerAiSampleRoutes(app, { store: { getProject: id => id === "project-a" ? { id } as never : undefined } });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${origin}/api/projects/project-a/ai/samples/maintenance/run`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ projectId: "project-a", kind: "maintenance" });
    expect((await app.inject({ method: "POST", url: "/api/projects/foreign/ai/samples/maintenance/run" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/projects/project-a/ai/samples/arbitrary/run" })).statusCode).toBe(404);
  });
});
