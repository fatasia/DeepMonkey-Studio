import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";
import { DEEP_REFLECTION_PROBE_RECORD_BYTES, DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF,
  DEEP_REFLECTION_PROBE_SENTINEL_DEGENERATE, DEEP_REFLECTION_PROBE_SENTINEL_OUTSIDE,
  DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP } from "./reflectionProbeBoxProjectionWgsl.js";
import { reflectionProbeInfluenceWeightCpu, reflectionProbePairWeightsCpu,
} from "./reflectionProbeParallaxMath.js";

/**
 * C15 反射探针盒投影视差校正——CPU 数据面(打包 / AABB 来源 / 双探针选择)。
 * WGSL 单源核的 CPU 镜像在 reflectionProbeParallaxMath.ts,量化规范在
 * reflectionProbeParallaxQuantify.ts;本文件是聚合出口(既有 import 路径不变)。
 *
 * == AABB 来源(双轨,手置优先) ==
 * `manual`:作者显式指定 center/halfExtents——反射视差域是作者意图(房间/展柜级精度),
 *   自动派生无法知道玻璃幕墙后的空间不该算进反射域,必须可覆盖。
 * `scene-bounds`:零配置兜底,从 sceneBounds 派生(中心=包围盒中心,halfExtents=
 *   包围盒半尺寸×autoScale),与 GI clipmap level 的 origin/max 场景派生同纪律;
 *   autoScale<1 允许收缩到主导几何。两者皆缺 fail-closed 抛错。
 *
 * == 混合/切换语义(选择:双探针插值,代际切换为退化档) ==
 * 选双探针插值而非纯代际切换,理由:高光反射内容低频但边界跳变极显眼,硬切换在影响体
 * 交界产生可见 pop/亮带,插值用 influenceWeight 过渡壳线性混合(Unity 影响体混合同式);
 * 与既有 DDGI 权重混合纪律同构,权重核单源共享;成本可控——无重叠处退化为单探针
 * (w=(1,0)),只有过渡壳内付第二份 cubemap 采样,次级低于
 * DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF 即裁剪。代际切换并未弃用:blendDistance=0
 * 时权重核退化为边界硬切换,单 cubemap 绑定的宿主可先以"权重最大者当探针代际"接入,
 * 双纹理绑定就绪后无语义迁移成本。
 *
 * == 已知边界(量化钉死,见 test 与 GPU 证据) ==
 * 盒投影的构造性成立域是影响体 AABB 表面:盒面上内容误差为 0,平面(现状)误差随接收点
 * 偏心涨至 61.5°(1080p/60° 视口 ≈ 1107px);但内容远超影响体(窗外远景)时盒投影把内容
 * 压到盒面,方向误差反而大于平面——这正是"AABB 须贴合主导几何"的量化依据,不是免费午餐。
 * 影响体壳内(权重>0 但接收点在 AABB 外)boxProject 回退平面方向,混合退化为
 * "主探针校正 + 次探针平面",不劣于现状。
 */

export interface ReflectionProbeBoxSpec {
  /** 探针(cubemap 捕获)中心,世界坐标。 */
  readonly center: ProbeVector3;
  /** 影响体 AABB 半尺寸(视差校正域),各轴 > 0。 */
  readonly halfExtents: ProbeVector3;
  /** 过渡壳厚度:影响体边界向内衰减壳,0 = 边界硬切换。 */
  readonly blendDistance: number;
  /** 影响体外扩半径:AABB 沿各轴向外延伸 influenceRadius 仍参与权重。 */
  readonly influenceRadius: number;
  /** 捕获点相对 center 的偏移(捕获执行器消费;校正数学不使用)。 */
  readonly captureOffset?: ProbeVector3;
  /** 探针代际号(捕获批次),记录用。 */
  readonly generation?: number;
}

export interface PackedReflectionProbeRecord {
  /** row0: center.xyz + blendDistance。 */
  readonly center: ProbeVector3;
  readonly blendDistance: number;
  /** row1: halfExtents.xyz + influenceRadius。 */
  readonly halfExtents: ProbeVector3;
  readonly influenceRadius: number;
  /** row2: captureOffset.xyz + generation。 */
  readonly captureOffset: ProbeVector3;
  readonly generation: number;
}

const MAX_WORLD = 1_000_000_000;
const MAX_OFFSET = 1_000_000;

