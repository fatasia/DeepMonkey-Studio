import type { FrameMetrics } from "./contracts";
import { ValueSampler } from "./frameSampler";

interface TimerQueryExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** WebGL2 原生 GPU 查询；查询异步回读，避免用 `gl.finish()` 阻塞并污染结果。 */
export class WebGlGpuTimer {
  private readonly extension: TimerQueryExtension | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly samples = new ValueSampler();
  private active = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQueryExtension | null;
  }

  begin(): void {
    this.poll();
    if (!this.extension || this.active || this.pending.length >= 4) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.pending.push(query);
    this.active = true;
  }

  end(): void {
    if (!this.extension || !this.active) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.active = false;
  }

  snapshot(): FrameMetrics {
    this.poll();
    return this.samples.snapshot();
  }

  dispose(): void {
    if (this.active && this.extension) this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.forEach((query) => this.gl.deleteQuery(query));
    this.pending.length = 0;
    this.active = false;
  }

  private poll(): void {
    if (!this.extension) return;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      // 频率切换等 disjoint 状态会使现有查询失真；丢弃本批，后续帧重新采样。
      this.pending.forEach((query) => this.gl.deleteQuery(query));
      this.pending.length = 0;
      return;
    }
    while (this.pending.length) {
      const query = this.pending[0]!;
      if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) return;
      const nanoseconds = Number(this.gl.getQueryParameter(query, this.gl.QUERY_RESULT));
      this.samples.record(nanoseconds / 1_000_000);
      this.gl.deleteQuery(query);
      this.pending.shift();
    }
  }
}
