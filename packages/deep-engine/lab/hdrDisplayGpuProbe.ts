import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeFurnaceColor, evaluateFurnaceChecks, analyzeFurnaceFrame,
  uniformFurnaceEquirect, WHITE_FURNACE_ENVIRONMENT_RADIANCE } from "../src/webgpu/whiteFurnace.js";
import {
   describeHdrCanvasConfiguration,
  HDR_REFERENCE_WHITE_NITS, resolveHdrDisplayPolicy, GPU_TEXTURE_USAGE_SURFACE,
  type HdrDisplayProbe, type HdrDisplayStrategy } from "../src/webgpu/hdrDisplayOutput.js";
import { linearNitsToPq, linearToHlg } from "../src/webgpu/pbrHdrDisplay.js";
import type { HdrDetectionResult, StrategyLegResult } from "./hdrDisplayProbeTypes.js";

export { runStrategyLeg } from "./hdrDisplayStrategyLeg.js";
import {
  WIDTH, HEIGHT, STRATEGIES, authorBindGroup, copyTextureReadback,
  decodeRgba16float, ensureSession, writeStrategySettings } from "./hdrDisplayProbeSession.js";

/**
 * I-C21 HDR 显示输出真机探针(headless Chrome;形态同 atmosphereSkyGpuProbe)。
 * 会话/数据面见 hdrDisplayProbeSession.ts。
 *
 * 腿:
 *  1) detect        —— 真机探测:matchMedia dynamic-range + 试配置 rgba16float canvas +
 *                     toneMapping extended(逐项 try/catch,失败记显式原因)→
 *                     resolveHdrDisplayPolicy 的真实输入与 fail-closed 结论;
 *  2) sdr-vs-<策略> —— 同一份线性 HDR 斜坡(0..8,含超白高光)分别经既有 SDR
 *                     outputShader(ACES+sRGB)与 HDR 变体(extended/pq/hlg)管线渲到
 *                     离屏目标并读回:亮度/色域数值对照 + GPU↔CPU 镜像对拍;
 *  3) furnace       —— 白炉 0.5 uniform 环境,PbrRenderer 全管线(默认关,被改的
 *                     PbrOutputBindings 在链上)present-color 读回守恒 + 0.5 灰经
 *                     三种 HDR 策略编码的 GPU↔CPU 往返;
 *  4) screenshot    —— 页面内 SDR/HDR 演示画布(rgba16float configure 可用时真 HDR
 *                     canvas,否则 fail-closed SDR canvas),submit 后同任务 toDataURL。
 */

type Check = { readonly name: string; readonly passed: boolean; readonly detail: string };

let detection: HdrDetectionResult | undefined;

