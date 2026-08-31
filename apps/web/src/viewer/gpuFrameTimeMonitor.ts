export interface GpuFrameTimeSnapshot {
  supported: boolean;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
}

interface TimestampBackend {
  trackTimestamp?: boolean;
}

interface TimestampRenderer {
  backend?: TimestampBackend;
  resolveTimestampsAsync?: (type?: string) => Promise<number | undefined>;
}

const SAMPLE_LIMIT = 120;
const DEFAULT_SAMPLE_INTERVAL = 30;

/**
 * 只在诊断面板打开时低频解析 GPU timestamp。
 * 初始化后默认关闭查询，避免普通用户为性能观测持续支付每帧开销。
 */
export class GpuFrameTimeMonitor {
  private readonly renderer: TimestampRenderer;
  private readonly samples: number[] = [];
  private readonly supported: boolean;
  private enabled = false;
  private pending = false;
  private renderedFrames = 0;
  private generation = 0;

  constructor(
    renderer: unknown,
    private readonly sampleInterval = DEFAULT_SAMPLE_INTERVAL,
  ) {
    this.renderer = renderer as TimestampRenderer;
    this.supported = Boolean(this.renderer.backend?.trackTimestamp && this.renderer.resolveTimestampsAsync);
    if (this.renderer.backend) this.renderer.backend.trackTimestamp = false;
  }

  setEnabled(enabled: boolean): void {
    this.generation += 1;
    this.enabled = enabled && this.supported;
    this.renderedFrames = 0;
    this.pending = false;
    if (this.enabled) this.samples.length = 0;
    if (this.renderer.backend) this.renderer.backend.trackTimestamp = this.enabled;
  }

  onFrameRendered(): void {
    if (!this.enabled || this.pending || !this.renderer.resolveTimestampsAsync) return;
    this.renderedFrames += 1;
    if (this.renderedFrames % this.sampleInterval !== 0) return;

    this.pending = true;
    const generation = this.generation;
    void this.renderer
      .resolveTimestampsAsync("render")
      .then((duration) => {
        if (!this.enabled || generation !== this.generation || !Number.isFinite(duration) || duration! < 0) return;
        this.samples.push(duration!);
        if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === this.generation) this.pending = false;
      });
  }

  snapshot(): GpuFrameTimeSnapshot {
    const sorted = [...this.samples].sort((left, right) => left - right);
    return {
      supported: this.supported,
      sampleCount: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maximumMs: sorted.at(-1) ?? 0,
    };
  }

  dispose(): void {
    this.setEnabled(false);
    this.samples.length = 0;
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, rank)] ?? 0;
}
