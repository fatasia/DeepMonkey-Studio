import { describe, expect, it } from "vitest";
import { classifyRendererInitialization } from "./rendererGateClassification.mjs";

const available = { secureContext: true, webGpuApi: true, webGpuAdapter: true };

describe("renderer gate classification", () => {
  it("fails product initialization errors when a WebGPU adapter exists", () => {
    expect(classifyRendererInitialization({ backend: "webgpu", required: false }, available, "pipeline failed"))
      .toEqual({ environmentBlocked: false, failures: ["渲染器初始化失败：pipeline failed"] });
  });

  it("allows an actual environment block in the ordinary product gate", () => {
    expect(classifyRendererInitialization(
      { backend: "webgpu", required: false },
      { secureContext: true, webGpuApi: true, webGpuAdapter: false },
      "WebGPU unavailable"
    )).toEqual({ environmentBlocked: true, failures: [] });
  });

  it("fails the strict gate when its GPU environment is missing", () => {
    expect(classifyRendererInitialization(
      { backend: "webgpu", required: true },
      { secureContext: true, webGpuApi: false, webGpuAdapter: false },
      "WebGPU unavailable"
    ).failures).toHaveLength(1);
  });
});
