import type { ProbeVector3 } from "../lighting/probeClipmapPlan.js";
import type { IrradianceProbeRecord } from "../lighting/probeClipmapSampling.js";
import { projectSkyVisibilitySh, type SkyVisibilitySh } from "./probeSkyVisibilitySh.js";

/**
 * Brief-GI M1:探针 SH 更新入口 —— probeClipmap 的场更新接受 ①天光遮蔽(场景 SDF 圆锥
 * 追踪的可见度)②SSGDI 输入(屏幕空间 GI 贡献),经时域滤波 α≈0.1 写回探针辐照记录。
 *
 * == 语义 ==
 * - 目标场 = 天光可见度加权的方向天空均值(Σ vis·sky / N;与捕获均值同式同序)
 *   + SSGDI 叠加项(在场时逐探针相加);
 * - 可选静态 1 bounce 预计算:目标场再叠加 `bounceAlbedo × 目标场`(均匀反照率的
 *   一阶反弹近似;SDF 世界不携带逐面反照率,该近似如实声明),能量哨兵约束
 *   bounce 后总能量 ≤ 基线 ×2(ρ≤1 的物理上界,+1% 余量),超限 fail-closed 回基线;
 * - 时域滤波:`out = lerp(prev, target, α)`,缺省 α = 0.1;prev 缺失 = 首帧直取 target;
 * - 埋入探针(validity 0)不更新(泄露哨兵:墙内探针不被天光场复活),记录原样透传;
 * - **F5 合同不动**:record 的 `directionalVisibilitySh`(words[12..23] 捕获 SH)原样
 *   透传,本更新绝不写该块——白炉 gate≡1 逐位负控与 F5-L5 三区哨兵的输入面零变化;
 *   `occlusionFloor` 写可见度均值 c0(与 probeOcclusionEstimate.visibilityFloor 同域)。
 *
 * == 白炉稳定性 ==
 * 均匀天空(全方向同值 E)+ 全开可见度(v ≡ 1)时 target ≡ E;稳态场(prev ≡ E)在
 * 任意 α 下逐位不动(lerp 不动点)——昼夜循环逐帧差只来自天空物理变化,滤波器自身
 * 不注入能量或闪烁。
 */

/** 探针场时域滤波缺省系数(Brief-GI M1:α≈0.1)。 */
export const DEEP_GI_PROBE_TEMPORAL_ALPHA = 0.1;
/** α 解析下限(>0 保收敛方向;再低等价关闭,直接给 0.1)。 */
export const DEEP_GI_PROBE_TEMPORAL_ALPHA_MIN = 0.01;

/** α 解析(fail-closed):非法/缺省回 0.1,渲染循环不因脏配置中断。 */
export function resolveDeepGiTemporalAlpha(value?: number): number {
  if (value === undefined) return DEEP_GI_PROBE_TEMPORAL_ALPHA;
  if (!Number.isFinite(value) || value < DEEP_GI_PROBE_TEMPORAL_ALPHA_MIN || value > 1) {
    return DEEP_GI_PROBE_TEMPORAL_ALPHA;
  }
  return value;
}