export function packReflectionProbeRecord(record: ReflectionProbeBoxSpec): ArrayBuffer {
  const center = vector(record.center, "center", -MAX_WORLD, MAX_WORLD);
  const halfExtents = vector(record.halfExtents, "halfExtents", 1e-6, MAX_WORLD);
  const blendDistance = finite(record.blendDistance, "blendDistance", 0, MAX_WORLD);
  const influenceRadius = finite(record.influenceRadius, "influenceRadius", 0, MAX_WORLD);
  const captureOffset = vector(record.captureOffset ?? [0, 0, 0], "captureOffset", -MAX_OFFSET, MAX_OFFSET);
  // f32 精确整数上限(2^24);代际号是记录字段,超出会静默失真,故 fail-closed。
  const generation = finite(record.generation ?? 0, "generation", 0, 16_777_216);
  const values = new Float32Array(DEEP_REFLECTION_PROBE_RECORD_BYTES / 4);
  values.set([...center, blendDistance], 0);
  values.set([...halfExtents, influenceRadius], 4);
  values.set([...captureOffset, generation], 8);
  return values.buffer;
}

/** 测试与宿主调试用:按同一布局解包(不经 GPU)。 */
export function unpackReflectionProbeRecord(buffer: ArrayBuffer): PackedReflectionProbeRecord {
  if (buffer.byteLength !== DEEP_REFLECTION_PROBE_RECORD_BYTES) {
    throw new RangeError(`Probe record must be exactly ${DEEP_REFLECTION_PROBE_RECORD_BYTES} bytes.`);
  }
  const values = new Float32Array(buffer);
  return Object.freeze({
    center: Object.freeze([values[0]!, values[1]!, values[2]!]) as ProbeVector3,
    blendDistance: values[3]!,
    halfExtents: Object.freeze([values[4]!, values[5]!, values[6]!]) as ProbeVector3,
    influenceRadius: values[7]!,
    captureOffset: Object.freeze([values[8]!, values[9]!, values[10]!]) as ProbeVector3,
    generation: values[11]!,
  });
}

export type ReflectionProbeAabbSource = "manual" | "scene-bounds";

export interface ResolvedReflectionProbeBox {
  readonly box: ReflectionProbeBoxSpec;
  readonly source: ReflectionProbeAabbSource;
  /** 自动派生时的收缩比例(手置为 1)。 */
  readonly autoScale: number;
}

export interface ResolveReflectionProbeBoxInput {
  /** 作者手置(优先);center/halfExtents 必填,其余字段可覆盖派生默认。 */
  readonly manual?: { readonly center?: ProbeVector3; readonly halfExtents?: ProbeVector3;
    readonly blendDistance?: number; readonly influenceRadius?: number;
    readonly captureOffset?: ProbeVector3; readonly generation?: number } | null;
  /** 场景包围盒(与 GI clipmap 同来源);manual 完整时可为 null。 */
  readonly sceneBounds: ProbeAabb | null;
  /** 自动派生的盒收缩比例,默认 1(等包围盒);(0,1] 之外非法。 */
  readonly autoScale?: number;
  /** 自动派生时的默认影响体外扩(米),默认 2。 */
  readonly autoInfluenceRadius?: number;
  /** 自动派生时的默认过渡壳(米),默认 1。 */
  readonly autoBlendDistance?: number;
}

/**
 * AABB 来源解析:manual 的 center+halfExtents 齐备即胜出(作者意图);
 * 否则从 sceneBounds 派生;两者皆缺 fail-closed。
 */
