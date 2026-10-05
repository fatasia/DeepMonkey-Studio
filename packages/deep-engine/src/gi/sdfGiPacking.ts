/**
 * Brief-GI M2 纯函数面:uniform/表打包、预算窗口计划、记录初值、计时登记暂存。
 * 全部确定性(同输入逐位同输出),无 GPU 依赖 —— 单测与真机探针直接消费。
 *
 * 逐 pass 计时登记(hlodProxyTimedPass 同款原子 diff 暂存):
 * `PBR_TIMED_PASS_IDS` 的合同是「清单必须与 pbrFramePlanExecutor.MAPPED_EXECUTORS 键
 * 集合一致,且 pbrFramePlanExecutor.test 以集合相等钉死」。sdf-gi 两 pass 尚无对应帧图
 * pass(帧图/计划执行器是其他在途域,且集合相等要求与特性门控默认帧冲突),因此登记
 * 以原子 diff 暂存:帧图声明 sdf-gi pass + MAPPED_EXECUTORS 记 executor + 本清单追加,
 * 三文件同切片落地。登记前 marker 会因未注册被跳过并记诊断,故 encode 只在
 * `sdfGiTimedPassRegistration().registered` 为真时括夹(当前 false,零噪音)。
 */

import { PBR_TIMED_PASS_IDS } from "../webgpu/pbrTimedPassIds.js";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import { SDF_SKY_VISIBILITY_PARAMS_BYTES } from "./sdfSkyVisibilityTraceWgsl.js";
import { SDF_GI_PROBE_UPDATE_BOUNCE_ENERGY_LIMIT, SDF_GI_PROBE_UPDATE_PARAMS_BYTES,
  SDF_GI_PROBE_RECORD_VEC4_STRIDE } from "./sdfGiProbeUpdateWgsl.js";

/** 暂存登记的两个计时 pass 身份(J4:新计时 pass 必须登记能力行)。 */
export const SDF_GI_TIMED_PASS_IDS = Object.freeze(["sdf-gi-sky-trace", "sdf-gi-probe-update"]);
/** 声明这两个 pass 的能力行 id(rendererCapabilitySelfCheck 的 sdf-gi 行)。 */
export const SDF_GI_CAPABILITY_ID = "sdf-gi";

/** 从实际清单面派生登记状态(hlodProxyTimedPassRegistration 同款;落地后翻 true)。 */
export function sdfGiTimedPassRegistration(): { registered: boolean; stageAccepted: boolean } {
  const registered = SDF_GI_TIMED_PASS_IDS
    .every(id => (PBR_TIMED_PASS_IDS as readonly string[]).includes(id));
  return { registered, stageAccepted: registered };
}

/**
 * 帧内更新窗口计划:count = clamp(budget,0,probeCount);offset = (已派发窗口 × count)
 * mod probeCount,窗口触底时钳制到 probeCount − offset —— 每个探针每周期恰更新一次,
 * 不重复滤波(重复 α 混合虽收缩无害,但会令窗口末端探针收敛速率不一致)。
 */
export function planSdfGiProbeWindow(probeCount: number, budget: number,
  dispatchedWindows: number): { offset: number; count: number } {
  if (probeCount <= 0) return { offset: 0, count: 0 };
  const stride = Math.max(0, Math.min(Math.floor(budget), probeCount));
  if (stride === 0) return { offset: 0, count: 0 };
  const offset = (dispatchedWindows * stride) % probeCount;
  return { offset, count: Math.min(stride, probeCount - offset) };
}

/** ProbeUpdateParams 打包(64B;布局与 wgsl/sdfGiProbeUpdate.wgsl 的 struct 互钉:
 * 8 标量 + bounceAlbedo vec4@32 + maxDistance f32@48,struct 对齐舍入到 64)。 */
export function packSdfGiProbeUpdateParams(input: { probeCount: number; directionCount: number;
  windowOffset: number; windowCount: number; alpha: number; maxDistance: number;
  bounceAlbedo?: readonly [number, number, number] }): ArrayBuffer {
  const buffer = new ArrayBuffer(SDF_GI_PROBE_UPDATE_PARAMS_BYTES);
  const words = new DataView(buffer);
  words.setUint32(0, input.probeCount, true);
  words.setUint32(4, input.directionCount, true);
  words.setUint32(8, input.windowOffset, true);
  words.setUint32(12, input.windowCount, true);
  words.setFloat32(16, input.alpha, true);
  words.setUint32(20, input.bounceAlbedo ? 1 : 0, true);
  words.setUint32(24, SDF_GI_PROBE_RECORD_VEC4_STRIDE, true);
  words.setFloat32(28, SDF_GI_PROBE_UPDATE_BOUNCE_ENERGY_LIMIT, true);
  const albedo = input.bounceAlbedo ?? [0, 0, 0];
  words.setFloat32(32, albedo[0]!, true);
  words.setFloat32(36, albedo[1]!, true);
  words.setFloat32(40, albedo[2]!, true);
  words.setFloat32(44, 0, true);
  words.setFloat32(48, input.maxDistance, true);
  return buffer;
}

/**
 * 探针几何统计 CPU 镜像(GI-FIN 2026-10-05):把天光追踪的逐 (探针 × 方向) 命中距离
 * (traceSdfSkyVisibilityWithHits 输出,miss = −1)按探针归约为
 * [meanDistance, distanceVariance] —— 与 wgsl/sdfGiProbeUpdate.wgsl 的核内归约同式
 * 同序(命中数 ≥1:mean = 命中距离均值、var = 命中距离总体方差;命中数 0:
 * mean = maxDistance、var = 0,开放空间语义)。语义对齐 probeOcclusionRayExtension
 * 的记录合同;喂给 updateProbeShWithSdfGi 的 geometryStats(CPU/GPU 同口径)。
 * JS f64 累加 vs GPU f32:FMA 差异走容差对拍(A3 布料先例口径)。
 */
