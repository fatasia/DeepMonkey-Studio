import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT } from "./renderTargets.js";

/** 主 pass MSAA 能力解析结果:sampleCount=1 时必须携带 fail-closed 原因。 */
export interface PbrMsaaCapability {
  readonly sampleCount: 1 | 4;
  /** 设备不支持 4x 时的验证错误原文(经 probe 触发);请求即 1 时缺省。 */
  readonly fallbackReason?: string;
}

/**
 * AA-M1 设备能力探测:4x MSAA 在核心 WebGPU 是"要求支持"的推荐档,但 depth32float
 * 的多采样支持随驱动/后端而异,标准 limits 又不暴露逐格式采样数上限 —— 唯一可靠
 * 判定是 error-scope 探针(同 activateHdrCanvas 先例):创建 4x 的 HDR color 与
 * depth 目标,捕获异步 validation error,失败 fail-closed 回 1x 并上报原因。
 * 必须在 bootstrap 校验作用域开启前调用(popErrorScope 会弹出最近作用域)。
 */
export async function probePbrMainSampleCount(device: GPUDevice, requested: 1 | 4): Promise<PbrMsaaCapability> {
  if (requested === 1) return { sampleCount: 1 };
  if (typeof GPUTextureUsage === "undefined") return { sampleCount: 1, fallbackReason: "GPUTextureUsage unavailable; MSAA probe skipped" };
  device.pushErrorScope("validation");
  try {
    const color = device.createTexture({ label: "Deep MSAA capability probe color", size: { width: 4, height: 4 },
      format: PBR_HDR_FORMAT, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const depth = device.createTexture({ label: "Deep MSAA capability probe depth", size: { width: 4, height: 4 },
      format: PBR_DEPTH_FORMAT, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    color.destroy(); depth.destroy();
    const error = await device.popErrorScope();
    return error ? { sampleCount: 1, fallbackReason: error.message } : { sampleCount: 4 };
  } catch (error) {
    try { await device.popErrorScope(); } catch { /* device loss owns diagnostics */ }
    return { sampleCount: 1, fallbackReason: error instanceof Error ? error.message : String(error) };
  }
}
