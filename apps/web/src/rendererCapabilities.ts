import { requiresWebGlPublicationEffects, sceneRequiresWebGlPublicationEffects, type SceneSnapshot } from "@bim-studio/contracts";
import { resolveRayTracingDecision, type RayTracingCapabilities, type RayTracingDecision } from "@bim-studio/deep-engine";
import type { RendererBackend } from "./viewer/ViewerEngine";
import { xrEntryBlockReasons } from "./viewer/xrSession";

export interface RendererCapabilityProbe {
  secureContext: boolean;
  webgl2: boolean;
  webgpuApi: boolean;
  webgpuAdapter: boolean;
  adapterName?: string;
  maxTextureDimension2D?: number;
  maxBindGroups?: number;
  maxStorageBufferBindingSize?: number;
  maxComputeInvocationsPerWorkgroup?: number;
  timestampQuery: boolean;
  shaderF16: boolean;
  /** Hardware ray tracing capability snapshot.  WebGPU currently exposes this
   * only on experimental adapters; absence is reported as a deterministic
   * software fallback rather than inferred from the API presence. */
  rayTracing?: RayTracingCapabilities;
  rayTracingDecision?: RayTracingDecision;
}

export interface RendererProjectRequirements {
  postProcessingEnabled: boolean;
}

export interface PublishedRendererDecision {
  backend: "webgl" | "webgpu";
  reason: "publication-webgl" | "webgpu-unavailable" | "preserve-authored-effects" | "webgpu-preferred";
}

/** `auto` 从兼容后端启动，待发布快照加载后再执行能力与画质守卫。 */
export function initialRendererBackend(queryValue: string | null, storedValue: string | null): RendererBackend {
  if (queryValue === "wasm") return "wasm";
  if (queryValue === "webgpu") return "webgpu";
  if (queryValue === "webgl" || queryValue === "auto") return "webgl";
  return storedValue === "webgpu" || storedValue === "wasm" ? storedValue : "webgl";
}

/** 从持久化场景中提取仍需 WebGL 发布守卫的作者效果。 */
export function rendererRequirementsForScene(
  scene: Pick<SceneSnapshot, "models" | "postProcessing" | "primitives">
): RendererProjectRequirements {
  return {
    postProcessingEnabled: sceneRequiresWebGlPublicationEffects(scene)
  };
}

export const requiresWebGlPostProcessing = requiresWebGlPublicationEffects;

export interface RendererReadiness {
  backend: RendererBackend;
  ready: boolean;
  level: "ready" | "limited" | "unavailable";
  summary: string;
  details: string[];
}

/** XR 会话静态可用性；与引擎 startXR 的前置门槛共用 xrEntryBlockReasons 单一事实源。 */
export interface XrSessionAvailability {
  supported: boolean;
  reasons: string[];
}

export function xrSessionAvailability(input: {
  secureContext: boolean;
  webxr: boolean;
  backend: RendererBackend;
}): XrSessionAvailability {
  const reasons = xrEntryBlockReasons({ secureContext: input.secureContext, webxrApi: input.webxr, authorBackend: input.backend });
  return { supported: reasons.length === 0, reasons };
}

interface AdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  features?: { has(name: string): boolean };
  limits?: {
    maxTextureDimension2D?: number;
    maxBindGroups?: number;
    maxStorageBufferBindingSize?: number;
    maxComputeInvocationsPerWorkgroup?: number;
  };
}

export async function probeRendererCapabilities(): Promise<RendererCapabilityProbe> {
  const canvas = document.createElement("canvas");
  const webGlContext = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
  const webgl2 = Boolean(webGlContext);
  // 能力探测不持有额外图形上下文，避免诊断与发布预检反复占用浏览器配额。
  webGlContext?.getExtension("WEBGL_lose_context")?.loseContext();
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> } }).gpu;
  let adapter: AdapterLike | null = null;
  if (gpu && window.isSecureContext) {
    try {
      adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }) as AdapterLike | null;
    } catch {
      adapter = null;
    }
  }
  const info = adapter?.info;
  const adapterName = [info?.vendor, info?.architecture, info?.device, info?.description].filter(Boolean).join(" · ");
  const rayTracing = adapter ? rayTracingCapabilities(adapter, adapterName || "unknown-adapter") : undefined;
  return {
    secureContext: window.isSecureContext,
    webgl2,
    webgpuApi: Boolean(gpu),
    webgpuAdapter: Boolean(adapter),
    timestampQuery: adapter?.features?.has("timestamp-query") ?? false,
    shaderF16: adapter?.features?.has("shader-f16") ?? false,
    ...(rayTracing === undefined ? {} : { rayTracing, rayTracingDecision: resolveRayTracingDecision(rayTracing) }),
    ...(adapterName ? { adapterName } : {}),
    ...(adapter?.limits?.maxTextureDimension2D ? { maxTextureDimension2D: adapter.limits.maxTextureDimension2D } : {}),
    ...(adapter?.limits?.maxBindGroups ? { maxBindGroups: adapter.limits.maxBindGroups } : {}),
    ...(adapter?.limits?.maxStorageBufferBindingSize ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : {}),
    ...(adapter?.limits?.maxComputeInvocationsPerWorkgroup ? { maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup } : {})
  };
}

