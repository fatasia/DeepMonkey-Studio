type YieldControl = () => Promise<void>;

/**
 * 将大批量同步创建拆成短时间片，避免设备导入或场景恢复长时间占满主线程。
 * 分片只改变调度时机，不改变对象顺序、数据或最终渲染结果。
 */
export class CooperativeWorkScheduler {
  private sliceStartedAt: number;

  constructor(
    private readonly now: () => number,
    private readonly yieldControl: YieldControl,
    private readonly maximumSliceMs = 8,
  ) {
    this.sliceStartedAt = now();
  }

  async checkpoint(): Promise<boolean> {
    if (this.now() - this.sliceStartedAt < this.maximumSliceMs) return false;
    await this.yieldControl();
    this.sliceStartedAt = this.now();
    return true;
  }
}

export function createBrowserCooperativeWorkScheduler(maximumSliceMs = 8): CooperativeWorkScheduler {
  const browserScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  const yieldControl = typeof browserScheduler?.yield === "function"
    ? () => browserScheduler.yield!()
    : () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  return new CooperativeWorkScheduler(() => performance.now(), yieldControl, maximumSliceMs);
}
