/**
 * H-C7-P2 浏览器门共享 harness（模板套件唯一浏览器协议实现）。
 *
 * 形态沿 scripts/fixtures/deep-engine-consumer/browser.ts 已验消费门：
 * DeepApp + PbrRendererPlugin + present-color readback 像素证据 + 两帧推进 +
 * 取消/幂等释放断言。模板只提供 scene.ts（纯场景构造），渲染协议集中在此。
 */
import { FrameCaptureSession, type InstanceUpdate } from "@bim-studio/deep-engine";
import { DeepApp, PBR_RENDERER_FRAME_STATE, PBR_RENDERER_RESOURCE, PbrRendererPlugin } from "@bim-studio/deep-engine/app";
import type { FrameMetrics, RenderView } from "@bim-studio/deep-engine/webgpu";
import { TEMPLATE_FEATURES, type TemplateSceneSpec } from "./sceneTypes.js";

declare global {
  var finishDeepEngineTemplate: () => Promise<void>;
}

function toRenderView(spec: TemplateSceneSpec, eye: readonly [number, number, number],
  canvas: HTMLCanvasElement): RenderView {
  return { eye: [...eye], target: [...spec.target], extent: spec.extent,
    background: [...spec.background], floor: [...spec.floor],
    exposure: spec.exposure ?? 1.1, roughness: spec.roughness ?? 0.4,
    width: canvas.width, height: canvas.height, pixelRatio: 1 };
}

function firstTransform(packet: { instances: readonly { transform: ArrayLike<number> }[] }): number[] {
  const transform = packet.instances[0]?.transform;
  if (!transform) throw new Error("Template packet has no instance");
  return Array.from(transform);
}

export async function runTemplateBrowser(options: { template: string; scene: TemplateSceneSpec }): Promise<void> {
  const { template, scene } = options;
  const output = document.querySelector("output")!;
  const canvas = document.querySelector<HTMLCanvasElement>("#viewport")!;
  const status = (value: string, payload?: unknown): void => {
    output.textContent = payload === undefined ? value : JSON.stringify(payload);
    output.setAttribute("data-status", value);
  };
  try {
    if (!navigator.gpu) throw new Error("WebGPU unavailable in template acceptance runtime");
    const captureSession = new FrameCaptureSession();
    const state: { view: readonly [number, number, number] } = { view: scene.eye(0) };
    const app = await DeepApp.create({ state, plugins: [new PbrRendererPlugin<typeof state>({
      canvas, gpu: navigator.gpu, packet: scene.packet,
      view: frame => toRenderView(scene, frame.state.view, canvas),
      renderer: { features: TEMPLATE_FEATURES, frameCapture: { session: captureSession,
        readbacks: { requests: [{ resourceId: "present-color" }] } } } })] });
    const frames: FrameMetrics[] = [];
    const renderer = app.requireResource(PBR_RENDERER_RESOURCE);
    renderer.session.device.pushErrorScope("validation");
    const first = await app.advance(0);
    if (first.status !== "rendered") throw new Error(`Unexpected first frame: ${JSON.stringify(first)}`);
    await renderer.session.device.queue.onSubmittedWorkDone();
    const validationError = await renderer.session.device.popErrorScope();
    if (validationError) throw new Error(`WebGPU validation failed: ${validationError.message}`);
    const firstMetrics = app.requireResource(PBR_RENDERER_FRAME_STATE).current;
    if (!firstMetrics) throw new Error("First frame produced no metrics");
    frames.push(firstMetrics);
    const readbacks = await renderer.frameReadbackResults;
    const captured = readbacks?.find(result => result.resourceId === "present-color");
    if (!captured || !("bytes" in captured)) {
      throw new Error(`Presented HDR readback unavailable: ${JSON.stringify(captured)}`);
    }
    const pixelEvidence = inspectPixels(captured.bytes, captured.bytesPerRow, captured.width,
      captured.height, captured.format, 8, firstMetrics);

    const update: InstanceUpdate | undefined = scene.update?.(16);
    if (update) renderer.updateInstances(update);
    state.view = scene.eye(16);
    app.invalidate("template-frame-update");
    const second = await app.advance(16);
    if (second.status !== "rendered") throw new Error(`Unexpected second frame: ${second.status}`);
    const secondMetrics = app.requireResource(PBR_RENDERER_FRAME_STATE).current;
    if (!secondMetrics) throw new Error("Second frame produced no metrics");
    frames.push(secondMetrics);

    // 动画判定：update() 以对象引用区分静态/动态件（静态件复用同一引用），引用或材质集有差异即动画。
    const before = scene.packet.instances, after = (update ?? scene.packet).instances;
    const beforeMaterials = scene.packet.materials, afterMaterials = update?.materials ?? scene.packet.materials;
    const animated = scene.update !== undefined &&
      (before.length !== after.length || before.some((instance, index) => instance !== after[index]) ||
        beforeMaterials.some((material, index) => material !== afterMaterials[index]));
    status("rendered", { template, rendererId: renderer.id ?? "deep-webgpu", frames, pixelEvidence, animated,
      instances: scene.packet.instances.length, materials: scene.packet.materials.length,
      geometries: scene.packet.geometries.length });
    globalThis.finishDeepEngineTemplate = async () => {
      const cancelled = document.querySelector<HTMLCanvasElement>("#cancel")!;
      const aborted = new AbortController(); aborted.abort("template cancellation check");
      let wasCancelled = false;
      try { await DeepApp.create({ state: null, plugins: [new PbrRendererPlugin<null>({
        canvas: cancelled, gpu: navigator.gpu, signal: aborted.signal, packet: scene.packet,
        view: () => toRenderView(scene, scene.eye(0), cancelled) })] }); } catch { wasCancelled = true; }
      const firstDispose = app.dispose(), secondDispose = app.dispose();
      const sameDisposePromise = firstDispose === secondDispose;
      await firstDispose;
      status("passed", { template, cancelled: wasCancelled, sameDisposePromise,
        disposed: app.status === "disposed" });
    };
  } catch (error) {
    status("failed", error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  }
}

function inspectPixels(bytes: Uint8Array, bytesPerRow: number, width: number, height: number,
  format: GPUTextureFormat, bytesPerPixel: number, metrics: FrameMetrics) {
  const first = bytes.slice(0, bytesPerPixel); let distinct = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * bytesPerRow + x * bytesPerPixel; let delta = 0;
    for (let channel = 0; channel < bytesPerPixel; channel++) {
      delta += Math.abs(bytes[offset + channel]! - first[channel]!);
    }
    if (delta > 2) distinct++;
  }
  if (distinct < 200) {
    throw new Error(`GPU HDR readback contained only ${distinct} non-background pixels; ` +
      `corner=${[...first].join(",")}; metrics=${JSON.stringify(metrics)}`);
  }
  return { width, height, format, source: "present-color", distinctFromCorner: distinct };
}
