import { PbrRenderer } from "@bim-studio/deep-engine/webgpu";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import type { TrajectoryCameraPose } from "@bim-studio/deep-engine";
import { captureWebGpuBenchmarkImage } from "./benchmarkImage.js";
import type { BenchmarkBackend, BenchmarkFrameStats } from "./benchmarkBackend.js";
import type { BenchmarkSceneFixture } from "./benchmarkScene.js";
import { createBenchmarkFidelitySnapshot, type BenchmarkFidelitySnapshot,
  type BenchmarkProfile } from "./benchmarkProfile.js";

export class DeepBenchmarkBackend implements BenchmarkBackend {
  readonly id = "deep-webgpu";
  readonly version = "0.1.0";
  private currentView: RenderView;

  private constructor(private readonly canvas: HTMLCanvasElement,
    private readonly renderer: PbrRenderer, private readonly fixture: BenchmarkSceneFixture,
    readonly profile: BenchmarkProfile, readonly fidelity: BenchmarkFidelitySnapshot) { this.currentView = fixture.view; }

  setCamera(pose: TrajectoryCameraPose): void {
    this.currentView = { ...this.fixture.view, eye: pose.position, target: pose.target, verticalFovRadians: pose.fovDeg * Math.PI / 180 };
  }

  static async create(canvas: HTMLCanvasElement, fixture: BenchmarkSceneFixture,
    signal: AbortSignal, profile: BenchmarkProfile): Promise<DeepBenchmarkBackend> {
    const baseline = profile === "baseline-equivalent";
    const renderer = await PbrRenderer.create(canvas, navigator.gpu, signal, {
      // Keep benchmark comparisons on the production Studio feature profile.
      meshlets: true,
      deformation: true,
      shadows: baseline ? { exactProfile: { cascadeCount: 1, shadowMapSize: 2048,
        depthBias: 0.00075, receiverNormalBias: "constant-one-texel" as const } } : { requestedTier: "high" },
      ...(baseline ? { features: { environment: false, fog: false, groundGrid: false,
        ambientOcclusion: false, temporalAa: false, spatialAa: false, bloom: false, vignette: false,
        occlusionCulling: false,
        toneMapping: "three-aces-r185" as const } } : {}),
    });
    try {
      await renderer.setPacketValidated(fixture.packet, signal);
      await renderer.validateFrame(fixture.view);
      const fidelity = createBenchmarkFidelitySnapshot("deep-webgpu", profile, fixture, canvas);
      return new DeepBenchmarkBackend(canvas, renderer, fixture, profile, fidelity);
    } catch (error) { renderer.dispose(); throw error; }
  }

  get timestampSupported(): boolean { return this.renderer.gpuTimer.supported; }
  get adapter(): Readonly<Record<string, unknown>> | null {
    return this.renderer.session.adapterInfo ?? null;
  }

  render(): BenchmarkFrameStats {
    const started = performance.now();
    const frame = this.renderer.render(this.currentView);
    if (!frame) throw new Error("Deep benchmark frame was not submitted.");
    const rendered = performance.now();
    const result = Object.freeze({ drawCalls: frame.drawCalls, triangles: frame.triangles,
      resources: frame.resources, cpuStages: Object.freeze({ renderCallMs: rendered - started,
        statisticsReadMs: performance.now() - rendered }) });
    return result;
  }

  setGpuInstrumentation(enabled: boolean): void { this.renderer.gpuTimer.enabled = enabled; }

  async settle(): Promise<void> { await this.renderer.session.device.queue.onSubmittedWorkDone(); }

  async measureGpuFrame(): Promise<number | null> {
    if (!this.timestampSupported) return null;
    if (!this.renderer.gpuTimer.enabled) throw new Error("Deep GPU timing was not enabled before warmup.");
    const frame = this.renderer.render(this.currentView);
    if (!frame) throw new Error("Deep GPU timing frame was not submitted.");
    const values = await this.renderer.gpuTimer.collect(frame.frame, frame.frame);
    const value = values.find(entry => entry.frame === frame.frame)?.milliseconds;
    if (value === undefined) throw new Error("Deep GPU timestamp readback did not resolve.");
    return value;
  }

  capture() {
    this.render();
    return captureWebGpuBenchmarkImage(this.renderer.session.device, this.renderer.session.context,
      this.renderer.session.format, this.canvas.width, this.canvas.height);
  }
  errors(): readonly string[] {
    return [...this.renderer.session.diagnostics.map(item => `${item.kind}: ${item.message}`),
      ...this.renderer.gpuTimer.diagnostics.map(message => `timestamp: ${message}`)];
  }
  dispose(): void { this.renderer.dispose(); }
}
