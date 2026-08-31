export interface MainThreadLongTaskSnapshot {
  supported: boolean;
  count: number;
  totalDurationMs: number;
  blockingTimeMs: number;
  maximumDurationMs: number;
  windowMs: number;
}

interface LongTaskEntry {
  startTime: number;
  duration: number;
}

/** 保存最近十秒主线程长任务，帮助区分 GPU 压力与脚本/UI 阻塞。 */
export class MainThreadLongTaskMonitor {
  private readonly entries: LongTaskEntry[] = [];
  private observer: PerformanceObserver | undefined;

  constructor(
    private readonly supported: boolean,
    private readonly windowMs = 10_000,
  ) {}

  connect(observer: PerformanceObserver): void {
    this.observer?.disconnect();
    this.observer = observer;
  }

  record(startTime: number, duration: number): void {
    if (!Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0) return;
    this.entries.push({ startTime, duration });
  }

  snapshot(now = performance.now()): MainThreadLongTaskSnapshot {
    const cutoff = now - this.windowMs;
    while (this.entries[0] && this.entries[0].startTime + this.entries[0].duration < cutoff) this.entries.shift();
    const durations = this.entries.map((entry) => entry.duration);
    return {
      supported: this.supported,
      count: durations.length,
      totalDurationMs: durations.reduce((total, duration) => total + duration, 0),
      blockingTimeMs: durations.reduce((total, duration) => total + Math.max(0, duration - 50), 0),
      maximumDurationMs: durations.length ? Math.max(...durations) : 0,
      windowMs: this.windowMs,
    };
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.entries.length = 0;
  }
}

export function createBrowserLongTaskMonitor(): MainThreadLongTaskMonitor {
  const supported = typeof PerformanceObserver !== "undefined"
    && PerformanceObserver.supportedEntryTypes.includes("longtask");
  const monitor = new MainThreadLongTaskMonitor(supported);
  if (!supported) return monitor;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) monitor.record(entry.startTime, entry.duration);
  });
  observer.observe({ entryTypes: ["longtask"] });
  monitor.connect(observer);
  return monitor;
}
