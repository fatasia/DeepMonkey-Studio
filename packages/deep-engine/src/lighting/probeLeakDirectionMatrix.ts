import type { ProbeVector3 } from "./probeClipmapPlan.js";

// F5 漏光 × 方向数矩阵：污染/漏光指标的**语义单一来源**。
// CPU 单测（probeLeakDirectionMatrix.test.ts）与真机 GPU 联测脚本
// （scripts/f5ProbeLeakDirectionMatrix.mts）共用本模块的全部口径定义，
// 保证「32 方向前后漏光率/污染指标对照」在两条证据链上是同一把尺子。
//
// == 背景（T02/G3-S1 证据锚点） ==
// - 历史污染测量口径分裂：CPU slab（fib8，0.0623→0.0002）、GPU 存储记录
//   （fib16 注入对照 0.0582→0.000214）、GPU 生产纹理（fib32 rejected 0.000214）——
//   没有任何一组**同口径**的 8/16/32 对照。本模块补齐该矩阵的指标定义。
// - 方向数只影响捕获侧（probeRadianceKernel 的 Fibonacci 射线数）；采样侧
//   （deepGiSample / deepGiSampleTexture）逐探针存一个 irradiance，不含方向维，
//   因此「着色采样对齐」在结构上是恒等——该事实由本模块的采样接口假设承载。

/** 参与对照的方向档（8 = producer 独立默认、16 = 门默认档、32 = 门高档/产品启用）。 */
export const LEAK_MATRIX_DIRECTION_COUNTS = Object.freeze([8, 16, 32] as const);

/** 策略后污染绝对门（T02/G3-S1 证据口径 meanPolicyError < 0.005，红通道线性辐照度）。 */
export const LEAK_POLLUTION_GATE = 0.005;
/** 「若无墙内策略」反事实污染的在场门：埋入探针是亮源，任一方向档都不得低于此值。 */
export const LEAK_PREFIX_POLLUTION_FLOOR = 0.03;
/** 策略前后污染压缩倍数门：≥ 一个数量级（与 probeWallLeak 既有断言同宽）。 */
export const LEAK_REDUCTION_FACTOR_GATE = 10;

/** 墙区接收点：位置 + 法线 + 是否朝墙（朝墙 = 三线性模板含埋入列的被污染方向）。 */
export interface WallLeakReceiver {
  readonly position: ProbeVector3;
  readonly normal: ProbeVector3;
  readonly facesWall: boolean;
}

/**
 * 参考场景墙区接收点集：x∈{4.4,4.8} × z∈{1.5,2,4,4.5}，每点 −x（朝墙）与 +x（背墙）
 * 各一，共 16 点。偶数下标 = 朝墙——与 t02 联测脚本 `filter(index % 2 === 0)` 的
 * 布局合同逐位一致，两侧证据可直接对读。
 */
export function buildWallLeakReceivers(): readonly WallLeakReceiver[] {
  const receivers: WallLeakReceiver[] = [];
  for (const x of [4.4, 4.8]) for (const z of [1.5, 2, 4, 4.5]) {
    receivers.push({ position: [x, 1, z], normal: [-1, 0, 0], facesWall: true });
    receivers.push({ position: [x, 1, z], normal: [1, 0, 0], facesWall: false });
  }
  return receivers;
}

/** 接收点 → 参与误差对照的探针格点下标（位置取整匹配；找不到即合同错误）。 */
export function probeIndexForReceiver(receiver: WallLeakReceiver,
  positions: readonly (readonly number[])[]): number {
  const index = positions.findIndex(position => position[0] === Math.round(receiver.position[0]!)
    && position[1] === receiver.position[1]! && position[2] === Math.round(receiver.position[2]!));
  if (index < 0) throw new Error(`Wall receiver ${JSON.stringify(receiver.position)} has no matching grid probe.`);
  return index;
}

/**
 * 亮室尺度：稳定（非埋入）探针引擎辐照**红通道**均值。漏光率 = 污染 / 本尺度，
 * 把绝对污染归一成「占亮室能量的比例」后跨方向档、跨场景可比。
 */
export function referenceLitScaleIR(stableIrradianceR: readonly number[]): number {
  if (stableIrradianceR.length === 0) throw new Error("Lit scale needs at least one stable probe.");
  const total = stableIrradianceR.reduce((sum, value) => sum + value, 0);
  const scale = total / stableIrradianceR.length;
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new Error(`Lit scale must be positive and finite, got ${scale}.`);
  }
  return scale;
}

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** 朝墙接收点污染指标：|采样红通道 − shadowed 真值红通道| 的均值（T02 证据口径）。 */
export function meanFacingWallRedError(sampled: readonly ProbeVector3[],
  truthRedByReceiver: readonly number[], receivers: readonly WallLeakReceiver[]): number {
  if (sampled.length !== receivers.length || truthRedByReceiver.length !== receivers.length) {
    throw new Error("Sampled values, truth and receivers must be index-aligned.");
  }
  const facingWallErrors = receivers.map((receiver, index) => receiver.facesWall
    ? Math.abs(sampled[index]![0]! - truthRedByReceiver[index]!) : undefined)
    .filter((value): value is number => value !== undefined);
  if (facingWallErrors.length === 0) throw new Error("Receiver set has no facing-wall point.");
  return meanOf(facingWallErrors);
}

