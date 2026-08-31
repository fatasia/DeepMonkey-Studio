export type RendererPipelineWarmupStatus = "idle" | "scheduled" | "running" | "ready" | "failed";

export interface RendererPipelineWarmupSnapshot {
  status: RendererPipelineWarmupStatus;
  completedRuns: number;
  skippedRuns: number;
  lastDurationMs?: number;
  lastError?: string;
}

type WarmupTask = () => Promise<boolean | void> | boolean | void;
type ScheduleTask = (run: () => void) => number;
type CancelTask = (handle: number) => void;

/**
 * 合并短时间内重复的管线预热请求，并在浏览器空闲窗口执行最新任务。
 * 模型、材质和灯光连续变化时不会反复编译同一批着色器。
 */
export class RendererPipelineWarmupScheduler {
  private pendingTask: WarmupTask | undefined;
  private scheduledHandle: number | undefined;
  private running = false;
  private status: RendererPipelineWarmupStatus = "idle";
  private completedRuns = 0;
  private skippedRuns = 0;
  private lastDurationMs: number | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly scheduleTask: ScheduleTask,
    private readonly cancelTask: CancelTask,
    private readonly now: () => number = () => performance.now(),
  ) {}

  request(task: WarmupTask): void {
    this.pendingTask = task;
    this.lastError = undefined;
    this.queue();
  }

  dispose(): void {
    this.pendingTask = undefined;
    if (this.scheduledHandle !== undefined) this.cancelTask(this.scheduledHandle);
    this.scheduledHandle = undefined;
    this.status = "idle";
  }

  snapshot(): RendererPipelineWarmupSnapshot {
    return {
      status: this.status,
      completedRuns: this.completedRuns,
      skippedRuns: this.skippedRuns,
      ...(this.lastDurationMs === undefined ? {} : { lastDurationMs: this.lastDurationMs }),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private queue(): void {
    if (this.running || this.scheduledHandle !== undefined) return;
    this.status = "scheduled";
    this.scheduledHandle = this.scheduleTask(() => {
      this.scheduledHandle = undefined;
      void this.runNext();
    });
  }

  private async runNext(): Promise<void> {
    const task = this.pendingTask;
    this.pendingTask = undefined;
    if (!task) {
      this.status = "idle";
      return;
    }
    this.running = true;
    this.status = "running";
    const startedAt = this.now();
    try {
      const performed = await task();
      if (performed === false) this.skippedRuns += 1;
      else this.completedRuns += 1;
      this.lastDurationMs = Math.max(0, this.now() - startedAt);
      this.status = "ready";
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.status = "failed";
    } finally {
      this.running = false;
      if (this.pendingTask) this.queue();
    }
  }
}

export function createBrowserPipelineWarmupScheduler(): RendererPipelineWarmupScheduler {
  const supportsIdleCallback = typeof window.requestIdleCallback === "function";
  const schedule: ScheduleTask = supportsIdleCallback
    ? (run) => window.requestIdleCallback(run, { timeout: 800 })
    : (run) => window.setTimeout(run, 0);
  const cancel: CancelTask = supportsIdleCallback
    ? (handle) => window.cancelIdleCallback(handle)
    : (handle) => window.clearTimeout(handle);
  return new RendererPipelineWarmupScheduler(schedule, cancel);
}