export interface ProbeShUpdateInput {
  /** 上一帧探针记录(同序;可含 undefined = 新探针首帧)。 */
  readonly previous: readonly (IrradianceProbeRecord | undefined)[];
  /** 探针位置(与 previous 同序;埋入判定与报告用)。 */
  readonly positions: readonly ProbeVector3[];
  /** 天光方向集(Fibonacci CPU 权威,与可见度/天空辐射逐下标对齐)。 */
  readonly directions: readonly ProbeVector3[];
  /** 每探针逐方向天光可见度(traceSdfSkyVisibility 输出切片,长度 = N×directions)。 */
  readonly visibilities: ArrayLike<number>;
  /** 每方向天空辐射(线性 RGB;每帧按方向缓存一次,不随探针重复采样)。 */
  readonly directionSkyRadiance: readonly ProbeVector3[];
  /** SSGDI 输入(可选):每探针屏幕空间 GI 辐照;undefined 探针跳过该项。 */
  readonly ssgdi?: readonly (ProbeVector3 | undefined)[];
  /** 静态 1 bounce 均匀反照率(可选,线性 RGB ∈[0,1]);缺省关。 */
  readonly bounceAlbedo?: ProbeVector3;
  /** 时域滤波 α;缺省/非法经 resolveDeepGiTemporalAlpha 回 0.1。 */
  readonly alpha?: number;
  /**
   * 逐探针几何统计 [meanDistance, distanceVariance](捕获侧口径,同
   * probeOcclusionRayExtension/probeRadianceKernel 的命中距离统计)。缺省沿用
   * previous 或有界缺省——**采样链的 Chebyshev 可见性按这对值判遮挡**,缺失会让
   * 记录被整列拒绝(实测踩坑:meanDistance=tMax、variance=0 → 全 fallback)。
   */
  readonly geometryStats?: readonly (readonly [number, number])[];
}

export interface ProbeShUpdateResult {
  /** 更新后的探针记录(输入不变异;F5 words[12..23] 原样透传)。 */
  readonly records: readonly IrradianceProbeRecord[];
  /** 每探针天光可见度 L1 SH(投影产物,时域滤波后)。 */
  readonly skyVisibilitySh: readonly (SkyVisibilitySh | undefined)[];
  readonly alpha: number;
  /** 静态 bounce 哨兵触发数(fail-closed 回基线的探针数;0 = 正常)。 */
  readonly bounceSentinelTrips: number;
  /** 目标场能量之和(bounce 后;哨兵证据链)。 */
  readonly targetEnergy: number;
}

/** 单探针切片的可见度子数组视图(零拷贝下标换算,不复制)。 */
export function probeVisibilitySlice(visibilities: ArrayLike<number>, probeIndex: number,
  directionCount: number): number[] {
  return Array.from({ length: directionCount },
    (_, index) => visibilities[probeIndex * directionCount + index]!);
}

/**
 * 探针 SH 更新(天光遮蔽 + SSGDI 输入 + 时域滤波)。确定性:无 RNG,同输入逐位同输出;
 * 输入数组不变异。
 */
export function updateProbeShWithSdfGi(input: ProbeShUpdateInput): ProbeShUpdateResult {
  if (input.previous.length !== input.positions.length) {
    throw new RangeError("Probe SH update requires one previous record per probe position.");
  }
  const directionCount = input.directions.length;
  if (directionCount === 0 || input.directionSkyRadiance.length !== directionCount
    || input.visibilities.length !== input.positions.length * directionCount) {
    throw new RangeError("Probe SH update direction/visibility arrays are misaligned.");
  }
  if (!input.directionSkyRadiance.every(radiance => radiance.length === 3
    && radiance.every(Number.isFinite))) {
    throw new RangeError("Probe SH update sky radiance must be finite RGB.");
  }
  const alpha = resolveDeepGiTemporalAlpha(input.alpha);
  const skyVisibilitySh: (SkyVisibilitySh | undefined)[] = [];
  const records: IrradianceProbeRecord[] = [];
  let bounceSentinelTrips = 0, targetEnergy = 0;
  for (let probe = 0; probe < input.positions.length; probe++) {
    const previous = input.previous[probe];
    if (previous !== undefined && (typeof previous !== "object" || previous === null
      || previous.irradiance?.length !== 3 || !Number.isFinite(previous.validity))) {
      throw new TypeError("Probe SH update previous records must be IrradianceProbeRecord shapes.");
    }
    // 埋入探针(validity 0):不更新,原样透传(泄露哨兵)。
    if (previous !== undefined && previous.validity === 0) {
      records.push(previous);
      skyVisibilitySh.push(undefined);
      continue;
    }
    const slice = probeVisibilitySlice(input.visibilities, probe, directionCount);
    const sh = projectSkyVisibilitySh(slice, input.directions);
    const target = targetIrradiance(slice, input.directionSkyRadiance, input.ssgdi?.[probe]);
    const guarded = applyStaticBounce(target, input.bounceAlbedo);
    if (guarded.tripped) bounceSentinelTrips += 1;
    const finalTarget = guarded.radiance;
    targetEnergy += Math.hypot(finalTarget[0], finalTarget[1], finalTarget[2]);
    const blended: ProbeVector3 = previous === undefined ? finalTarget : [
      previous.irradiance[0] + (finalTarget[0] - previous.irradiance[0]) * alpha,
      previous.irradiance[1] + (finalTarget[1] - previous.irradiance[1]) * alpha,
      previous.irradiance[2] + (finalTarget[2] - previous.irradiance[2]) * alpha,
    ];
    records.push({
      irradiance: blended,
      validity: previous?.validity ?? 1,
      meanDistance: input.geometryStats?.[probe]?.[0] ?? previous?.meanDistance ?? 1_000,
      distanceVariance: input.geometryStats?.[probe]?.[1] ?? previous?.distanceVariance ?? 0,
      occlusionFloor: sh[0]!,
      ...(previous?.directionalVisibilitySh
        ? { directionalVisibilitySh: previous.directionalVisibilitySh } : {}),
    });
    skyVisibilitySh.push(sh);
  }
  return { records, skyVisibilitySh, alpha, bounceSentinelTrips,
    targetEnergy: Math.fround(targetEnergy) };
}