export function resolveReflectionProbeBox(input: ResolveReflectionProbeBoxInput): ResolvedReflectionProbeBox {
  const manual = input.manual ?? null;
  if (manual?.center !== undefined && manual?.halfExtents !== undefined) {
    const box: ReflectionProbeBoxSpec = {
      center: manual.center, halfExtents: manual.halfExtents,
      blendDistance: manual.blendDistance ?? 1,
      influenceRadius: manual.influenceRadius ?? 2,
      ...(manual.captureOffset === undefined ? {} : { captureOffset: manual.captureOffset }),
      ...(manual.generation === undefined ? {} : { generation: manual.generation }),
    };
    // 手置也走打包校验(fail-closed),非法值在此暴露而不是在 GPU 上静默发散。
    packReflectionProbeRecord(box);
    return { box, source: "manual", autoScale: 1 };
  }
  const bounds = input.sceneBounds;
  if (!bounds) throw new RangeError(
    "Reflection probe needs a manual box or scene bounds; refusing to invent a parallax domain.");
  const autoScale = input.autoScale ?? 1;
  if (!(autoScale > 0 && autoScale <= 1)) throw new RangeError("Reflection probe autoScale must be in (0, 1].");
  const half: ProbeVector3 = [
    Math.max((bounds.max[0]! - bounds.min[0]!) / 2, 1e-6) * autoScale,
    Math.max((bounds.max[1]! - bounds.min[1]!) / 2, 1e-6) * autoScale,
    Math.max((bounds.max[2]! - bounds.min[2]!) / 2, 1e-6) * autoScale,
  ];
  const center: ProbeVector3 = [
    (bounds.min[0]! + bounds.max[0]!) / 2,
    (bounds.min[1]! + bounds.max[1]!) / 2,
    (bounds.min[2]! + bounds.max[2]!) / 2,
  ];
  const box: ReflectionProbeBoxSpec = {
    center, halfExtents: half,
    blendDistance: input.autoBlendDistance ?? 1,
    influenceRadius: input.autoInfluenceRadius ?? 2,
  };
  packReflectionProbeRecord(box);
  return { box, source: "scene-bounds", autoScale };
}

export interface ReflectionProbeBlendSelection {
  /** 主探针下标(权重最大;全无覆盖时 -1)。 */
  readonly primary: number;
  /** 次探针下标(次大且过阈;无则 undefined)。 */
  readonly secondary?: number;
  /** 归一化后权重(和为 1;全无覆盖时 (0,0))。 */
  readonly weights: readonly [number, number];
}

/**
 * 双探针插值选择:按 influenceWeight 取前二,归一化权重(与 WGSL pairWeights 同式)。
 * N 探针全扫是宿主侧低频操作(每次探针集/位置变更时),片元端只消费两份盒+权重。
 */
export function selectReflectionProbePair(position: ProbeVector3,
  probes: readonly ReflectionProbeBoxSpec[],
  options?: { readonly secondaryCutoff?: number }): ReflectionProbeBlendSelection {
  const cutoff = options?.secondaryCutoff ?? DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF;
  let best = -1, second = -1, bestWeight = 0, secondWeight = 0;
  for (let index = 0; index < probes.length; index++) {
    const weight = reflectionProbeInfluenceWeightCpu(position, probes[index]!);
    if (weight > bestWeight) { second = best; secondWeight = bestWeight; best = index; bestWeight = weight; continue; }
    if (weight > secondWeight) { second = index; secondWeight = weight; }
  }
  const [primaryWeight, secondaryWeight] = reflectionProbePairWeightsCpu(bestWeight, secondWeight, cutoff);
  if (primaryWeight <= 0) return { primary: -1, weights: [0, 0] };
  return { primary: best, ...(second >= 0 && secondaryWeight > 0 ? { secondary: second } : {}),
    weights: [primaryWeight, secondaryWeight] };
}

// ---- 聚合出口:CPU 镜像与量化规范经此再导出(既有 import 路径不变)。 ----

export { reflectionProbeBoxProjectCpu, reflectionProbeInfluenceWeightCpu, reflectionProbePairWeightsCpu,
  type ReflectionProbeBoxProjectResult } from "./reflectionProbeParallaxMath.js";
export { DEEP_REFLECTION_PARALLAX_DEFAULT_VIEWPORT, measureReflectionParallaxCase, roomParallaxCases,
  type ReflectionParallaxCaseInput, type ReflectionParallaxCaseMetrics,
} from "./reflectionProbeParallaxQuantify.js";

/** 供 CPU/GPU 对拍与测试消费的哨兵再导出(避免测试各自 import 生成模块)。 */
export const REFLECTION_PROBE_SENTINELS = Object.freeze({
  outside: DEEP_REFLECTION_PROBE_SENTINEL_OUTSIDE,
  degenerate: DEEP_REFLECTION_PROBE_SENTINEL_DEGENERATE,
  unconstrainedStep: DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP,
} as const);

function vector(value: unknown, path: string, minimum: number, maximum: number): ProbeVector3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== "number"
    || !Number.isFinite(item) || item < minimum || item > maximum)) {
    throw new RangeError(`${path} must be finite XYZ within bounds.`);
  }
  return value as unknown as ProbeVector3;
}
function finite(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${path} is out of bounds.`);
  }
  return value;
}
