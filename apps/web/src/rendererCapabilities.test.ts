import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialRendererBackend,
  probeRendererCapabilities,
  rendererReadiness,
  rendererRequirementsForScene,
  selectPublishedRenderer,
  resolvePublishedRenderer,
  xrSessionAvailability,
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

  it("records experimental RT features and keeps the software fallback explicit", async () => {
    const loseContext = vi.fn();
    const requestAdapter = vi.fn().mockResolvedValue({
      info: { vendor: "Test", device: "RT adapter" },
      features: new Set(["acceleration-structure", "ray-query"]),
      limits: {},
    });
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ getExtension: () => ({ loseContext }) }),
      }),
    });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { gpu: { requestAdapter } });

    const result = await probeRendererCapabilities();

    expect(result.rayTracing).toMatchObject({
      tier: "query",
      features: { "acceleration-structure": true, "ray-query": true, "rt-pipeline": false },
    });
    expect(result.rayTracingDecision).toMatchObject({ enabled: true, tier: "query", fallbacks: ["software-shadows"] });
  });
});

describe("renderer readiness", () => {
  it("explains why WebGPU is unavailable", () => {
    const result = rendererReadiness(
      { secureContext: false, webgl2: true, webgpuApi: true, webgpuAdapter: false, timestampQuery: false, shaderF16: false },
      { postProcessingEnabled: false },
    );
    expect(result[1]).toMatchObject({
      backend: "webgpu",
      ready: false,
      level: "unavailable",
      summary: "当前设备不可用",
    });
    expect(result[1]?.details).toEqual([
      "自研 WebGPU：PBR、阴影、环境、后处理",
      "GPU 驱动大场景，内置帧图与性能诊断",
    ]);
  });

  it("reports the Deep projection boundary while retaining the publication guard", () => {
    const result = rendererReadiness(
      { secureContext: true, webgl2: true, webgpuApi: true, webgpuAdapter: true, timestampQuery: true, shaderF16: true },
      { postProcessingEnabled: true },
    );
    expect(result[1]).toMatchObject({ backend: "webgpu", ready: true, level: "limited" });
    expect(result[1]?.details).toHaveLength(2);
  });

  it("separates scene publication readiness from full product parity", () => {
    const result = rendererReadiness(
      { secureContext: true, webgl2: true, webgpuApi: true, webgpuAdapter: true, timestampQuery: true, shaderF16: true },
      { postProcessingEnabled: false },
    );
    expect(result[1]).toMatchObject({ backend: "webgpu", ready: true, level: "limited", summary: "现代 GPU 管线，面向大场景" });
    expect(result[1]?.details).toEqual([
      "自研 WebGPU：PBR、阴影、环境、后处理",
      "GPU 驱动大场景，内置帧图与性能诊断",
    ]);
  });
});

describe("published renderer selection", () => {
  it("does not allocate probe graphics resources for a WebGL publication", async () => {
    const probe = vi.fn();
    for (const mode of [undefined, "webgl"] as const) {
      await expect(resolvePublishedRenderer(mode, { postProcessingEnabled: false }, probe)).resolves.toEqual({ backend: "webgl", reason: "publication-webgl" });
    }
    expect(probe).not.toHaveBeenCalled();
  });
  it("still probes actual WebGPU candidates and preserves effect guards", async () => {
    const probe = vi.fn().mockResolvedValue({ secureContext: true, webgpuApi: true, webgpuAdapter: true });
    await expect(resolvePublishedRenderer("webgpu-preferred", { postProcessingEnabled: false }, probe)).resolves.toEqual({ backend: "webgpu", reason: "webgpu-preferred" });
    await expect(resolvePublishedRenderer("cloud", { postProcessingEnabled: true }, probe)).resolves.toEqual({ backend: "webgl", reason: "preserve-authored-effects" });
    expect(probe).toHaveBeenCalledTimes(2);
  });
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
    expect(initialRendererBackend("wasm", "webgl")).toBe("wasm");
    expect(initialRendererBackend(null, "wasm")).toBe("wasm");
  });
});

describe("XR session availability", () => {
  it("supports XR on the WebGL backend in a secure context with the WebXR API", () => {
    expect(xrSessionAvailability({ secureContext: true, webxr: true, backend: "webgl" })).toEqual({
      supported: true,
      reasons: [],
    });
  });

  it("explains that XR is WebGL-only while Deep WebGPU is active", () => {
    const result = xrSessionAvailability({ secureContext: true, webxr: true, backend: "webgpu" });
    expect(result.supported).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("仅 Three WebGL 渲染后端支持");
  });

  it("lists every unmet static requirement for the panel", () => {
    const result = xrSessionAvailability({ secureContext: false, webxr: false, backend: "webgl" });
    expect(result.supported).toBe(false);
    expect(result.reasons).toContain("需要 HTTPS 或 localhost 安全上下文");
    expect(result.reasons).toContain("浏览器未暴露 WebXR API（navigator.xr）");
  });

  it("keeps the readiness rows focused on engine capabilities", () => {
    const result = rendererReadiness(
      { secureContext: true, webgl2: true, webgpuApi: true, webgpuAdapter: true, timestampQuery: true, shaderF16: true },
      { postProcessingEnabled: false },
    );
    expect(result[0]?.details).toContain("完整材质、后处理、拾取、动画与 WebXR");
    expect(result[1]?.details).toContain("GPU 驱动大场景，内置帧图与性能诊断");
    expect(result[2]).toMatchObject({ backend: "wasm", ready: true, level: "ready" });
  });
});
