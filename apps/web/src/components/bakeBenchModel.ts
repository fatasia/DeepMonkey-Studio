import type { StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";

/**
 * 光照烘焙工作台状态机(纯函数,无 React/GPU 依赖)。
 *
 * 引擎事实(归属 packages/deep-engine/gi,本文件只消费):
 * - 烘焙由 SdfGiProductionRuntime.encodeFrame 在「包场景 revision 变化」帧自动执行
 *   (场景 dirty 一次);引擎没有手动触发 API。apps/web 的间接触发路径 = 任何真实
 *   作者编辑经桥包重布景 bump sceneRevision → 下一帧自动重烘焙。
 * - 面板因此是「观察 + 校验」语义:轮询 sdfGiBakes 计数器推进即视为烘焙发生,
 *   观察窗结束无推进 = 场景自上次烘焙后无变更(「已是最新」),绝不伪造烘焙或进度。
 * - sdfGi 指标经帧循环展开进 FrameMetrics(运行时字段,类型登记属 deep-engine/webgpu,
 *   遥测采样器以窄化接口直通;引擎侧补型后此处可原样替换)。
 */

/** 窄化直通面:FrameMetrics 运行时展开的 sdfGi 指标字段(与 SdfGiMetrics 同名同义)。 */
export interface SdfGiBakeMetrics {
  readonly sdfGiBakes: number;
  readonly sdfGiBakesGpu: number;
  readonly sdfGiBakeCells: number;
  readonly sdfGiProbeCount: number;
  readonly sdfGiProbesUpdated: number;
  readonly sdfGiProbeWindowOffset: number;
  readonly sdfGiSkyTraceDispatches: number;
  readonly sdfGiPublishDispatches: number;
  /** 探针 SH 更新预算(AdaptiveQualityKnobs.ddgiUpdateBudget;缺测 undefined)。 */
  readonly ddgiUpdateBudget: number | undefined;
}

/** 从遥测状态提取最新 sdfGi 指标;未接入(未开启/后端未产出)返回 undefined。 */
export function readSdfGiMetrics(status: StudioQualityTelemetryStatus | undefined): SdfGiBakeMetrics | undefined {
  return status?.latestSdfGi;
}

/** 一次已观测到的烘焙事实(面板侧墙钟 + 引擎计数器快照)。 */
export interface BakeRecord {
  /** 面板观测到计数器推进的墙钟时间(ms,Date.now)。 */
  readonly observedAtMs: number;
  /** 烘焙序号(引擎 sdfGiBakes 累计)。 */
  readonly bakeIndex: number;
  /** 本次为 GPU compute 距离场烘焙(false = CPU 增量回退路径)。 */
  readonly gpuBaked: boolean;
  readonly cells: number;
  readonly probes: number;
}

/** 工作台阶段:gi-disabled(未开启)/ idle(就绪·干净)/ checking(观察窗)/ fresh(新烘焙) / up-to-date(已是最新)。 */
export type BakeBenchPhase =
  | { readonly kind: "gi-disabled" }
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly startedAtMs: number }
  | { readonly kind: "fresh"; readonly record: BakeRecord }
  | { readonly kind: "up-to-date"; readonly checkedAtMs: number };

export interface BakeBenchState {
  readonly phase: BakeBenchPhase;
  /** 最近一次观测到的烘焙(任何阶段下都保留,驱动摘要区)。 */
  readonly lastBake: BakeRecord | undefined;
  /** 上一次轮询看到的 sdfGiBakes 基准(undefined = 尚未见过遥测)。 */
  readonly lastSeenBakes: number | undefined;
}

export const INITIAL_BAKE_BENCH_STATE: BakeBenchState = { phase: { kind: "gi-disabled" }, lastBake: undefined, lastSeenBakes: undefined };

