import type { PbrPassTimingEntry } from "@bim-studio/deep-engine/webgpu";

/**
 * 六引擎对标 P2「Profiler 泳道/帧图面板」的纯数据模型。
 *
 * 数据单源 = 既有披露面,不新增引擎侧采集:
 * - 逐 pass GPU 计时:T25 桥 `readStudioQualityTelemetry().latestPassTimings`
 *   (即 FrameMetrics.gpuPassTimings,读回滞后 1-2 帧,实测帧号在 `frame`);
 * - 帧时间线:CpuSubmitMs(FrameMetrics.cpuSubmitMs)与 GPU 全帧跨度
 *   (PbrFramePassTimings.milliseconds);
 * - rendererRebuilds 账目:A2 重建周期台账(FrameMetrics.rendererRebuilds.total,
 *   单调计数,进程级 LEDGER_LIMIT=16,面板只消费 total 增量)。
 *
 * 采样纪律:面板开启时以 rAF 读取上述只读快照并落环形缓冲;面板关闭/折叠即停,
 * 帧循环零负担(验证口径「面板开销≤0.5ms」由"不进帧循环"构造性满足)。
 */

/** 一帧已实测的泳道样本(全部字段来自既有只读披露,不做推断)。 */
export interface ProfilerSwimlaneSample {
  /** GPU 计时实测帧号(monotonic;滞后于当前帧 1-2 帧)。 */
  readonly frame: number;
  /** 实测 pass(passId→ms),按帧图计划顺序。 */
  readonly passes: readonly PbrPassTimingEntry[];
  /** GPU 全帧跨度(首 begin→末 end marker,含未计时缝隙)。 */
  readonly gpuSpanMs?: number;
  /** CPU 提交毫秒;仅当 Deep 帧号与实测帧号对齐时携带,不对齐保持 undefined。 */
  readonly cpuSubmitMs?: number;
  readonly measuredPassCount?: number;
  readonly requestedPassCount?: number;
  /** A2 重建台账累计计数;仅当 Deep 帧号与实测帧号对齐时携带。 */
  readonly rebuildTotal?: number;
}

export interface ProfilerSwimlaneCollectorOptions {
  /** 环形缓冲容量(保留最近 N 个实测帧),收敛区间 [8, 240]。 */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 48;
const MIN_CAPACITY = 8;
const MAX_CAPACITY = 240;

/** 实测帧环形缓冲:按帧号单调去重(乱序/迟到样本丢弃,不回填)。 */
export class ProfilerSwimlaneCollector {
  readonly #capacity: number;
  readonly #samples: ProfilerSwimlaneSample[] = [];
  #lastFrame = Number.NEGATIVE_INFINITY;

  constructor(options: ProfilerSwimlaneCollectorOptions = {}) {
    const requested = options.capacity ?? DEFAULT_CAPACITY;
    this.#capacity = Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, Math.round(requested)));
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#samples.length;
  }

  get lastFrame(): number {
    return this.#lastFrame;
  }

  /** 落一条样本;返回是否被接受(帧号非有限/不大于上一帧 = 拒绝)。 */
  push(sample: ProfilerSwimlaneSample): boolean {
    if (!Number.isFinite(sample.frame) || sample.frame <= this.#lastFrame) return false;
    const passes = sample.passes.filter(entry =>
      typeof entry.passId === "string" && entry.passId.length > 0
      && Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
    this.#samples.push(Object.freeze({
      ...sample,
      passes: Object.freeze(passes),
    }));
    if (this.#samples.length > this.#capacity) this.#samples.shift();
    this.#lastFrame = sample.frame;
    return true;
  }

  /** 只读快照(已按时间序,最旧在前)。 */
  snapshot(): readonly ProfilerSwimlaneSample[] {
    return this.#samples;
  }

