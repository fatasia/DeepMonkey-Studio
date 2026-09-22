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
  backend: RendererBackend;
  reason: "publication-webgl" | "webgpu-unavailable" | "preserve-authored-effects" | "webgpu-preferred";
}

/** `auto` 从兼容后端启动，待发布快照加载后再执行能力与画质守卫。 */
export function initialRendererBackend(queryValue: string | null, storedValue: string | null): RendererBackend {
  if (queryValue === "webgpu") return "webgpu";
  if (queryValue === "webgl" || queryValue === "auto") return "webgl";
  return storedValue === "webgpu" ? "webgpu" : "webgl";
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

export function rendererReadiness(probe: RendererCapabilityProbe, project: RendererProjectRequirements): RendererReadiness[] {
  const webglDetails = [
    project.postProcessingEnabled ? "当前后处理与真实对象轮廓完整可用" : "模型、材质、拾取与动画完整可用",
    "XR 会话挂载在本后端：WebXR 进入、控制器选择与双目渲染均走 WebGL",
    "作为生产兼容后端保留"
  ];
  const webgpuDetails = [
    !probe.secureContext ? "需要 HTTPS 或 localhost 安全上下文" : "安全上下文可用",
    !probe.webgpuApi ? "浏览器未暴露 WebGPU API" : !probe.webgpuAdapter ? "未找到可用的高性能 GPU 适配器" : "GPU 适配器可用",
    "Studio 使用 Deep WebGPU 投影画布；材质、环境与作者辅助层仍需逐场景验收",
    project.postProcessingEnabled
      ? "作者后处理或对象轮廓需要逐场景验证；自动发布保留 WebGL"
      : "仅在显式选择时使用；自动默认仍保留 WebGL",
    "产品 WebGPU 路径尚未完成 WebXR 实机验收，XR 会话继续使用 WebGL",
    "Deep WebGPU 激活期间 XR 入口不可用；浏览器端 WebGPU-XR 会话特性尚未落地，属诚实降级而非缺陷",
    probe.rayTracingDecision
      ? probe.rayTracingDecision.enabled
        ? `硬件光追能力：${probe.rayTracingDecision.tier}；${probe.rayTracingDecision.fallbacks.length ? `保留回退：${probe.rayTracingDecision.fallbacks.join("、")}` : "无回退"}`
        : `硬件光追不可用；保留${probe.rayTracingDecision.fallbacks.join("、")}路径`
      : "未取得硬件光追能力快照；使用软件 BVH/TLAS 路径"
  ];
  const webgpuAvailable = probe.secureContext && probe.webgpuApi && probe.webgpuAdapter;
  return [{
    backend: "webgl",
    ready: probe.webgl2,
    level: probe.webgl2 ? "ready" : "unavailable",
    summary: probe.webgl2 ? "生产兼容，功能完整" : "当前环境无法创建 WebGL 2 上下文",
    details: webglDetails
  }, {
    backend: "webgpu",
    ready: webgpuAvailable,
    // 设备可创建不等于 Deep 产品验收，持续保持 limited。
    level: !webgpuAvailable ? "unavailable" : "limited",
    summary: !webgpuAvailable ? "当前设备不可用" : project.postProcessingEnabled ? "可试用，存在场景限制" : "可试用，需逐场景验收",
    details: webgpuDetails
  }];
}
