/**
 * T18 统一固定步长协议(T16/T19 同族模式):仿真 tick 与渲染帧时间解耦。
 *
 * - 规范驱动器 `advanceTicks(n)`(确定性回放只用它);
 * - 便利驱动器 `advanceSeconds(dt)` 把渲染帧时间量化为整 tick:`round(dt × hz)`,
 *   亚 tick 余量累计保留;超过 `maxCatchUpTicks` 的积压按上限执行并丢弃超出部分
 *   (1/45 这类非整倍帧率会整体放慢——与 T19 相同的已声明限定);
 * - 负 dt 按输入契约视为 0(浮点误差容忍),不抛错。
 */
import type { FixedStepSim } from "./physicsTypes.js";

export interface FixedStepClockConfig {
  /** 固定步长频率(Hz),必须为正且有限。 */
  readonly hz: number;
  /** 单次 advanceSeconds 允许追赶的最大 tick 数,防长帧死亡螺旋。 */
  readonly maxCatchUpTicks: number;
}

export class FixedStepClock {
  readonly #hz: number;
  readonly #maxCatchUpTicks: number;
  #tick = 0;
  #remainder = 0;

  constructor(config: FixedStepClockConfig) {
    if (!Number.isFinite(config.hz) || config.hz <= 0) throw new Error(`FixedStepClock: hz must be a positive finite number, got ${config.hz}.`);
    if (!Number.isSafeInteger(config.maxCatchUpTicks) || config.maxCatchUpTicks <= 0) {
      throw new Error(`FixedStepClock: maxCatchUpTicks must be a positive integer, got ${config.maxCatchUpTicks}.`);
    }
    this.#hz = config.hz;
    this.#maxCatchUpTicks = config.maxCatchUpTicks;
  }

  get tick(): number {
    return this.#tick;
  }

  get hz(): number {
    return this.#hz;
  }

  /** 未消费的亚 tick 余量(秒),仅供诊断,不参与确定性结果。 */
  get pendingRemainderSeconds(): number {
    return this.#remainder;
  }

  /** 便利驱动器:量化执行,返回本帧实际执行的 tick 数。 */
  advanceSeconds(dtSeconds: number): number {
    if (!Number.isFinite(dtSeconds)) throw new Error(`FixedStepClock: dt must be finite, got ${dtSeconds}.`);
    if (dtSeconds <= 0) return 0;
    this.#remainder += dtSeconds * this.#hz;
    const quantized = Math.round(this.#remainder);
    const executed = Math.min(quantized, this.#maxCatchUpTicks);
    this.#remainder -= executed;
    // 余量封顶:积压超过一个 tick 的碎屑丢弃,避免量化残差无限累积。
    if (this.#remainder > 1) this.#remainder = 0;
    this.#tick += executed;
    return executed;
  }

  /** 规范驱动器:精确执行 n 个固定步。 */
  advanceTicks(ticks: number): void {
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Error(`FixedStepClock: ticks must be a non-negative integer, got ${ticks}.`);
    this.#tick += ticks;
  }

  reset(): void {
    this.#tick = 0;
    this.#remainder = 0;
  }
}

/** 时钟 + 求解器的组合步进:tick 计数以求解器自身为准(求解器持有权威 tick)。 */
export function stepSimSeconds<T>(sim: FixedStepSim<T>, clock: FixedStepClock, dtSeconds: number): number {
  const ticks = clock.advanceSeconds(dtSeconds);
  for (let i = 0; i < ticks; i += 1) sim.step();
  return ticks;
}

