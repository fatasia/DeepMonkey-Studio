export type AdaptiveRenderScaleMode = "full-quality" | "adaptive-fill-rate";

export interface AdaptiveRenderScaleState {
  enabled: boolean;
  mode: AdaptiveRenderScaleMode;
  basePixelRatio: number;
  pixelRatio: number;
  renderScale: number;
  reason?: string;
}

export interface AdaptiveRenderSample {
  sampleCount: number;
  p95FrameMs: number;
  visible: boolean;
}

const MINIMUM_SAMPLE_COUNT = 120;
const PRESSURE_WINDOW_COUNT = 3;
const RECOVERY_WINDOW_COUNT = 4;
const PRESSURE_FRAME_MS = 25;
const RECOVERY_FRAME_MS = 19;

/**
 * 只在持续填充率压力下做最多 10% 的动态渲染缩放；模型、纹理、灯光、阴影、
 * 后处理和仿真状态均保持不变。压力解除后自动恢复设备基准像素比。
 */
export class AdaptiveRenderScaleController {
  private enabled = false;
  private pixelRatio: number;
  private pressureWindows = 0;
  private recoveryWindows = 0;
  private reason: string | undefined;

  constructor(private basePixelRatio: number) {
    if (!Number.isFinite(basePixelRatio) || basePixelRatio <= 0)
      throw new TypeError("设备像素比必须是大于 0 的有限数值");
    this.pixelRatio = basePixelRatio;
  }

  setBasePixelRatio(basePixelRatio: number): number | undefined {
    if (!Number.isFinite(basePixelRatio) || basePixelRatio <= 0)
      throw new TypeError("设备像素比必须是大于 0 的有限数值");
    if (basePixelRatio === this.basePixelRatio) return undefined;
    const scale = this.pixelRatio / this.basePixelRatio;
    this.basePixelRatio = basePixelRatio;
    this.pressureWindows = 0;
    this.recoveryWindows = 0;
    const floor = Math.min(basePixelRatio, Math.max(1, basePixelRatio * 0.9));
    const next = Math.min(basePixelRatio, Math.max(floor, basePixelRatio * scale));
    if (next === basePixelRatio) this.reason = undefined;
    return this.setPixelRatio(next);
  }

  setEnabled(enabled: boolean): number | undefined {
    this.enabled = enabled;
    this.pressureWindows = 0;
    this.recoveryWindows = 0;
    this.reason = undefined;
    return this.setPixelRatio(this.basePixelRatio);
  }

  sample(sample: AdaptiveRenderSample): number | undefined {
    if (!this.enabled || !sample.visible || sample.sampleCount < MINIMUM_SAMPLE_COUNT)
      return undefined;

    if (sample.p95FrameMs >= PRESSURE_FRAME_MS) {
      this.pressureWindows += 1;
      this.recoveryWindows = 0;
      if (this.pressureWindows < PRESSURE_WINDOW_COUNT) return undefined;
      this.pressureWindows = 0;
      const floor = Math.min(this.basePixelRatio, Math.max(1, this.basePixelRatio * 0.9));
      const next = Math.max(floor, this.pixelRatio - this.basePixelRatio * 0.05);
      this.reason = `持续帧压力：P95 ${sample.p95FrameMs.toFixed(1)} ms`;
      return this.setPixelRatio(next);
    }

    this.pressureWindows = 0;
    if (sample.p95FrameMs > RECOVERY_FRAME_MS || this.pixelRatio >= this.basePixelRatio) {
      this.recoveryWindows = 0;
      return undefined;
    }
    this.recoveryWindows += 1;
    if (this.recoveryWindows < RECOVERY_WINDOW_COUNT) return undefined;
    this.recoveryWindows = 0;
    this.reason = undefined;
    return this.setPixelRatio(this.basePixelRatio);
  }

  state(): AdaptiveRenderScaleState {
    return {
      enabled: this.enabled,
      mode: this.pixelRatio < this.basePixelRatio ? "adaptive-fill-rate" : "full-quality",
      basePixelRatio: this.basePixelRatio,
      pixelRatio: this.pixelRatio,
      renderScale: this.pixelRatio / this.basePixelRatio,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  private setPixelRatio(value: number): number | undefined {
    const rounded = value === this.basePixelRatio
      ? value
      : Math.min(this.basePixelRatio, Math.round(value * 100) / 100);
    if (Math.abs(rounded - this.pixelRatio) < 0.001) return undefined;
    this.pixelRatio = rounded;
    return rounded;
  }
}
