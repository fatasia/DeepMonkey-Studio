import type { RendererBackend } from "./viewer/ViewerEngine";

export interface RendererCapabilityProbe {
  secureContext: boolean;
  webgl2: boolean;
  webgpuApi: boolean;
  webgpuAdapter: boolean;
  adapterName?: string;
  maxTextureDimension2D?: number;
}

export interface RendererProjectRequirements {
  postProcessingEnabled: boolean;
}

export interface RendererReadiness {
  backend: RendererBackend;
  ready: boolean;
  level: "ready" | "limited" | "unavailable";
  summary: string;
  details: string[];
}

interface AdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  limits?: { maxTextureDimension2D?: number };
}

export async function probeRendererCapabilities(): Promise<RendererCapabilityProbe> {
  const canvas = document.createElement("canvas");
  const webgl2 = Boolean(canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }));
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
    ...(adapterName ? { adapterName } : {}),
    ...(adapter?.limits?.maxTextureDimension2D ? { maxTextureDimension2D: adapter.limits.maxTextureDimension2D } : {})
  };
}

export function rendererReadiness(probe: RendererCapabilityProbe, project: RendererProjectRequirements): RendererReadiness[] {
  const webglDetails = [
    project.postProcessingEnabled ? "当前后处理管线完整可用" : "模型、材质、拾取与动画完整可用",
    "作为生产兼容后端保留"
  ];
  const webgpuDetails = [
    !probe.secureContext ? "需要 HTTPS 或 localhost 安全上下文" : "安全上下文可用",
    !probe.webgpuApi ? "浏览器未暴露 WebGPU API" : !probe.webgpuAdapter ? "未找到可用的高性能 GPU 适配器" : "GPU 适配器可用",
    project.postProcessingEnabled ? "当前后处理将暂停显示，配置会保留" : "当前项目未发现已知显示限制"
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
    level: !webgpuAvailable ? "unavailable" : project.postProcessingEnabled ? "limited" : "ready",
    summary: !webgpuAvailable ? "当前设备不可用" : project.postProcessingEnabled ? "可试用，存在项目限制" : "可试用，未发现项目限制",
    details: webgpuDetails
  }];
}
