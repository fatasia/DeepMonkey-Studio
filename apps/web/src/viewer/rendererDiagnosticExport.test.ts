import { describe, expect, it } from "vitest";
import { createRendererDiagnosticEvidence } from "./rendererDiagnosticExport";

describe("renderer diagnostic evidence", () => {
  it("preserves WebGPU capability and performance evidence without project content", () => {
    const evidence = createRendererDiagnosticEvidence({
      current: "webgpu",
      probe: {
        secureContext: true,
        webgl2: true,
        webgpuApi: true,
        webgpuAdapter: true,
        timestampQuery: true,
        shaderF16: false,
        maxBindGroups: 4
      },
      readiness: [{ backend: "webgpu", ready: true, level: "ready", summary: "可试用", details: [] }],
      performance: undefined
    }, "2026-08-30T00:00:00.000Z", "test-browser");

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      currentBackend: "webgpu",
      userAgent: "test-browser",
      capabilityProbe: { timestampQuery: true, maxBindGroups: 4 }
    });
    expect(JSON.stringify(evidence)).not.toContain("projectId");
  });
});
