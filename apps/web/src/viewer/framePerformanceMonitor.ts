/** 采集渲染帧与资源压力信号；这里只做证据记录，不替代真实设备基准测试。 */
export interface RendererLoadSnapshot {
  backend: "webgl" | "webgpu";
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  /** 基础体缓存中的唯一几何数量，用于区分业务几何与查看器辅助几何。 */
  sharedPrimitiveGeometries: number;
  textures: number;
  programs?: number;
  viewportPixels: number;
  pixelRatio: number;
  activeFeatures: string[];
  adaptiveRenderScale?: import("./adaptiveRenderScale").AdaptiveRenderScaleState;
  pipelineWarmup?: import("./rendererPipelineWarmup").RendererPipelineWarmupSnapshot;
  shadowUpdates?: import("./shadowUpdateGovernor").ShadowUpdateSnapshot;
}

export interface HeapSnapshot {
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
}

export type PerformancePressureCode = "frame-budget" | "draw-calls" | "geometry-load" | "texture-load" | "fill-rate" | "heap-pressure" | "main-thread";

export interface PerformancePressureSignal {
  code: PerformancePressureCode;
  level: "notice" | "warning" | "critical";
  evidence: string;
}

export interface FramePerformanceSnapshot {
  sampleCount: number;
  sampleWindowMs: number;
  fps: number;
  frameTimeMs: {
    p50: number;
    p95: number;
    p99: number;
    maximum: number;
  };
  over33msRate: number;
  over50msRate: number;
  ignoredBackgroundFrames: number;
  renderer: RendererLoadSnapshot;
  heap?: HeapSnapshot;
  mainThread?: import("./mainThreadLongTaskMonitor").MainThreadLongTaskSnapshot;
  gpuFrameTime?: import("./gpuFrameTimeMonitor").GpuFrameTimeSnapshot;
  pressureSignals: PerformancePressureSignal[];
}

const FRAME_SAMPLE_LIMIT = 600;
const BACKGROUND_GAP_MS = 1_000;

/**
 * 保存最近约十秒的可见帧样本。后台标签页和系统休眠造成的长间隔会被剔除，
 * 避免把浏览器调度暂停误判成场景渲染掉帧。
 */
export class FramePerformanceMonitor {
  private readonly frameDurations: number[] = [];
  private lastTimestamp: number | undefined;
  private ignoredBackgroundFrames = 0;

  recordFrame(timestamp: number, visible = true): void {
    const previous = this.lastTimestamp;
    this.lastTimestamp = timestamp;
    if (previous === undefined) return;

    const duration = timestamp - previous;
    if (!visible || duration <= 0 || duration >= BACKGROUND_GAP_MS) {
      this.ignoredBackgroundFrames += 1;
      return;
    }

    this.frameDurations.push(duration);
    if (this.frameDurations.length > FRAME_SAMPLE_LIMIT) this.frameDurations.shift();
  }

  /** 按需渲染的空闲期不属于渲染帧耗时，保留已有样本并断开计时。 */
  pauseSampling(): void { this.lastTimestamp = undefined; }

  reset(): void {
    this.frameDurations.length = 0;
    this.lastTimestamp = undefined;
    this.ignoredBackgroundFrames = 0;
  }

  snapshot(renderer: RendererLoadSnapshot, heap?: HeapSnapshot, mainThread?: import("./mainThreadLongTaskMonitor").MainThreadLongTaskSnapshot): FramePerformanceSnapshot {
    const sorted = [...this.frameDurations].sort((left, right) => left - right);
    const sampleWindowMs = this.frameDurations.reduce((total, value) => total + value, 0);
    const averageFrameMs = sorted.length ? sampleWindowMs / sorted.length : 0;
    const frameTimeMs = {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      maximum: sorted.at(-1) ?? 0,
    };
    const snapshot: FramePerformanceSnapshot = {
      sampleCount: sorted.length,
      sampleWindowMs,
      fps: averageFrameMs > 0 ? 1_000 / averageFrameMs : 0,
      frameTimeMs,
      over33msRate: ratioOver(sorted, 100 / 3),
      over50msRate: ratioOver(sorted, 50),
      ignoredBackgroundFrames: this.ignoredBackgroundFrames,
      renderer,
      ...(heap ? { heap } : {}),
      ...(mainThread ? { mainThread } : {}),
      pressureSignals: [],
    };
    snapshot.pressureSignals = derivePressureSignals(snapshot);
    return snapshot;
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, rank)] ?? 0;
}

function ratioOver(values: readonly number[], threshold: number): number {
  if (!values.length) return 0;
  return values.filter((value) => value > threshold).length / values.length;
}

/** 这些信号只提供定位线索；最终归因仍需浏览器 Performance/GPU profile 证据。 */
function derivePressureSignals(snapshot: FramePerformanceSnapshot): PerformancePressureSignal[] {
  const signals: PerformancePressureSignal[] = [];
  const { renderer, frameTimeMs, heap } = snapshot;

  if (frameTimeMs.p95 > 33.34) {
    signals.push({
      code: "frame-budget",
      level: frameTimeMs.p95 > 50 ? "critical" : "warning",
      evidence: `P95 ${frameTimeMs.p95.toFixed(1)} ms，超过 30 FPS 帧预算`,
    });
  }
  if (renderer.drawCalls > 1_000) {
    signals.push({
      code: "draw-calls",
      level: renderer.drawCalls > 2_000 ? "critical" : "warning",
      evidence: `${renderer.drawCalls.toLocaleString("zh-CN")} draw calls`,
    });
  }
  if (renderer.triangles > 5_000_000 || renderer.geometries > 5_000) {
    signals.push({
      code: "geometry-load",
      level: renderer.triangles > 10_000_000 ? "critical" : "warning",
      evidence: `${renderer.triangles.toLocaleString("zh-CN")} triangles · ${renderer.geometries.toLocaleString("zh-CN")} geometries`,
    });
  }
  if (renderer.textures > 800) {
    signals.push({
      code: "texture-load",
      level: renderer.textures > 1_500 ? "critical" : "warning",
      evidence: `${renderer.textures.toLocaleString("zh-CN")} textures`,
    });
  }
  if (frameTimeMs.p95 > 25 && (renderer.pixelRatio > 1.5 || renderer.viewportPixels > 8_000_000)) {
    signals.push({
      code: "fill-rate",
      level: frameTimeMs.p95 > 50 ? "critical" : "notice",
      evidence: `${renderer.viewportPixels.toLocaleString("zh-CN")} physical pixels · ${renderer.pixelRatio.toFixed(2)}× pixel ratio`,
    });
  }
  if (heap && heap.limitBytes > 0 && heap.usedBytes / heap.limitBytes > 0.75) {
    signals.push({
      code: "heap-pressure",
      level: heap.usedBytes / heap.limitBytes > 0.9 ? "critical" : "warning",
      evidence: `${Math.round((heap.usedBytes / heap.limitBytes) * 100)}% JS heap limit`,
    });
  }
  if (snapshot.mainThread?.supported && (snapshot.mainThread.blockingTimeMs > 100 || snapshot.mainThread.maximumDurationMs > 120)) {
    signals.push({
      code: "main-thread",
      level: snapshot.mainThread.blockingTimeMs > 300 ? "critical" : "warning",
      evidence: `${snapshot.mainThread.count} long tasks · ${snapshot.mainThread.blockingTimeMs.toFixed(0)} ms blocking time`,
    });
  }
  return signals;
}
