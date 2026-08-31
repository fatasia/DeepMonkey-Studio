import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { RendererDeviceLossInfo } from "./viewerTypes";

/** ViewerEngine 支持的渲染器联合类型。 */
export type RendererInstance = THREE.WebGLRenderer | WebGPURenderer;

export type WebGpuRendererWithLossHandler = WebGPURenderer & {
  onDeviceLost: (info: unknown) => void;
};

/** 只暴露故障恢复需要的最小 GPUDevice 契约，避免业务代码依赖实验中的 WebGPU DOM 类型包。 */
export interface RuntimeGpuDevice {
  readonly lost: Promise<unknown>;
  readonly queue: { onSubmittedWorkDone(): Promise<void> };
  destroy(): void;
}

export function runtimeGpuDevice(renderer: RendererInstance): RuntimeGpuDevice | undefined {
  if (!("backend" in renderer)) return undefined;
  return (renderer.backend as { device?: RuntimeGpuDevice }).device;
}

export function normalizeRendererDeviceLoss(value: unknown): RendererDeviceLossInfo {
  const info = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    api: "WebGPU",
    message: typeof info.message === "string" && info.message.trim() ? info.message : "GPU device was lost",
    reason: typeof info.reason === "string" ? info.reason : null
  };
}
