import { PROBE_RADIANCE_MAX_DIRECTIONS } from "../rayTracing/probeRadianceKernel.js";
import type { DeepGiQuality } from "./probeClipmapPlan.js";

/**
 * GI 探针每探针方向数的生产配置门（G3-S1）：把 T02 联测证明过的 32 方向档
 * （fib32）从"联测变体"提升为配置可选值，默认档保持 16（联测决策未切默认）。
 *
 * == 证据锚点（同一参考场景：房间+薄墙+门洞+天窗，70 探针、62 稳定非埋入） ==
 * - 真机（Chrome headless WebGPU / NVIDIA Lovelace，生产 probeRadianceKernel）：
 *   fib8 22.49%、fib16 11.56%（>10% 未达标）、fib32 7.95%（≤10% 达标）；
 *   GPU vs 同方向 RenderPacket CPU 最大通道偏差 ≤2.5e-4（f16 量化内）。
 *   证据：`docs/reports/deep-core/assets/g3s1-probe-rmse-sequence-2026-09-28.json`。
 * - 结论与 T02 报告一致：误差主因是方向采样密度，不是内核算错；达标档 = 32。
 *
 * == 门控语义（两段式，与仓内既有惯例对齐） ==
 * - `resolveDeepGiProbeDirectionCount` 是运行时配置边界：**永不抛错**——非法值
 *   fail-closed 回退 16（渲染循环不因脏配置中断），并在结果里给机器可读原因。
 * - `probeRadianceDirectionPresetForQuality` 是作者档位映射：非法质量档 fail-fast
 *   抛错（与 `probeClipmapOptionsForQuality` 同契约；作者期错误必须在接线处暴露）。
 *
 * == 注入路径（为什么 WGSL 零改动） ==
 * 方向表容量在 `probeRadianceKernel` 是编译期常量 `array<vec4f, 32>`（uniform 576B
 * 布局，已由 probeGpuJointAnalysis 测试钉死 320B 前缀兼容 + 32 容量逐字节对拍），
 * 而每批实际方向数是运行时 uniform 字段 `RadianceParams.directionCount`、由 CPU 侧
 * `packProbeRadianceUniform` 打包。因此配置门只需落在 CPU 侧数值上——这是对现有
 * 架构侵入最小的方案：容量参数化成 16/32 预编译变体会引入第二条 pipeline 与第二套
 * uniform 布局（320B/576B），却没有任何收益（捕获成本随派发射线数缩放，不随表容量）。
 * 门的高档值在模块加载时断言不超过内核容量，内核容量收缩会在这里立即 fail-fast。
 */

/** 默认方向档（现行生产默认；T02 实测 11.56% 未达 10%，切换留联测决策，不在本门内）。 */
export const DEEP_GI_PROBE_DIRECTIONS_STANDARD = 16;
/** opt-in 方向档（T02 + G3-S1 真机实测 7.95% ≤10% 达标；= 内核容量上限）。 */
export const DEEP_GI_PROBE_DIRECTIONS_HIGH = 32;

if (DEEP_GI_PROBE_DIRECTIONS_HIGH > PROBE_RADIANCE_MAX_DIRECTIONS) {
  throw new Error(`Deep GI direction gate high tier (${DEEP_GI_PROBE_DIRECTIONS_HIGH}) must not exceed the `
    + `probe radiance kernel capacity (${PROBE_RADIANCE_MAX_DIRECTIONS}).`);
}

/** 门控允许的两个方向数；其它整数一律不是合法配置值。 */
export type DeepGiProbeDirectionCount =
  | typeof DEEP_GI_PROBE_DIRECTIONS_STANDARD
  | typeof DEEP_GI_PROBE_DIRECTIONS_HIGH;

/** 配置词表：`"standard"`（16，默认）与 `"high"`（32，opt-in）。 */
export type DeepGiProbeDirectionPreset = "standard" | "high";

export interface DeepGiProbeDirectionResolution {
  readonly directionCount: DeepGiProbeDirectionCount;
  /** true = 输入非法，已 fail-closed 回退 standard(16)；渲染循环继续，不抛错。 */
  readonly failClosed: boolean;
  /** failClosed 时的机器可读原因；正常路径省略。 */
  readonly reason?: string;
}

const STANDARD_RESOLUTION: DeepGiProbeDirectionResolution = Object.freeze({
  directionCount: DEEP_GI_PROBE_DIRECTIONS_STANDARD, failClosed: false,
});

/**
 * 解析方向数配置：`undefined`/`"standard"`/16 → 16；`"high"`/32 → 32；
 * 其余一切值（含 8、33、"ultra"、NaN、对象等）fail-closed 回 16 并给出原因。
 * 这是产品接线处应调用的唯一入口（pbrRenderer 生产工厂接线点见 G3-S1 报告）。
 */
export function resolveDeepGiProbeDirectionCount(
  value?: DeepGiProbeDirectionPreset | DeepGiProbeDirectionCount): DeepGiProbeDirectionResolution {
  if (value === undefined || value === "standard" || value === DEEP_GI_PROBE_DIRECTIONS_STANDARD) {
    return STANDARD_RESOLUTION;
  }
  if (value === "high" || value === DEEP_GI_PROBE_DIRECTIONS_HIGH) {
    return Object.freeze({ directionCount: DEEP_GI_PROBE_DIRECTIONS_HIGH, failClosed: false });
  }
  return Object.freeze({ directionCount: DEEP_GI_PROBE_DIRECTIONS_STANDARD, failClosed: true,
    reason: `Deep GI probe direction config must be "standard"(16), "high"(32), 16 or 32; `
      + `got ${describe(value)}; failed closed to ${DEEP_GI_PROBE_DIRECTIONS_STANDARD}.` });
}

/** 质量档位 → 方向档映射：performance/balanced 保持默认 16，quality 档 opt-in 32。 */
export function probeRadianceDirectionPresetForQuality(quality: DeepGiQuality): DeepGiProbeDirectionPreset {
  switch (quality) {
    case "performance":
    case "balanced":
      return "standard";
    case "quality":
      return "high";
    default:
      throw new RangeError("Invalid Deep GI quality.");
  }
}

/** 质量档位 → 方向数（preset 映射后经同一解析器，保证单一权威）。 */
export function probeRadianceDirectionCountForQuality(quality: DeepGiQuality): DeepGiProbeDirectionCount {
  return resolveDeepGiProbeDirectionCount(probeRadianceDirectionPresetForQuality(quality)).directionCount;
}

/**
 * 产品工厂（pbrRenderer）专用解析：`undefined` = 未配置，保持已发布默认 32（fib32 才过
 * RMSE 10% 门槛，见 G3-S1 报告——零配置画质口径下默认档不允许降到 16）；显式配置经同一
 * fail-closed 门解析。与 `resolveDeepGiProbeDirectionCount` 的差异仅在未配置分支。
 */
export function resolveDeepGiProducerDirectionCount(
  value?: DeepGiProbeDirectionPreset | DeepGiProbeDirectionCount): DeepGiProbeDirectionCount {
  if (value === undefined) return DEEP_GI_PROBE_DIRECTIONS_HIGH;
  return resolveDeepGiProbeDirectionCount(value).directionCount;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