/**
 * WebGPU has no stable ray-tracing feature names yet. Probe the names used by
 * current experimental implementations explicitly; never treat a generic
 * WebGPU adapter as RT-capable. This keeps the diagnostics honest while the
 * software BVH/TLAS paths remain the production fallback.
 */
function rayTracingCapabilities(adapter: AdapterLike, adapterId: string): RayTracingCapabilities {
  const has = (names: readonly string[]) => names.some((name) => adapter.features?.has(name) === true);
  const accelerationStructure = has(["acceleration-structure", "ray-tracing", "chromium-experimental-ray-tracing"]);
  const rayQuery = has(["ray-query", "chromium-experimental-ray-query"]);
  const rayPipeline = has(["rt-pipeline", "ray-tracing-pipeline", "chromium-experimental-ray-tracing-pipeline"]);
  const tier = accelerationStructure && rayPipeline ? "pipeline" : accelerationStructure && rayQuery ? "query" : "none";
  return Object.freeze({ schemaVersion: 1, adapterId, tier,
    features: Object.freeze({ "acceleration-structure": accelerationStructure, "ray-query": rayQuery, "rt-pipeline": rayPipeline }),
    // No standard limit is exposed; 0 is an explicit unknown/unsupported
    // value, never an invented budget.
    maxAccelerationStructureBytes: 0 });
}

/**
 * 发布选择只判断设备与作者效果守卫，不代表 Deep 产品画质与功能已验收。
 */
export function selectPublishedRenderer(
  publicationMode: "webgl" | "webgpu-preferred" | "cloud" | undefined,
  webGpuAvailable: boolean,
  project: RendererProjectRequirements
): PublishedRendererDecision {
  if (publicationMode !== "webgpu-preferred" && publicationMode !== "cloud") {
    return { backend: "webgl", reason: "publication-webgl" };
  }
  if (!webGpuAvailable) return { backend: "webgl", reason: "webgpu-unavailable" };
  if (project.postProcessingEnabled) {
    return { backend: "webgl", reason: "preserve-authored-effects" };
  }
  return { backend: "webgpu", reason: "webgpu-preferred" };
}

/** WebGL 发布不需要申请 WebGPU 适配器；仅实际候选后端执行设备探测。 */
export async function resolvePublishedRenderer(
  mode: Parameters<typeof selectPublishedRenderer>[0],
  requirements: RendererProjectRequirements,
  probe = probeRendererCapabilities,
): Promise<PublishedRendererDecision> {
  if (mode !== "webgpu-preferred" && mode !== "cloud") return selectPublishedRenderer(mode, false, requirements);
  const capabilities = await probe();
  return selectPublishedRenderer(mode, capabilities.secureContext && capabilities.webgpuApi && capabilities.webgpuAdapter, requirements);
}

export function rendererReadiness(probe: RendererCapabilityProbe, _project: RendererProjectRequirements): RendererReadiness[] {
  const webglDetails = [
    "Three.js WebGL 2，编辑与生态兼容",
    "完整材质、后处理、拾取、动画与 WebXR",
  ];
  const webgpuDetails = [
    "自研 WebGPU：PBR、阴影、环境、后处理",
    "GPU 驱动大场景，内置帧图与性能诊断",
  ];
  const webgpuAvailable = probe.secureContext && probe.webgpuApi && probe.webgpuAdapter;
  const wasmDetails = [
    "Rust/WASM 全引擎，与 Native 共用内核",
    "浏览器本地运行，支持离线与跨端交付",
  ];
  return [{
    backend: "webgl",
    ready: probe.webgl2,
    level: probe.webgl2 ? "ready" : "unavailable",
    summary: probe.webgl2 ? "完整编辑，兼容性强" : "当前环境无法创建 WebGL 2 上下文",
    details: webglDetails
  }, {
    backend: "webgpu",
    ready: webgpuAvailable,
    // 设备可创建不等于 Deep 产品验收，持续保持 limited。
    level: !webgpuAvailable ? "unavailable" : "limited",
    summary: !webgpuAvailable ? "当前设备不可用" : "现代 GPU 管线，面向大场景",
    details: webgpuDetails
  }, {
    backend: "wasm",
    ready: webgpuAvailable,
    level: webgpuAvailable ? "ready" : "unavailable",
    summary: webgpuAvailable ? "Rust 内核，跨端本地运行" : "当前设备不可用",
    details: wasmDetails,
  }];
}