/** 目标场:天光可见度加权的方向均值 + SSGDI 叠加(与捕获均值同式同序)。 */
function targetIrradiance(slice: readonly number[], skyRadiance: readonly ProbeVector3[],
  ssgdi: ProbeVector3 | undefined): ProbeVector3 {
  let r = 0, g = 0, b = 0;
  for (let index = 0; index < slice.length; index++) {
    const radiance = skyRadiance[index]!;
    r += slice[index]! * radiance[0]!;
    g += slice[index]! * radiance[1]!;
    b += slice[index]! * radiance[2]!;
  }
  const count = slice.length;
  const base: ProbeVector3 = [r / count, g / count, b / count];
  if (ssgdi === undefined) return base;
  if (ssgdi.length !== 3 || !ssgdi.every(Number.isFinite)) {
    throw new RangeError("Probe SH update SSGDI input must be finite RGB.");
  }
  return [base[0] + ssgdi[0], base[1] + ssgdi[1], base[2] + ssgdi[2]];
}

const BOUNCE_ENERGY_LIMIT = 2.01;

/** 静态 1 bounce(均匀反照率近似)+ 能量哨兵(ρ≤1 物理上界 ×2,+1% 余量)。 */
function applyStaticBounce(target: ProbeVector3, bounceAlbedo: ProbeVector3 | undefined):
  { radiance: ProbeVector3; tripped: boolean } {
  if (bounceAlbedo === undefined) return { radiance: target, tripped: false };
  if (bounceAlbedo.length !== 3 || !bounceAlbedo.every(value => Number.isFinite(value)
    && value >= 0 && value <= 1)) {
    throw new RangeError("Probe SH update bounceAlbedo must be RGB in [0, 1].");
  }
  const bounced: ProbeVector3 = [
    target[0] * (1 + bounceAlbedo[0]!), target[1] * (1 + bounceAlbedo[1]!),
    target[2] * (1 + bounceAlbedo[2]!)];
  const baseline = Math.hypot(target[0], target[1], target[2]);
  const energy = Math.hypot(bounced[0], bounced[1], bounced[2]);
  // 防线纵深:反照率合同已保证 bounced ≤ 2× 基线,哨兵兜底非有限值/未来口径漂移。
  if (!Number.isFinite(energy) || energy > baseline * BOUNCE_ENERGY_LIMIT) {
    return { radiance: target, tripped: true };
  }
  return { radiance: bounced, tripped: false };
}
