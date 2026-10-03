/**
 * F6 接线清单①:布料 GPU 并行核(A3,3206952f)的生产换核入口。
 *
 * 职责拆分(sourceSizeGate 纪律):既有串行 dispatch(`softBodyGpuDispatch.ts`,
 * 单工作组构造序核)原样保留为回退路径,该文件零改动;本文件只做三件事:
 * 1. `dispatchClothParallelGpuStep` — 把 A3 并行核(确定性着色色序 Gauss-Seidel,
 *    色间 dispatch 定序)接入与串行完全相同的输入合同 `ClothGpuStepInput`:
 *    宿主着色 → 色桶序约束缓冲 → 每 tick 单 compute pass(substeps×(2+色数)
 *    dispatch)→ readback。
 * 2. `dispatchClothStepAuto` — 换核开关:parallel-first 默认;着色不可用/WGSL
 *    编译失败/设备侧错误三类原因 fail-closed 回退既有串行核,原因入遥测。
 * 3. 遥测计数(纯计数器,不影响任何行为与数值)。
 *
 * 确定性合同:并行核语义真值 = CPU f32 镜像 `ClothParallelMirror`(A3 已锁 240
 * tick 指纹 fixture);真机 FMA 使 GPU vs 镜像非逐位(9.0e-3 m 容差内,A3 实测),
 * 本接线不改变该口径。串行与并行都正确但投影序不同、互相不逐位:确定性重放要求
 * 会话内固定一种内核(结果 kernel 字段供调用方锁定);开关无粘性状态。管线按
 * device 用 WeakMap 缓存(失败不缓存,回退后可重试);缓冲逐调用新建,复用化
 * 会话留接线清单下一片。
 *
 * sourceSizeGate 拆分(2026-10-03):按职责分文件,代码逐行同源仅改可见性,
 * 语义零变化;本文件保留全部既有导出面(消费方导入路径不变):
 *   障碍 ABI/合同类型 → softBodyGpuDispatch.clothParallelContract.ts;
 *   params 打包/管线缓存/tick 步进 → softBodyGpuDispatch.clothParallelKernel.ts。
 */
import { dispatchClothGpuStep } from "./softBodyGpuDispatch.js";
import { dispatchClothParallelGpuStep } from "./softBodyGpuDispatch.clothParallelKernel.js";
import {
  type ClothKernelChoice, type ClothKernelFallbackReason, ClothParallelDispatchError,
  type ClothKernelSwitchResult, type ClothKernelSwitchTelemetry,
} from "./softBodyGpuDispatch.clothParallelContract.js";
import type { ClothGpuStepInput } from "./clothGpuWgsl.js";

export {
  CLOTH_GPU_MAX_OBSTACLES, clothParallelDispatchCount, ClothParallelDispatchError,
  packClothGpuObstacles,
} from "./softBodyGpuDispatch.clothParallelContract.js";
export type {
  ClothGpuObstacle, ClothKernelChoice, ClothKernelFallbackReason, ClothKernelSwitchResult,
  ClothKernelSwitchTelemetry, ClothKernelUsed, ClothParallelDispatchResult,
} from "./softBodyGpuDispatch.clothParallelContract.js";
export { dispatchClothParallelGpuStep } from "./softBodyGpuDispatch.clothParallelKernel.js";

// 遥测是本模块唯一的全局可变状态:纯整数计数,无时钟/随机源,不参与任何数值路径。
const telemetry = {
  parallelSteps: 0,
  serialSteps: 0,
  fallbacks: { "coloring-unavailable": 0, "wgsl-compile-error": 0, "gpu-error": 0 } as Record<ClothKernelFallbackReason, number>,
  lastFallbackReason: null as ClothKernelFallbackReason | null,
};

export function snapshotClothKernelSwitchTelemetry(): ClothKernelSwitchTelemetry {
  const { parallelSteps, serialSteps, lastFallbackReason } = telemetry;
  return { parallelSteps, serialSteps, fallbacksByReason: { ...telemetry.fallbacks }, lastFallbackReason };
}

export function resetClothKernelSwitchTelemetry(): void {
  telemetry.parallelSteps = 0;
  telemetry.serialSteps = 0;
  for (const reason of Object.keys(telemetry.fallbacks) as ClothKernelFallbackReason[]) telemetry.fallbacks[reason] = 0;
  telemetry.lastFallbackReason = null;
}

/** 会话叶(softBodyGpuDispatch.clothSession)复用同一遥测口径的纯计数入口。 */
export function noteClothParallelSessionStep(): void {
  telemetry.parallelSteps += 1;
}

/**
 * 换核开关(生产入口):默认 parallel-first,任一并行侧失败按原因回退既有串行核。
 * 每次调用独立决策(无粘性);确定性重放由调用方按结果 kernel 字段固定会话内核。
 */
export async function dispatchClothStepAuto(
  device: GPUDevice, input: ClothGpuStepInput,
  options: { kernel?: ClothKernelChoice } = {},
): Promise<ClothKernelSwitchResult> {
  if ((options.kernel ?? "parallel-first") === "serial") {
    telemetry.serialSteps += 1;
    const serial = await dispatchClothGpuStep(device, input);
    return { ...serial, kernel: "cloth-serial", dispatchCount: 1, colorCount: 0, fallbackReason: null };
  }
  try {
    const parallel = await dispatchClothParallelGpuStep(device, input);
    telemetry.parallelSteps += 1;
    return { ...parallel, kernel: "cloth-parallel", fallbackReason: null };
  } catch (error) {
    // 调用方错误(参数/拓扑非法)直接上抛:回退只救设备/着色类失败,不污染遥测。
    if (!(error instanceof ClothParallelDispatchError)) throw error;
    const reason = error.reason;
    telemetry.serialSteps += 1;
    telemetry.fallbacks[reason] += 1;
    telemetry.lastFallbackReason = reason;
    const serial = await dispatchClothGpuStep(device, input);
    return { ...serial, kernel: "cloth-serial", dispatchCount: 1, colorCount: 0, fallbackReason: reason };
  }
}
