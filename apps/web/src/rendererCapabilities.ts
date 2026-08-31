import { requiresWebGlPublicationEffects, sceneRequiresWebGlPublicationEffects, type SceneSnapshot } from "@bim-studio/contracts";
import type { RendererBackend } from "./viewer/ViewerEngine";

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

/** 从持久化场景中提取仍需 WebGL 发布守卫的作者效果；不代表 WebGPU 运行时未实现这些能力。 */
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
  return {
    secureContext: window.isSecureContext,
    webgl2,
    webgpuApi: Boolean(gpu),
    webgpuAdapter: Boolean(adapter),
    timestampQuery: adapter?.features?.has("timestamp-query") ?? false,
    shaderF16: adapter?.features?.has("shader-f16") ?? false,
    ...(adapterName ? { adapterName } : {}),
    ...(adapter?.limits?.maxTextureDimension2D ? { maxTextureDimension2D: adapter.limits.maxTextureDimension2D } : {}),
    ...(adapter?.limits?.maxBindGroups ? { maxBindGroups: adapter.limits.maxBindGroups } : {}),
    ...(adapter?.limits?.maxStorageBufferBindingSize ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : {}),
    ...(adapter?.limits?.maxComputeInvocationsPerWorkgroup ? { maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup } : {})
  };
}

/**
 * 发布页自动选择只采用已完成画质与稳定签署的 WebGPU。TSL 已覆盖核心后处理，
 * 但签署完成前仍不能静默改变作者画面；用户显式切换可继续用于验收。
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

export function rendererReadiness(probe: RendererCapabilityProbe, project: RendererProjectRequirements): RendererReadiness[] {
  const webglDetails = [
    project.postProcessingEnabled ? "当前后处理与真实对象轮廓完整可用" : "模型、材质、拾取与动画完整可用",
    "作为生产兼容后端保留"
  ];
  const webgpuDetails = [
    !probe.secureContext ? "需要 HTTPS 或 localhost 安全上下文" : "安全上下文可用",
    !probe.webgpuApi ? "浏览器未暴露 WebGPU API" : !probe.webgpuAdapter ? "未找到可用的高性能 GPU 适配器" : "GPU 适配器可用",
    project.postProcessingEnabled
      ? "WebGPU TSL 已覆盖核心后处理与对象轮廓；画质等价仍按发布场景签署，自动发布暂保留 WebGL"
      : "当前场景满足显式 WebGPU 优先发布条件；自动默认仍保留 WebGL",
    "产品 WebGPU 路径尚未完成 WebXR 实机验收，XR 会话继续使用 WebGL"
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
    // “核心效果已接入”不等于“产品全能力已签署”：画质与 WebXR 验收完成前保持 limited。
    level: !webgpuAvailable ? "unavailable" : "limited",
    summary: !webgpuAvailable ? "当前设备不可用" : project.postProcessingEnabled ? "可试用，存在场景限制" : "场景可发布，产品能力仍在验收",
    details: webgpuDetails
  }];
}
