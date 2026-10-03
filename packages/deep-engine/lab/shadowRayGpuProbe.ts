/// <reference types="@webgpu/types" />
/**
 * 阴影光线 GPU 探针（由 scripts/shadowRayGpuTest.mjs 驱动，headless Chrome + WebGPU）。
 * 与 rayTraceGpuProbe 同构：Node 与浏览器共用同一 esbuild bundle（案例/场景/参考单一来源）。
 * 浏览器腿走完整 API 路径（ShadowRayMaskPass 持久缓冲 → dispatch → 读回），返回
 * 逐档（f32/f16）mask + GPU 时间戳测量；掩码哈希与 RMSE 仲裁在 Node 侧完成。
 */

import { emitShadowRayMaskKernelWgsl, SHADOW_RAY_MASK_ENTRY_POINT } from "../src/rayTracing/shadowRayKernel.js";
import { ShadowRayMaskPass, type ShadowRayMaskResult } from "../src/rayTracing/shadowRayPass.js";
import { buildShadowBatch, buildShadowCases, buildReceiverPoints, type ShadowScene } from "./shadowRayGpuCases.js";

export { emitShadowRayMaskKernelWgsl, SHADOW_RAY_MASK_ENTRY_POINT };
export { buildShadowBatch, buildShadowCases, buildReceiverPoints } from "./shadowRayGpuCases.js";

export interface ShadowGpuCaseResult {
  readonly variant: "f32" | "f16";
  /** 掩码 base64（Uint32Array 小端字节；Node 侧解码仲裁）。 */
  readonly maskBase64: string;
  readonly rayCount: number;
  /** GPU dispatch 时间（ms，timestamp-query 实测；不可用为 null）。 */
  readonly gpuMs: number | null;
  /** 兜底墙钟（提交+读回整程，包含读回开销；仅证据用，不作 <2ms 门）。 */
  readonly wallMs: number;
  readonly stackOverflows: number;
  readonly validationMessages: readonly string[];
}

export interface ShadowGpuProbeResult {
  readonly cases: Record<string, ShadowGpuCaseResult>;
  readonly adapter: string | null;
  readonly features: readonly string[];
  readonly shaderF16: boolean;
  readonly timestampQuery: boolean;
  readonly errors: readonly string[];
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 浏览器探针主入口（page.evaluate 调用）。 */
export async function runShadowRayGpuProbe(): Promise<ShadowGpuProbeResult> {
  const errors: string[] = [];
  const cases: Record<string, ShadowGpuCaseResult> = {};
  if (!("gpu" in navigator) || navigator.gpu === undefined) {
    return { cases, adapter: null, features: [], shaderF16: false, timestampQuery: false,
      errors: ["WebGPU is not available in this context."] };
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) {
    return { cases, adapter: null, features: [], shaderF16: false, timestampQuery: false,
      errors: ["navigator.gpu.requestAdapter() returned null."] };
  }
  const features = [...adapter.features];
  const shaderF16 = adapter.features.has("shader-f16");
  const timestampQuery = adapter.features.has("timestamp-query");
  const required: GPUFeatureName[] = [];
  if (shaderF16) required.push("shader-f16" as GPUFeatureName);
  if (timestampQuery) required.push("timestamp-query" as GPUFeatureName);
  const device = await adapter.requestDevice({ requiredFeatures: required });
  device.addEventListener?.("uncapturederror", (event: Event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  // GPUAdapter.info 属较新规范（0.1.72 类型未含）；仅作证据记录，缺失降级 unknown。
  const adapterInfo = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string } }).info;
  const adapterName = adapterInfo === undefined ? "unknown"
    : `${adapterInfo.vendor ?? "unknown"}/${adapterInfo.architecture ?? ""}`;
  const casesSpec = buildShadowCases();
  const receivers = buildReceiverPoints(casesSpec.receiverGrid);
  const batch = buildShadowBatch(receivers);
  const variants: Array<{ variant: "f32" | "f16"; f16: boolean }> =
    [{ variant: "f32", f16: false }, ...(shaderF16 ? [{ variant: "f16" as const, f16: true }] : [])];
  for (const spec of variants) {
    try {
      const pass = new ShadowRayMaskPass(device, casesSpec.scene.tlas.packed,
        { f16: spec.f16, measureGpuTime: timestampQuery });
      try {
        // 预热一次（管线编译/pipeline cache），计时取其后多次最小值（验收②：10k rays dispatch <2ms）。
        await pass.dispatchMask(batch);
        let bestGpu: number | null = null, bestWall = Infinity, mask: ShadowRayMaskResult | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const wallStart = performance.now();
          const result = await pass.dispatchMask(batch);
          const wall = performance.now() - wallStart;
          bestWall = Math.min(bestWall, wall);
          if (result.gpuMs !== undefined) bestGpu = bestGpu === null ? result.gpuMs : Math.min(bestGpu, result.gpuMs);
          mask = result;
        }
        cases[spec.variant] = {
          variant: spec.variant, maskBase64: toBase64(mask!.mask.buffer as ArrayBuffer), rayCount: mask!.mask.length,
          gpuMs: bestGpu, wallMs: bestWall, stackOverflows: mask!.stackOverflows, validationMessages: [],
        };
      } finally {
        pass.destroy();
      }
    } catch (error) {
      errors.push(`${spec.variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  device.destroy();
  return {
    cases, adapter: adapterName, features,
    shaderF16, timestampQuery, errors,
  };
}
