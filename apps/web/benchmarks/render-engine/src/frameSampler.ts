import type { FrameMetrics } from "./contracts";

export class FrameSampler {
  private readonly samples: number[] = [];
  private previousTime: number | undefined;

  record(now: number): void {
    if (this.previousTime !== undefined) {
      this.samples.push(now - this.previousTime);
      if (this.samples.length > 600) this.samples.shift();
    }
    this.previousTime = now;
  }

  reset(): void {
    this.samples.length = 0;
    this.previousTime = undefined;
  }

  snapshot(): FrameMetrics {
    if (this.samples.length === 0) return { samples: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maximumMs: 0 };
    const sorted = [...this.samples].sort((left, right) => left - right);
    const averageMs = this.samples.reduce((total, value) => total + value, 0) / this.samples.length;
    return {
      samples: this.samples.length,
      averageMs,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maximumMs: sorted.at(-1) ?? 0,
    };
  }
}

/** 复用同一分位口径采样 GPU 查询结果；忽略尚未返回或无效的读数。 */
export class ValueSampler {
  private readonly samples: number[] = [];

  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.samples.push(value);
    if (this.samples.length > 600) this.samples.shift();
  }

  snapshot(): FrameMetrics {
    if (!this.samples.length) return emptyMetrics();
    const sorted = [...this.samples].sort((left, right) => left - right);
    return {
      samples: sorted.length,
      averageMs: sorted.reduce((total, value) => total + value, 0) / sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maximumMs: sorted.at(-1) ?? 0
    };
  }

  /** 原始样本只读视图;A03 SampleWindow 合同要求原始样本,禁止从分位数反推。 */
  raw(): readonly number[] {
    return [...this.samples];
  }
}

export async function waitForFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function percentile(sorted: number[], ratio: number): number {
  const rank = Math.ceil(sorted.length * ratio) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
}

function emptyMetrics(): FrameMetrics {
  return { samples: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maximumMs: 0 };
}
