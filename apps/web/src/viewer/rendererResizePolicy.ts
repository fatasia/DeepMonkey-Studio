import type { RendererBackend } from "./viewerTypes";

interface RendererResizePolicyInput {
  backend: RendererBackend;
  drawingBufferInitialized: boolean;
  shadowsEnabled: boolean;
}

/**
 * Three.js r184 的 WebGPU 阴影目标在重配交换链后可能继续引用失效资源。
 * 已初始化且启用阴影时固定高质量绘图缓冲，仅由 CSS 调整显示尺寸；r185 又存在场景释放回归，暂不升级。
 */
export function shouldResizeRendererDrawingBuffer(input: RendererResizePolicyInput): boolean {
  if (!input.drawingBufferInitialized) return true;
  return input.backend !== "webgpu" || !input.shadowsEnabled;
}

/** WebGPU 阴影模式保持创建时的满质量像素比，避免自适应比例触发同类交换链缺陷。 */
export function canChangeRendererPixelRatio(input: RendererResizePolicyInput): boolean {
  return shouldResizeRendererDrawingBuffer(input);
}