/** 腿 1:真机探测(matchMedia + 试配置)→ 策略门结论。 */
export async function probeHdrDetection(): Promise<HdrDetectionResult> {
  if (!navigator.gpu) {
    detection = {
      webgpuAvailable: false, displayDynamicRange: "unknown", canvasFormatRgba16float: false,
      canvasToneMappingExtended: false, preferredCanvasFormat: "rgba8unorm",
      probeErrors: ["navigator.gpu missing"],
      policy: { mode: "sdr", strategy: "aces-sdr", failClosed: true, reason: "webgpu-missing" },
      canvasConfiguration: null };
    return detection;
  }
  const errors: string[] = [];
  const dynamicRangeQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(dynamic-range: high)") : undefined;
  const displayDynamicRange = dynamicRangeQuery === undefined ? "unknown"
    : dynamicRangeQuery.matches ? "high" : "standard";
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) errors.push("requestAdapter returned null");
  const device = adapter ? await adapter.requestDevice() : undefined;
  let canvasFormatRgba16float = false;
  let canvasToneMappingExtended = false;
  let preferredCanvasFormat = "rgba8unorm";
  if (device) {
    preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat();
    const canvas = document.createElement("canvas");
    canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) errors.push("canvas.getContext(webgpu) returned null");
    else {
      try {
        context.configure({ device, format: "rgba16float", usage: GPU_TEXTURE_USAGE_SURFACE });
        canvasFormatRgba16float = true;
      } catch (error) {
        errors.push(`rgba16float configure: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        context.configure({ device, format: "rgba16float",
          toneMapping: { mode: "extended" }, usage: GPU_TEXTURE_USAGE_SURFACE });
        canvasToneMappingExtended = canvasFormatRgba16float;
      } catch (error) {
        errors.push(`extended configure: ${error instanceof Error ? error.message : String(error)}`);
      }
      context.unconfigure();
    }
    canvas.remove();
  }
  const probe: HdrDisplayProbe = { webgpuAvailable: Boolean(device), displayDynamicRange,
    canvasToneMappingExtended, canvasFormatRgba16float };
  const policy = resolveHdrDisplayPolicy(probe, { enabled: true });
  detection = {
    webgpuAvailable: Boolean(device), displayDynamicRange, canvasFormatRgba16float,
    canvasToneMappingExtended, preferredCanvasFormat, probeErrors: errors,
    policy: { mode: policy.mode, strategy: policy.strategy, failClosed: policy.failClosed, reason: policy.reason },
    canvasConfiguration: describeHdrCanvasConfiguration(policy) };
  return detection;
}

/** 腿 3:白炉守恒(PbrRenderer 全管线默认关,被改的 PbrOutputBindings 在链上)+ 0.5 灰 HDR 编码往返。 */
export async function runFurnaceLeg(): Promise<StrategyLegResult> {
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string): void => { checks.push({ name, passed, detail }); };
  // GPU 会话竞态自愈(同 atmosphereSkyGpuProbe):首帧 staging 竞态即整腿重建,最多 2 次。
  for (let attempt = 0; ; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH; canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
    canvas.dataset.leg = "furnace";
    document.body.appendChild(canvas);
    let renderer: PbrRenderer | undefined;
    try {
      renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
        environment: { kind: "radiance-hdr", image: uniformFurnaceEquirect(WHITE_FURNACE_ENVIRONMENT_RADIANCE) },
        features: { environment: true, fog: false, groundPlane: false, groundGrid: false,
          ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
          bloom: false, vignette: false },
        frameCapture: { session: new FrameCaptureSession(),
          readbacks: { requests: [{ resourceId: "present-color" }] } } });
      const view = {
        eye: [0, 0, 5], target: [0, 0, 0], extent: 10, background: [0.02, 0.02, 0.02],
        floor: [0.05, 0.05, 0.05], exposure: 1.0, roughness: 0.5, verticalFovRadians: Math.PI / 3,
        width: WIDTH, height: HEIGHT, pixelRatio: 1,
        lights: { directional: [] as never[] },
        panoramaBackground: { toneMapped: true } } as unknown as Parameters<PbrRenderer["validateFrame"]>[0];
      await renderer.validateFrame(view);
      const metrics = renderer.render(view);
      if (metrics === undefined) throw new Error("First furnace frame rolled back (surface unavailable).");
      const results = await renderer.frameReadbackResults;
      const color = (results ?? []).find(result => isPbrFrameReadbackSnapshot(result));
      if (!color) throw new Error("Furnace present-color readback unavailable.");
      const pixels = decodeFurnaceColor(color);
      const analysis = analyzeFurnaceFrame(pixels, WHITE_FURNACE_ENVIRONMENT_RADIANCE, undefined, "background");
      for (const check of evaluateFurnaceChecks(analysis)) {
        add(`furnace:${check.name}`, check.passed, check.detail);
      }
      break;
    } catch (error) {
      if (attempt >= 2) {
        add("furnace:ran", false, `${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      console.log(`[hdr-probe] furnace retry ${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { renderer?.dispose(); } catch { /* 尽力清理 */ }
      canvas.remove();
    }
  }

  // 0.5 灰 HDR 编码往返(真 GPU 渲染 vs CPU 镜像;白炉辐射经任一策略不得放大)。
  const probe = await ensureSession();
  const gray = probe.device.createTexture({ label: "hdr probe gray target", size: [WIDTH, HEIGHT],
    format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      | GPUTextureUsage.RENDER_ATTACHMENT });
  const sampler = probe.device.createSampler({ minFilter: "linear", magFilter: "linear" });
  for (const strategy of STRATEGIES) {
    writeStrategySettings(probe, strategy);
    const runtime = probe.hdrPipelines.get(strategy)!;
    const bind = probe.device.createBindGroup({ layout: runtime.bindGroupLayout, entries: [
      { binding: 0, resource: probe.sourceGray.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: probe.settingsBuffer } },
      { binding: 3, resource: { buffer: runtime.hdrSettingsBuffer } },
    ] });
    const encoder = probe.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: gray.createView(),
      loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(runtime.pipeline);
    pass.setBindGroup(0, bind);
    pass.setBindGroup(1, authorBindGroup(probe));
    pass.draw(3);
    pass.end();
    probe.device.queue.submit([encoder.finish()]);
    const bytes = await copyTextureReadback(probe.device, gray, WIDTH * 8);
    const decoded = decodeRgba16float({ width: WIDTH, height: HEIGHT, bytesPerRow: WIDTH * 8, bytes });
    const value = decoded[((HEIGHT >> 1) * WIDTH + (WIDTH >> 1)) * 4]!;
    const expected = strategy === "extended-linear" ? WHITE_FURNACE_ENVIRONMENT_RADIANCE
      : strategy === "pq-2020" ? linearNitsToPq(WHITE_FURNACE_ENVIRONMENT_RADIANCE * HDR_REFERENCE_WHITE_NITS)
        : linearToHlg(WHITE_FURNACE_ENVIRONMENT_RADIANCE);
    const relative = Math.abs(value - expected) / Math.max(expected, 0.02);
    add(`furnace-hdr:${strategy}`, relative <= 0.01,
      `gpu=${value.toFixed(5)} cpu=${expected.toFixed(5)} rel=${relative.toExponential(2)}`);
  }
  gray.destroy();
  return { strategy: "furnace", checks };
}

/** 腿 4:演示画布(SDR + rgba16float canvas 可用时真 HDR canvas)。
 * 逐画布在 submit 后同一任务内 toDataURL 捕获(WebGPU canvas 合成后内容即失效,
 * 同任务捕获是规范可靠路径;页面级整页截图仅作辅助存证)。 */
export async function buildDemoCanvases(): Promise<readonly { readonly label: string;
  readonly png: string }[]> {
  const probe = await ensureSession();
  const captures: { label: string; png: string }[] = [];
  // 逐画布格式:sdr 画布必须配 SDR 管线目标格式(bgra8unorm),HDR 画布配 rgba16float
  // —— 管线目标格式与 canvas 格式不匹配会整 pass 校验失败(黑屏),不可混用。
  const sdrFormat = (navigator.gpu?.getPreferredCanvasFormat() ?? "bgra8unorm") as GPUTextureFormat;
  // canvas HDR 不可用时 fail-closed:三块画布全部走 SDR 管线(HDR 管线目标是 rgba16float,
  // 渲到 8bit canvas 是管线格式不匹配;回退原因已在 detection.probeErrors 显式)。
  const hdrCanvasActive = detection?.canvasFormatRgba16float === true;
  for (const [label, strategy] of [["sdr", "sdr"], ["hdr-extended-linear", "extended-linear"],
    ["hdr-pq-2020", "pq-2020"]] as const) {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 128;
    canvas.style.width = "256px"; canvas.style.height = "128px";
    canvas.dataset.leg = label;
    document.body.appendChild(canvas);
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error(`${label}: webgpu context unavailable`);
    const useHdr = hdrCanvasActive && strategy !== "sdr";
    const configureOptions: GPUCanvasConfiguration = {
      device: probe.device, format: useHdr ? "rgba16float" : sdrFormat, usage: GPU_TEXTURE_USAGE_SURFACE };
    if (useHdr && detection?.canvasToneMappingExtended) {
      configureOptions.toneMapping = { mode: "extended" };
    }
    context.configure(configureOptions);
    const sampler = probe.device.createSampler({ minFilter: "linear", magFilter: "linear" });
    const encoder = probe.device.createCommandEncoder();
    if (!useHdr) {
      const bind = probe.device.createBindGroup({ layout: probe.sdrPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: probe.sourceRamp.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: probe.settingsBuffer } },
      ] });
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(probe.sdrPipeline);
      pass.setBindGroup(0, bind);
      pass.setBindGroup(1, probe.device.createBindGroup({
        layout: probe.sdrPipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: probe.authorBuffer } }] }));
      pass.draw(3);
      pass.end();
    } else {
      const runtime = probe.hdrPipelines.get(strategy as HdrDisplayStrategy)!;
      writeStrategySettings(probe, strategy as HdrDisplayStrategy);
      const bind = probe.device.createBindGroup({ layout: runtime.bindGroupLayout, entries: [
        { binding: 0, resource: probe.sourceRamp.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: probe.settingsBuffer } },
        { binding: 3, resource: { buffer: runtime.hdrSettingsBuffer } },
      ] });
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(runtime.pipeline);
      pass.setBindGroup(0, bind);
      pass.setBindGroup(1, authorBindGroup(probe));
      pass.draw(3);
      pass.end();
    }
    probe.device.queue.submit([encoder.finish()]);
    captures.push({ label, png: canvas.toDataURL("image/png") });
  }
  return captures;
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string;
  readonly description?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}
