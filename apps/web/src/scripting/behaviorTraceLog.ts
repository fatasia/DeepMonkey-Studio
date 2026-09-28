/**
 * T31/E3 行为轨迹日志(切片一)。
 *
 * 行为触发的可审计事件流水:每条记录一个"规则触发→动作裁决"事实
 * (规则 id、动作、前后值摘要、裁决结果)。与 behavior/ 系统的自由文本
 * behavior.log 不同,本日志是结构化流水,供审计回放与后续调试器消费。
 *
 * 确定性口径:
 * - seq 为单调递增序号,由追加顺序唯一决定;时间戳使用注入的仿真时钟
 *   (atMs),不读墙钟——同脚本 + 同输入 + 同时钟 → 同日志序列(可逐字段比对)。
 * - 墙钟如需观测,由宿主在外层旁路记录,不进入日志体(避免破坏序列确定性)。
 *
 * 有界:环形缓冲,容量上限固定,溢出丢弃最旧条目——长跑不无界增长。
 */

/** 摘要字段最大长度:超长截断并加省略标记,保证单条日志有界。 */
const SUMMARY_MAX_LENGTH = 120;

/** 行为轨迹条目:全部字段确定性(时间来自注入时钟,序号来自追加顺序)。 */
export interface BehaviorTraceEntry {
  /** 单调递增序号(运行时内唯一,从 1 开始)。 */
  readonly seq: number;
  /** 注入仿真时钟毫秒值(如 Play 会话进入后的相对时间);非墙钟。 */
  readonly atMs: number;
  /** 所属行为图 id。 */
  readonly graphId: string;
  /** 触发本条记录的事件节点 id。 */
  readonly eventNodeId: string;
  /** 执行的动作节点 id;事件级记录(如预算中断)可缺省。 */
  readonly actionNodeId?: string;
  /** 动作类型(set-value/animate/…);事件级记录可缺省。 */
  readonly action?: string;
  /** 动作目标摘要(modelId/key/事件名)。 */
  readonly target?: string;
  /** 动作前值摘要(确定性序列化)。 */
  readonly before?: string;
  /** 动作后值摘要(确定性序列化)。 */
  readonly after?: string;
  /** 裁决结果:applied=已执行;skipped=条件未过;rejected=被预算/校验拒绝。 */
  readonly outcome: "applied" | "skipped" | "rejected";
  /** rejected/skipped 的机器可读原因(预算耗尽/未知动作/校验失败等)。 */
  readonly reason?: string;
}

export interface BehaviorTraceLogOptions {
  /** 环形容量;溢出丢最旧。默认 512,上限 4096。 */
  readonly capacity?: number;
  /** 注入仿真时钟(毫秒);缺省为单调计数器(每次 read 前进 0,由运行时显式推进)。 */
  readonly clock?: BehaviorTraceClock;
}

/** 仿真时钟:由宿主推进(如 Play 驱动帧累计),求值链路绝不自取墙钟。 */
export interface BehaviorTraceClock {
  /** 当前仿真时刻(毫秒)。同序列调用必须同值确定。 */
  readonly nowMs: () => number;
}

/** 单调零起时钟:默认实现,advance 显式推进。 */
export class MonotonicBehaviorClock implements BehaviorTraceClock {
  private elapsedMs = 0;
  nowMs(): number {
    return this.elapsedMs;
  }
  advance(deltaMs: number): void {
    if (Number.isFinite(deltaMs) && deltaMs > 0) this.elapsedMs += deltaMs;
  }
}

function clampCapacity(capacity: number | undefined): number {
  if (capacity === undefined || !Number.isFinite(capacity)) return 512;
  return Math.min(4_096, Math.max(8, Math.floor(capacity)));
}

/**
 * 环形行为轨迹日志。append 顺序即审计顺序;snapshot 返回时间序深拷贝,
 * 外部改动不影响缓冲内容。
 */
export class BehaviorTraceLog {
  private readonly capacity: number;
  private readonly clock: BehaviorTraceClock;
  private readonly entries: BehaviorTraceEntry[] = [];
  private nextSeq = 1;
  private droppedCount = 0;

  constructor(options: BehaviorTraceLogOptions = {}) {
    this.capacity = clampCapacity(options.capacity);
    this.clock = options.clock ?? new MonotonicBehaviorClock();
  }

  /** 追加一条记录;溢出时丢弃最旧,droppedCount 计数如实累加。返回带 seq 的最终条目。 */
  append(entry: Omit<BehaviorTraceEntry, "seq">): BehaviorTraceEntry {
    const complete: BehaviorTraceEntry = { ...entry, seq: this.nextSeq };
    this.nextSeq += 1;
    if (this.entries.length >= this.capacity) {
      this.entries.shift();
      this.droppedCount += 1;
    }
    this.entries.push(complete);
    return complete;
  }

  /** 当前注入仿真时刻(毫秒);供运行时统一取时,禁止直读墙钟。 */
  nowMs(): number {
    return this.clock.nowMs();
  }

  /** 时间序快照(深拷贝,旧→新)。 */
  snapshot(): BehaviorTraceEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** 缓冲中现存条目数(不含已溢出丢弃的)。 */
  get size(): number {
    return this.entries.length;
  }

  /** 累计溢出丢弃条数(审计:有界不等于无痕)。 */
  get dropped(): number {
    return this.droppedCount;
  }

  /** 已分配的最大 seq(即便被溢出丢弃,序号不回退——审计连续性依据)。 */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * 确定性摘要序列化:对象键按字典序排列,规避插入序差异;
 * 超长截断。同值必同串,是"同输入同日志"成立的前提之一。
 */
export function summarizeTraceValue(value: unknown): string {
  let text: string;
  if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = JSON.stringify(value);
  else if (typeof value === "number" || typeof value === "boolean" || value === null) text = String(value);
  else {
    try {
      text = stableStringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > SUMMARY_MAX_LENGTH) {
    return `${text.slice(0, SUMMARY_MAX_LENGTH)}…(${text.length})`;
  }
  return text;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