/** 背墙接收点最大通道差：法线权重应已把埋入探针清零，策略不得改变背墙结果。
 * 只对 `facesWall === false` 的接收点做差——朝墙点的两策略差异是对照的本体，不算扰动。 */
export function facingAwayMaxDelta(left: readonly ProbeVector3[], right: readonly ProbeVector3[],
  receivers: readonly WallLeakReceiver[]): number {
  if (left.length !== right.length || left.length !== receivers.length) {
    throw new Error("Facing-away delta needs aligned fields and receivers.");
  }
  const away = receivers.flatMap((receiver, index) => receiver.facesWall ? [] : [index]);
  if (away.length === 0) throw new Error("Receiver set has no facing-away point.");
  return Math.max(...away.flatMap(index =>
    [0, 1, 2].map(axis => Math.abs(left[index]![axis]! - right[index]![axis]!))));
}

/** 单方向档的漏光对照行：反事实（无墙内策略）vs 策略现实（生产语义）。 */
export interface LeakMatrixRow {
  readonly directionCount: number;
  /** 反事实污染（埋入亮源 + validity=1 + 盲距离进入采样）——「若无策略」的漏光水位。 */
  readonly preFixMeanError: number;
  /** 策略现实污染（生产语义：埋入 RGB 清零 + validity=0 + 真实距离统计）。 */
  readonly policyMeanError: number;
  readonly preFixLeakRate: number;
  readonly policyLeakRate: number;
  /** 污染压缩倍数 = preFix / policy（policy 为 0 时取上界哨兵）。 */
  readonly reductionFactor: number;
  /** 背墙接收点两策略最大通道差（≈0 = 法线权重已天然拒绝）。 */
  readonly facingAwayMaxDelta: number;
}

export interface LeakMatrixRowInput {
  readonly directionCount: number;
  readonly preFixSampled: readonly ProbeVector3[];
  readonly policySampled: readonly ProbeVector3[];
  readonly truthRedByReceiver: readonly number[];
  readonly litScale: number;
  readonly receivers: readonly WallLeakReceiver[];
}

/** 由两侧采样场组装对照行；全部指标经本函数产出，两条证据链不得各算各的。 */
export function assembleLeakMatrixRow(input: LeakMatrixRowInput): LeakMatrixRow {
  const preFixMeanError = meanFacingWallRedError(
    input.preFixSampled, input.truthRedByReceiver, input.receivers);
  const policyMeanError = meanFacingWallRedError(
    input.policySampled, input.truthRedByReceiver, input.receivers);
  const reductionFactor = policyMeanError > 0 ? preFixMeanError / policyMeanError
    : preFixMeanError > 0 ? Number.POSITIVE_INFINITY : 1;
  return Object.freeze({
    directionCount: input.directionCount,
    preFixMeanError, policyMeanError,
    preFixLeakRate: preFixMeanError / input.litScale,
    policyLeakRate: policyMeanError / input.litScale,
    reductionFactor,
    facingAwayMaxDelta: facingAwayMaxDelta(
      input.preFixSampled, input.policySampled, input.receivers),
  });
}

/** 矩阵总评：每条布尔都是真机/单测门禁直接消费的判据，数值行进证据 JSON。 */
export interface LeakMatrixSummary {
  readonly rows: readonly LeakMatrixRow[];
  /** 任一方向档下，埋入亮源反事实污染都在场（> FLOOR）——污染源不随方向数消失。 */
  readonly preFixPollutionAtAllCounts: boolean;
  /** 任一方向档下，策略现实污染都在绝对门内（≤ GATE）。 */
  readonly policyWithinGateAtAllCounts: boolean;
  /** 任一方向档下，策略压缩 ≥ 一个数量级。 */
  readonly reductionAtEveryCount: boolean;
  /** 背墙接收点零扰动（≤ 1e-6）。 */
  readonly facingAwayUntouched: boolean;
  readonly maxPolicyLeakRate: number;
  readonly maxPolicyMeanError: number;
}

/** 8/16/32 对照矩阵的总评判定；三条污染判据全真才算「漏光策略方向档鲁棒」。 */
export function summarizeLeakMatrix(rows: readonly LeakMatrixRow[]): LeakMatrixSummary {
  const ordered = [...rows].sort((left, right) => left.directionCount - right.directionCount);
  return Object.freeze({
    rows: Object.freeze(ordered),
    preFixPollutionAtAllCounts: ordered.every(row => row.preFixMeanError > LEAK_PREFIX_POLLUTION_FLOOR),
    policyWithinGateAtAllCounts: ordered.every(row => row.policyMeanError <= LEAK_POLLUTION_GATE),
    reductionAtEveryCount: ordered.every(row => row.reductionFactor >= LEAK_REDUCTION_FACTOR_GATE),
    facingAwayUntouched: ordered.every(row => row.facingAwayMaxDelta <= 1e-6),
    maxPolicyLeakRate: Math.max(...ordered.map(row => row.policyLeakRate)),
    maxPolicyMeanError: Math.max(...ordered.map(row => row.policyMeanError)),
  });
}
