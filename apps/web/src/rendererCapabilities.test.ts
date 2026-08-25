import { describe, expect, it } from "vitest";
import { rendererReadiness } from "./rendererCapabilities";

describe("renderer readiness", () => {
  it("explains why WebGPU is unavailable", () => {
    const result = rendererReadiness({ secureContext: false, webgl2: true, webgpuApi: true, webgpuAdapter: false }, { postProcessingEnabled: false });
    expect(result[1]).toMatchObject({ backend: "webgpu", ready: false, level: "unavailable" });
    expect(result[1]?.details).toContain("需要 HTTPS 或 localhost 安全上下文");
  });

  it("marks WebGPU limited without discarding post-processing configuration", () => {
    const result = rendererReadiness({ secureContext: true, webgl2: true, webgpuApi: true, webgpuAdapter: true }, { postProcessingEnabled: true });
    expect(result[1]).toMatchObject({ backend: "webgpu", ready: true, level: "limited" });
    expect(result[1]?.details).toContain("当前后处理将暂停显示，配置会保留");
  });
});
