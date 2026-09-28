/**
 * T18 布料/毛发/软体/破碎/车辆 CPU 参考求解器:共享合同。
 *
 * 确定性合同(主计划 §T18"固定步长/seed 重复回放稳定"):
 * - 全部状态使用 f64(JS number),固定迭代顺序,不存在 Math.random / Date / 全局可变状态;
 * - 初始扰动与随机参数一律由外部传入的 seed 派生(复用 terrain/terrainRandom 的
 *   mulberry32 / hash / value noise,同为 32 位整型混淆链);
 * - 逐位一致域 = 同一运行时(同 Node/V8 构建)内同 seed 同输入;跨引擎逐位一致不在合同内
 *   (与 T13/T20 口径一致)。跨实例回放以 capture/restore 快照 + 指纹为证据。
 */

export type Vec3 = readonly [number, number, number];

/** 统一固定步长求解器合同:step 推进一个固定 tick;快照支持局部回放。 */
export interface FixedStepSim<TSnapshot> {
  /** 当前 tick 计数(从 0 起,step 一次加一)。 */
  readonly tick: number;
  /** 推进一个固定步长;内部不得访问时钟/随机源。 */
  step(): void;
  /** 捕获完整可变状态深拷贝(返回值与内部缓冲无别名)。 */
  capture(): TSnapshot;
  /** 从快照恢复(浅引用快照内部的 TypedArray 会被复制,快照可复用)。 */
  restore(snapshot: TSnapshot): void;
}

/** 连续运行 ticks 个固定步(便利驱动器,同 T19 advance_ticks 语义)。 */
export function runTicks<T>(sim: FixedStepSim<T>, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) sim.step();
}

/**
 * 局部回放:从第 N 步快照恢复后连续重放 steps 个固定步。
 * 回放期间输入必须由纯函数或调用方显式排队决定;本函数只负责状态与步数。
 */
export function replayFromStep<T>(sim: FixedStepSim<T>, snapshot: T, steps: number): void {
  sim.restore(snapshot);
  runTicks(sim, steps);
}

/**
 * 回放指纹:FNV-1a 双车道(正序/反序字节各一条 32 位链)滚动哈希 f64 位模式
 * (T20 指纹模式),输出 16 位十六进制;同输入逐位同输出,仅作证据不作身份。
 */
export function fingerprintFloat64(values: ArrayLike<number>): string {
  const f64 = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) f64[i] = values[i]!;
  const bytes = new Uint8Array(f64.buffer);
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    forward = Math.imul(forward ^ bytes[i]!, 0x01000193);
    backward = Math.imul(backward ^ bytes[bytes.length - 1 - i]!, 0x01000193);
  }
  const hex = (v: number) => (v >>> 0).toString(16).padStart(8, "0");
  return hex(forward) + hex(backward);
}

/** NaN/Inf 卫生哨兵:任一分量非有限即抛错(§6 通用门槛"无 NaN/Inf")。 */
export function assertFinite(values: ArrayLike<number>, label: string): void {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      throw new Error(`${label}[${i}] became non-finite (${v}); solver diverged.`);
    }
  }
}