export function sdfGiProbeGeometryStats(hitDistances: ArrayLike<number>, directionCount: number,
  maxDistance: number): readonly (readonly [number, number])[] {
  if (directionCount <= 0 || hitDistances.length % directionCount !== 0) {
    throw new RangeError("SDF GI geometry stats require hit distances aligned to the direction count.");
  }
  const probeCount = hitDistances.length / directionCount;
  const stats: (readonly [number, number])[] = [];
  for (let probe = 0; probe < probeCount; probe++) {
    const first = probe * directionCount;
    let sum = 0, count = 0;
    for (let direction = 0; direction < directionCount; direction++) {
      const hit = hitDistances[first + direction]!;
      if (hit >= 0) { sum += hit; count += 1; }
    }
    if (count === 0) { stats.push([maxDistance, 0] as const); continue; }
    const mean = sum / count;
    if (count === 1) { stats.push([mean, 0] as const); continue; }
    let squared = 0;
    for (let direction = 0; direction < directionCount; direction++) {
      const hit = hitDistances[first + direction]!;
      if (hit >= 0) { const delta = hit - mean; squared += delta * delta; }
    }
    stats.push([mean, squared / count] as const);
  }
  return stats;
}

/** SkyTraceParams 打包(48B;布局与 wgsl/sdfSkyVisibilityTrace.wgsl 的 struct 互钉:
 * origin vec3f@0 + cellSize@12 + dimensions vec3u@16 + steps@28 + coneTan@32 +
 * maxDistance@36 + directionCount@40 + probeCount@44)。 */
export function packSdfGiSkyTraceParams(input: { origin: readonly [number, number, number];
  cellSize: number; dimensions: readonly [number, number, number]; steps: number;
  coneTan: number; maxDistance: number; directionCount: number; probeCount: number }):
  ArrayBuffer {
  const buffer = new ArrayBuffer(SDF_SKY_VISIBILITY_PARAMS_BYTES);
  const words = new DataView(buffer);
  words.setFloat32(0, input.origin[0], true);
  words.setFloat32(4, input.origin[1], true);
  words.setFloat32(8, input.origin[2], true);
  words.setFloat32(12, input.cellSize, true);
  words.setUint32(16, input.dimensions[0], true);
  words.setUint32(20, input.dimensions[1], true);
  words.setUint32(24, input.dimensions[2], true);
  words.setUint32(28, input.steps, true);
  words.setFloat32(32, input.coneTan, true);
  words.setFloat32(36, input.maxDistance, true);
  words.setUint32(40, input.directionCount, true);
  words.setUint32(44, input.probeCount, true);
  return buffer;
}

/** 每方向天空辐射表(vec4f/方向,xyz=RGB、w=0;生产全方向同值,ABI 留逐方向余量)。 */
export function packSdfGiSkyRadianceTable(directionCount: number,
  rgb: readonly [number, number, number]): Float32Array<ArrayBuffer> {
  const table = new Float32Array(directionCount * 4);
  for (let direction = 0; direction < directionCount; direction++) {
    table[direction * 4] = rgb[0]!;
    table[direction * 4 + 1] = rgb[1]!;
    table[direction * 4 + 2] = rgb[2]!;
    table[direction * 4 + 3] = 0;
  }
  return table;
}

/** Fibonacci 方向表(vec4f/方向,xyz 单位向量、w=0;CPU 权威 probeOcclusionDirection)。 */
export function packSdfGiDirectionTable(directionCount: number): Float32Array<ArrayBuffer> {
  const table = new Float32Array(directionCount * 4);
  for (let direction = 0; direction < directionCount; direction++) {
    const [x, y, z] = probeOcclusionDirection(direction, directionCount);
    table[direction * 4] = x;
    table[direction * 4 + 1] = y;
    table[direction * 4 + 2] = z;
    table[direction * 4 + 3] = 0;
  }
  return table;
}

/** 探针位置表(vec4f,xyz 有效、w=0;sdfSkyVisibilityTrace 打包合同)。 */
export function packSdfGiProbePositions(positions: readonly (readonly number[])[]):
  Float32Array<ArrayBuffer> {
  const table = new Float32Array(positions.length * 4);
  for (let probe = 0; probe < positions.length; probe++) {
    table[probe * 4] = positions[probe]![0]!;
    table[probe * 4 + 1] = positions[probe]![1]!;
    table[probe * 4 + 2] = positions[probe]![2]!;
    table[probe * 4 + 3] = 0;
  }
  return table;
}

/**
 * 烘焙期记录初值(96B ABI × probeCount):validity 1、irradiance 0、meanDistance/variance
 * 取有界 Chebyshev 可见先验(maxDistance/2 与 (maxDistance/4)² —— 采样链可见性判据的
 * 有界初值;F5 words[12..23] 全零 = SH 缺失语义)。SH 更新核只覆写 irradiance/c0。
 */
export function packInitialSdfGiRecords(probeCount: number,
  maxDistance: number): Float32Array<ArrayBuffer> {
  const records = new Float32Array(probeCount * SDF_GI_PROBE_RECORD_VEC4_STRIDE * 4);
  const meanDistance = maxDistance * 0.5;
  const variance = Math.max((maxDistance * 0.25) ** 2, 1e-4);
  for (let probe = 0; probe < probeCount; probe++) {
    const base = probe * SDF_GI_PROBE_RECORD_VEC4_STRIDE * 4;
    records[base + 3] = 1; // validity
    records[base + 4] = meanDistance;
    records[base + 5] = variance;
  }
  return records;
}