  clear(): void {
    this.#samples.length = 0;
    this.#lastFrame = Number.NEGATIVE_INFINITY;
  }
}

export interface ProfilerSwimlaneLane {
  readonly passId: string;
  /** 与帧列对齐的耗时数组;undefined = 该帧此 pass 未实测(不伪零)。 */
  readonly values: readonly (number | undefined)[];
  readonly totalMs: number;
  readonly peakMs: number;
}

export interface ProfilerSwimlaneMarker {
  /** 增量发生帧的实测帧号。 */
  readonly frame: number;
  readonly fromTotal: number;
  readonly toTotal: number;
}

export interface ProfilerSwimlaneRow {
  readonly values: readonly (number | undefined)[];
  readonly totalMs: number;
  readonly peakMs: number;
}

export interface ProfilerSwimlaneView {
  readonly frames: readonly ProfilerSwimlaneSample[];
  /** 泳道行 = pass,按窗口总耗时降序,截到 maxLanes。 */
  readonly lanes: readonly ProfilerSwimlaneLane[];
  /** 未列入泳道的 pass 种类数(诚实披露,不静默丢弃)。 */
  readonly omittedPassCount: number;
  readonly gpuSpan: ProfilerSwimlaneRow;
  readonly cpuSubmit: ProfilerSwimlaneRow;
  /** 重建增量标记(帧列对齐;无增量的帧为 undefined)。 */
  readonly rebuildMarks: readonly (ProfilerSwimlaneMarker | undefined)[];
  readonly rebuildIncrementCount: number;
  /** 窗口内单帧最贵 pass(验证口径:能定位最贵 pass)。 */
  readonly mostExpensive: { readonly passId: string; readonly durationMs: number; readonly frame: number } | undefined;
  /** 全部行共用的归一化上限(全局可比,Unity Profiler 口径)。 */
  readonly scaleMaxMs: number;
}

export interface ProfilerSwimlaneViewOptions {
  readonly maxLanes?: number;
}

const DEFAULT_MAX_LANES = 10;
const MIN_LANES = 1;
const MAX_LANES = 24;

function buildRow(values: (number | undefined)[]): ProfilerSwimlaneRow {
  let totalMs = 0;
  let peakMs = 0;
  for (const value of values) {
    if (value === undefined) continue;
    totalMs += value;
    if (value > peakMs) peakMs = value;
  }
  return { values, totalMs, peakMs };
}

/**
 * 由环形缓冲样本构建泳道视图:行=pass(窗口总耗时降序,截 maxLanes),
 * 另含 GPU 跨度行 / CPU 提交行 / 重建增量标记;全表共用一个归一化上限。
 * 空样本列表返回空视图(frames=[]),消费方渲染空态。
 */
export function buildSwimlaneView(
  samples: readonly ProfilerSwimlaneSample[],
  options: ProfilerSwimlaneViewOptions = {},
): ProfilerSwimlaneView {
  const maxLanes = Math.min(MAX_LANES, Math.max(MIN_LANES, Math.round(options.maxLanes ?? DEFAULT_MAX_LANES)));

  const gpuValues: (number | undefined)[] = [];
  const cpuValues: (number | undefined)[] = [];
  const rebuildMarks: (ProfilerSwimlaneMarker | undefined)[] = [];
  let rebuildIncrementCount = 0;
  let mostExpensive: ProfilerSwimlaneView["mostExpensive"];
  // 最近一帧已对齐的台账累计值:重建稀疏,允许中间帧未对齐(缺 rebuildTotal),仍可对账增量。
  let lastKnownRebuildTotal: number | undefined;

  const totalsByPass = new Map<string, number>();
  const firstSeenOrder: string[] = [];
  const laneValues = new Map<string, (number | undefined)[]>();

  samples.forEach((sample, index) => {
    gpuValues.push(Number.isFinite(sample.gpuSpanMs) ? sample.gpuSpanMs : undefined);
    cpuValues.push(Number.isFinite(sample.cpuSubmitMs) ? sample.cpuSubmitMs : undefined);

    const seen = new Set<string>();
    for (const entry of sample.passes) {
      seen.add(entry.passId);
      if (!laneValues.has(entry.passId)) {
        firstSeenOrder.push(entry.passId);
        laneValues.set(entry.passId, new Array(samples.length).fill(undefined));
      }
      laneValues.get(entry.passId)![index] = entry.durationMs;
      totalsByPass.set(entry.passId, (totalsByPass.get(entry.passId) ?? 0) + entry.durationMs);
      if (!mostExpensive || entry.durationMs > mostExpensive.durationMs) {
        mostExpensive = { passId: entry.passId, durationMs: entry.durationMs, frame: sample.frame };
      }
    }
    // pass 缺测帧的已见 pass 保持 undefined(诚实缺测),不回填零。
    void seen;

    if (sample.rebuildTotal !== undefined) {
      if (lastKnownRebuildTotal !== undefined && sample.rebuildTotal > lastKnownRebuildTotal) {
        rebuildMarks.push({ frame: sample.frame, fromTotal: lastKnownRebuildTotal, toTotal: sample.rebuildTotal });
        rebuildIncrementCount += 1;
      } else {
        rebuildMarks.push(undefined);
      }
      lastKnownRebuildTotal = sample.rebuildTotal;
    } else {
      rebuildMarks.push(undefined);
    }
  });

  const ranked = [...firstSeenOrder].sort((left, right) =>
    (totalsByPass.get(right) ?? 0) - (totalsByPass.get(left) ?? 0) || left.localeCompare(right));
  const lanePassIds = ranked.slice(0, maxLanes);

  const lanes = lanePassIds.map(passId => {
    const row = buildRow(laneValues.get(passId)!);
    return { passId, ...row };
  });
  const gpuSpan = buildRow(gpuValues);
  const cpuSubmit = buildRow(cpuValues);

  let scaleMaxMs = 0;
  for (const row of [gpuSpan, cpuSubmit, ...lanes]) {
    if (row.peakMs > scaleMaxMs) scaleMaxMs = row.peakMs;
  }

  return {
    frames: samples,
    lanes,
    omittedPassCount: Math.max(0, ranked.length - lanePassIds.length),
    gpuSpan,
    cpuSubmit,
    rebuildMarks,
    rebuildIncrementCount,
    mostExpensive,
    scaleMaxMs,
  };
}
