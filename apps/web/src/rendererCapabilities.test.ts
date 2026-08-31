import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialRendererBackend,
  probeRendererCapabilities,
  rendererReadiness,
  rendererRequirementsForScene,
  selectPublishedRenderer,
} from "./rendererCapabilities";

afterEach(() => vi.unstubAllGlobals());

describe("renderer capability probe", () => {
  it("reports WebGPU unavailable when the API exists but no adapter can be acquired", async () => {
    const loseContext = vi.fn();
    const requestAdapter = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({
          getExtension: () => ({ loseContext }),
        }),
      }),
    });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { gpu: { requestAdapter } });

    const result = await probeRendererCapabilities();

    expect(result).toMatchObject({
      secureContext: true,
      webgl2: true,
      webgpuApi: true,
      webgpuAdapter: false,
    });
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
    expect(loseContext).toHaveBeenCalledOnce();
  });
});

describe("renderer readiness", () => {
  it("explains why WebGPU is unavailable", () => {
    const result = rendererReadiness(
      { secureContext: false, webgl2: true, webgpuApi: true, webgpuAdapter: false, timestampQuery: false, shaderF16: false },
      { postProcessingEnabled: false },
    );
    expect(result[1]).toMatchObject({ backend: "webgpu", ready: false, level: "unavailable" });
    expect(result[1]?.details).toContain("需要 HTTPS 或 localhost 安全上下文");
  });

  it("reports implemented TSL effects while retaining the unsigned publication guard", () => {
    const result = rendererReadiness(
      { secureContext: true, webgl2: true, webgpuApi: true, webgpuAdapter: true, timestampQuery: true, shaderF16: true },
      { postProcessingEnabled: true },
    );
    expect(result[1]).toMatchObject({ backend: "webgpu", ready: true, level: "limited" });
    expect(result[1]?.details).toContain("WebGPU TSL 已覆盖核心后处理与对象轮廓；画质等价仍按发布场景签署，自动发布暂保留 WebGL");
  });

  it("separates scene publication readiness from full product parity", () => {
    const result = rendererReadiness(
      { secureContext: true, webgl2: true, webgpuApi: true, webgpuAdapter: true, timestampQuery: true, shaderF16: true },
      { postProcessingEnabled: false },
    );
    expect(result[1]).toMatchObject({ backend: "webgpu", ready: true, level: "limited", summary: "场景可发布，产品能力仍在验收" });
    expect(result[1]?.details).toContain("当前场景满足显式 WebGPU 优先发布条件；自动默认仍保留 WebGL");
    expect(result[1]?.details).toContain("产品 WebGPU 路径尚未完成 WebXR 实机验收，XR 会话继续使用 WebGL");
  });
});

describe("published renderer selection", () => {
  it("uses WebGPU only when the device and authored effects are compatible", () => {
    expect(selectPublishedRenderer("webgpu-preferred", true, { postProcessingEnabled: false })).toEqual({
      backend: "webgpu",
      reason: "webgpu-preferred",
    });
  });

  it("keeps WebGL when switching would hide authored post-processing", () => {
    expect(selectPublishedRenderer("webgpu-preferred", true, { postProcessingEnabled: true })).toEqual({
      backend: "webgl",
      reason: "preserve-authored-effects",
    });
  });

  it("keeps WebGL when WebGPU is unavailable or was not requested", () => {
    expect(selectPublishedRenderer("cloud", false, { postProcessingEnabled: false }).reason).toBe("webgpu-unavailable");
    expect(selectPublishedRenderer("webgl", true, { postProcessingEnabled: false }).reason).toBe("publication-webgl");
  });

  it("treats object outline as a WebGL post-processing requirement", () => {
    const requirements = rendererRequirementsForScene({
      models: [
        {
          modelId: "pump",
          name: "Pump",
          visible: true,
          opacity: 1,
          transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          effects: { outline: true, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false, color: "#fff", intensity: 1 },
        },
      ],
      primitives: [],
    });
    expect(requirements.postProcessingEnabled).toBe(true);
    expect(selectPublishedRenderer("webgpu-preferred", true, requirements).backend).toBe("webgl");
  });

  it("does not block WebGPU for an enabled but empty post-processing group", () => {
    const requirements = rendererRequirementsForScene({
      models: [],
      primitives: [],
      postProcessing: {
        enabled: true,
        smaa: false,
        fxaa: false,
        ssao: false,
        ssaoIntensity: 1,
        bloom: false,
        bloomStrength: 0.35,
        bloomThreshold: 0.9,
        outline: false,
        outlineStrength: 2.5,
      },
    });
    expect(requirements.postProcessingEnabled).toBe(false);
  });
});

describe("initial renderer selection", () => {
  it("lets an explicit auto publication start override stale local storage", () => {
    expect(initialRendererBackend("auto", "webgpu")).toBe("webgl");
    expect(initialRendererBackend("webgl", "webgpu")).toBe("webgl");
    expect(initialRendererBackend("webgpu", "webgl")).toBe("webgpu");
  });
});
