import type { FrameMetrics } from "./pbrRendererTypes.js";

/**
 * A2 内存专项(刀2):重建周期账目。
 *
 * 每次 PbrRenderer.dispose 落一条「该实例释放了什么」的估算(输入全部来自既有只读
 * 快照:DeviceResourceMemory、transient 池统计、C26 编译清单);FrameMetrics.rendererRebuilds
 * 披露本实例序号/累计重建数/最近一条,让 backend 切换风暴(release-soak 实测 39 次/11min)
 * 的每次增量可对账,为后续水位门提供抓手。分配侧已有 FrameMetrics.deviceResourceMemory
 * 逐帧快照,这里补齐释放侧,两侧相减即单周期净增量。
 *
 * 进程级有界台账:仅保留最近 LEDGER_LIMIT 条,total 单调计数含已逐出条目;
 * 无任何全局渲染循环或跨实例 GPU 对象共享(与 DeviceSession 归属边界一致)。
 */

export interface RendererRebuildAccountingEntry {
  /** 重建序号(0 起,单调递增;第 n 次 dispose 记 index=n)。 */
  readonly index: number;
  /** dispose 时刻(monotonic,performance.now 口径;测试可注入)。 */
  readonly atMs: number;
  /** DeviceSession 托管 GPU 资源字节估算(dispose 时点 = 本实例当时持有量)。 */
  readonly releasedEstimateBytes: number;
  readonly bufferBytes: number;
  readonly textureBytes: number;
  /** 本实例 transient 池累计分配字节与驻留峰值(池统计口径,不与会话口径相加)。 */
  readonly transientAllocatedBytes: number;
  readonly transientPeakResidentBytes: number;
  /** 本实例真实创建的管线编译条数(C26 记账;缓存命中不计)。 */
  readonly pipelineCompiles: number;
}

const LEDGER_LIMIT = 16;
const ledger: RendererRebuildAccountingEntry[] = [];
let rebuildCounter = 0;

/** 构造期领取本实例序号:当前已完成重建数即本实例是第几个继任者。 */
export function currentRendererRebuildOrdinal(): number { return rebuildCounter; }

/** dispose 时点入账;幂等性由调用方(PbrRenderer.dispose 单次执行)保证。 */
export function recordRendererRebuild(entry: Omit<RendererRebuildAccountingEntry, "index">): RendererRebuildAccountingEntry {
  const recorded: RendererRebuildAccountingEntry = Object.freeze({ ...entry, index: rebuildCounter++ });
  ledger.push(recorded);
  if (ledger.length > LEDGER_LIMIT) ledger.shift();
  return recorded;
}

/** 只读快照(测试/诊断面);FrameMetrics 装配走这里的冻结对象。 */
export function rendererRebuildFrameMetrics(ordinal: number): NonNullable<FrameMetrics["rendererRebuilds"]> {
  const last = ledger[ledger.length - 1];
  return Object.freeze({ ordinal, total: rebuildCounter, ...(last ? { last } : {}) });
}

/** 测试隔离专用:清空台账与计数,不在生产路径调用。 */
export function resetRendererRebuildLedgerForTests(): void {
  ledger.length = 0;
  rebuildCounter = 0;
}
