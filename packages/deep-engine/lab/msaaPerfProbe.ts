/// <reference types="@webgpu/types" />
import { DeepWebGpuBackend } from "../src/threeBridge/DeepWebGpuBackend.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { DEFAULT_DISPLAY_CONTRACT } from "../../contracts/src/displayContract.js";
import { projectStudioDeepLights } from "./parityGateLightsHost.js";
import { sharedProjection } from "./c8SharedSceneFixture.js";
import { createParityScene } from "./parityGateScenes.js";

/**
 * AA-M1 1080p 帧时探针(性能门):生产默认特性档(引擎缺省 + web 桥 SSR/体积雾同款
 * 覆盖,MRT 主通路)下对同一场景按 msaaSampleCount=4/1 各渲染 N 帧,取引擎
 * performanceTelemetry 的 gpu-frame / frame-encode p50/p95。自适应质量关闭(不扰动
 * 阴影档位),固定内部分辨率 1。两次配置都在同一页面、同一场景内容上运行。
 */
export async function runMsaaPerfProbe(options: { readonly msaaSampleCount: 1 | 4;
  readonly width?: number; readonly height?: number; readonly frames?: number; readonly warmup?: number }) {
  const width = options.width ?? 1920, height = options.height ?? 1080;
  const frames = options.frames ?? 240, warmup = options.warmup ?? 40;
  const spec = createParityScene("pbr-matrix");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const lifetime = new AbortController();
  const lights = projectStudioDeepLights(spec.scene, 1, false);
  if (lights.issues.length) throw Error(`perf scene light projection failed: ${JSON.stringify(lights.issues)}`);
  const view = { eye: [...spec.eye], target: [...spec.target], up: [0, 1, 0] as const, extent: 4,
    background: [0.02, 0.022, 0.026] as const, floor: [0, 0, 0] as const,
    width, height, pixelRatio: 1, exposure: 1.05, roughness: 0.5, environmentIntensity: 0, fog: null,
    verticalFovRadians: Math.PI / 3, near: 0.1, far: 400, lights: lights.lights,
    authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0 } } };
  const backend = await DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu,
    projection: sharedProjection(), root: spec.root, view, signal: lifetime.signal,
    renderer: { msaaSampleCount: options.msaaSampleCount, deformation: true, meshlets: true,
      // 诊断采样(=performanceTelemetry/gpu-frame 计时)需要 adaptiveQuality.enabled;
      // 不开热点收集,短帧窗内自适应降档不触发(帧时远低于 33ms 长帧阈值)。
      adaptiveQuality: { enabled: true, collectHotspots: false },
      shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 2_048 } },
      features: { environment: true, groundPlane: false, groundGrid: false,
        screenSpaceReflection: true, volumetricFog: true,
        toneMapping: DEFAULT_DISPLAY_CONTRACT.toneMapping.operator } } });
  try {
    if (!(backend.runtime instanceof PbrRenderer)) throw Error("perf probe requires the production PbrRenderer");
    const runtime = backend.runtime;
    if (runtime.session.adapterInfo?.isFallbackAdapter !== false) throw Error("non-fallback adapter required");
    const publication = await backend.sync(spec.root, 1, lifetime.signal, view);
    if (publication.status !== "committed") throw Error(`perf scene publication failed: ${publication.status}`);
    const cpuSubmit: number[] = [];
    const submitDone: number[] = [];
    let lastMetrics: unknown;
    const device = runtime.session.device;
    for (let frame = 0; frame < frames + warmup; frame++) {
      const started = performance.now();
      const metrics = backend.render(view);
      if (!metrics) throw Error(`perf frame ${frame} did not render`);
      lastMetrics = metrics;
      // 逐帧背压:等本帧全部 GPU 工作完成再编码下一帧。dt ≈ max(CPU 编码, GPU 执行)
      // 的墙钟口径,不依赖 timestamp-query(headless 常不可用),A/B 同法可比。
      await device.queue.onSubmittedWorkDone();
      if (frame >= warmup) {
        cpuSubmit.push(metrics.cpuSubmitMs);
        submitDone.push(performance.now() - started);
      }
    }
    // GPU 时间戳读回滞后 1-2 帧:让最后的 readback microtask/回调落袋后再取快照。
    for (let settle = 0; settle < 12; settle++) await new Promise(resolve => setTimeout(resolve, 25));
    const snapshot = runtime.performanceTelemetry.snapshot();
    const msaa = (lastMetrics as { msaa?: unknown }).msaa;
    const percentile = (values: readonly number[], q: number): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    };
    return { msaaSampleCount: options.msaaSampleCount, msaa, width, height, frames, warmup,
      gpuFrame: snapshot.stages["gpu-frame"] ?? null, frameEncode: snapshot.stages["frame-encode"] ?? null,
      cpuSubmitP50: percentile(cpuSubmit, 0.5), cpuSubmitP95: percentile(cpuSubmit, 0.95),
      submitDoneP50: percentile(submitDone, 0.5), submitDoneP95: percentile(submitDone, 0.95),
      gpuTimerSupported: runtime.gpuTimer.supported,
      drawCalls: (lastMetrics as { drawCalls?: number }).drawCalls,
      triangles: (lastMetrics as { triangles?: number }).triangles,
      adapter: runtime.session.adapterInfo };
  } finally {
    lifetime.abort(); backend.dispose(); spec.dispose();
  }
}