export type BakeBenchEvent =
  /** 每 250ms 遥测轮询:携带当前 sdfGi 指标(undefined = 未接入)。 */
  | { readonly type: "tick"; readonly atMs: number; readonly metrics: SdfGiBakeMetrics | undefined }
  /** 用户点击「烘焙光照」:开启观察窗。 */
  | { readonly type: "check-started"; readonly atMs: number }
  /** 观察窗超时仍无计数推进。 */
  | { readonly type: "check-timeout"; readonly atMs: number }
  /** 面板重置回观察态(fresh/up-to-date 是一次性提示,下一次 tick 归位)。 */
  | { readonly type: "dismiss" };

/** 观察窗时长:6 × 250ms 轮询,覆盖数帧内的自动烘焙(GPU 稳态 4.4ms,大场景展平也在此窗内可观测)。 */
export const BAKE_CHECK_WINDOW_MS = 1_500;

export function reduceBakeBench(state: BakeBenchState, event: BakeBenchEvent): BakeBenchState {
  switch (event.type) {
    case "tick": {
      if (event.metrics === undefined) {
        // 未接入是强事实:任何阶段下遥测消失(后端切走)都回落「未开启」。
        return state.phase.kind === "gi-disabled" ? state
          : { phase: { kind: "gi-disabled" }, lastBake: state.lastBake, lastSeenBakes: undefined };
      }
      const lastSeen = state.lastSeenBakes;
      const bakes = event.metrics.sdfGiBakes;
      // 计数回退 = 后端重建(新 SdfGiProductionRuntime 从 1 重新计数):旧运行时的
      // 烘焙记录不再代表当前产物,如实清空并回就绪,不把旧结论带进新运行时。
      if (lastSeen !== undefined && bakes < lastSeen) {
        return { phase: { kind: "idle" }, lastBake: undefined, lastSeenBakes: bakes };
      }
      if (lastSeen !== undefined && bakes > lastSeen) {
        const record: BakeRecord = { observedAtMs: event.atMs, bakeIndex: bakes,
          gpuBaked: event.metrics.sdfGiBakesGpu >= bakes, cells: event.metrics.sdfGiBakeCells,
          probes: event.metrics.sdfGiProbeCount };
        return { phase: { kind: "fresh", record }, lastBake: record, lastSeenBakes: bakes };
      }
      const nextSeen = lastSeen ?? bakes;
      // 遥测恢复(开启 sdf-gi / 后端重建):离开「未开启」回就绪态。
      if (state.phase.kind === "gi-disabled") {
        return { phase: { kind: "idle" }, lastBake: state.lastBake, lastSeenBakes: nextSeen };
      }
      // 观察窗内计数未推进是「干净」的证据;fresh / up-to-date 是结果提示,驻留到
      // 下一次事件(新烘焙→fresh、再次检查→checking、面板切换→dismiss),不被
      // 例行 tick 冲掉(否则 250ms 内闪没,操作者读不到结论)。
      if (state.phase.kind === "checking") return { ...state, lastSeenBakes: nextSeen };
      return { ...state, lastSeenBakes: nextSeen };
    }
    case "check-started":
      if (state.phase.kind === "gi-disabled") return state;
      return { ...state, phase: { kind: "checking", startedAtMs: event.atMs } };
    case "check-timeout":
      if (state.phase.kind !== "checking") return state;
      return { ...state, phase: { kind: "up-to-date", checkedAtMs: event.atMs } };
    case "dismiss":
      if (state.phase.kind === "gi-disabled" || state.phase.kind === "checking") return state;
      return { ...state, phase: { kind: "idle" } };
  }
}

/** GPU 烘焙占比口径(如实:CPU 回退帧 = sdfGiBakes − sdfGiBakesGpu)。 */
export function gpuBakeShare(metrics: SdfGiBakeMetrics): { gpu: number; cpuFallback: number } {
  return { gpu: metrics.sdfGiBakesGpu, cpuFallback: Math.max(0, metrics.sdfGiBakes - metrics.sdfGiBakesGpu) };
}
