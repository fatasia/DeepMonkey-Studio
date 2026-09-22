import { FrameCaptureSession, type InstanceUpdate, type RenderPacket } from "@bim-studio/deep-engine";
import { DeepApp, PBR_RENDERER_FRAME_STATE, PBR_RENDERER_RESOURCE, PbrRendererPlugin } from "@bim-studio/deep-engine/app";
import type { FrameMetrics, RenderView } from "@bim-studio/deep-engine/webgpu";

declare global { var finishDeepEngineConsumer: () => Promise<void>; }
const output = document.querySelector("output")!, canvas = document.querySelector<HTMLCanvasElement>("#viewport")!;
const transform = (x: number, y = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] as const;
const packet: RenderPacket = {
  geometries: [{ id: "triangle", revision: 1,
    vertices: new Float32Array([-1.1, -1.1, 0, 0, 0, 1, 1.1, -1.1, 0, 0, 0, 1, 0, 1.1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "metal", baseColor: [0.08, 0.45, 0.95], metallic: 0.25, roughness: 0.28,
    emissiveFactor: [0.1, 0.8, 1], emissiveStrength: 4, doubleSided: true }],
  instances: [{ id: "left", geometry: "triangle", material: "metal", transform: transform(-0.45) },
    { id: "right", geometry: "triangle", material: "metal", transform: transform(0.45) }],
};
const state: { view: RenderView } = { view: { eye: [0, 0, 5], target: [0, 0, 0], extent: 3,
  background: [0.7, 0.03, 0.02], floor: [0.04, 0.05, 0.07], exposure: 1.2, roughness: 0.4,
  width: canvas.width, height: canvas.height, pixelRatio: 1 } };

try {
  if (!navigator.gpu) throw new Error("WebGPU unavailable in Chrome acceptance runtime");
  const captureSession = new FrameCaptureSession();
  const app = await DeepApp.create({ state, plugins: [new PbrRendererPlugin<typeof state>({ canvas, gpu: navigator.gpu,
    packet, view: frame => frame.state.view, renderer: { features: {
      environment: false, fog: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
      screenSpaceReflection: false, volumetricFog: false, temporalAa: false, spatialAa: false,
      visibilityBuffer: false, softRasterizeFallback: false, textureArrays: false,
      occlusionCulling: false, bloom: true, vignette: true, toneMapping: "three-aces-r185",
    }, frameCapture: { session: captureSession, readbacks: { requests: [{ resourceId: "present-color" }] } } } })] });
  const frames: FrameMetrics[] = [], renderer = app.requireResource(PBR_RENDERER_RESOURCE);
  renderer.session.device.pushErrorScope("validation");
  const first = await app.advance(0); if (first.status !== "rendered") throw new Error(`Unexpected first frame: ${JSON.stringify(first)}`);
  await renderer.session.device.queue.onSubmittedWorkDone();
  const validationError = await renderer.session.device.popErrorScope();
  if (validationError) throw new Error(`WebGPU validation failed: ${validationError.message}`);
  const firstMetrics = app.requireResource(PBR_RENDERER_FRAME_STATE).current; if (!firstMetrics) throw new Error("First frame produced no metrics");
  frames.push(firstMetrics);
  const readbacks = await renderer.frameReadbackResults;
  const captured = readbacks?.find(result => result.resourceId === "present-color");
  if (!captured || !("bytes" in captured)) throw new Error(`Presented HDR readback unavailable: ${JSON.stringify(captured)}`);
  const pixelEvidence = inspectPixels(captured.bytes, captured.bytesPerRow, captured.width, captured.height,
    captured.format, 8, firstMetrics);
  const update: InstanceUpdate = { materials: packet.materials, instances: [packet.instances[0]!,
    { ...packet.instances[1]!, transform: transform(0.25, 0.2) }] };
  renderer.updateInstances(update);
  state.view = { ...state.view, eye: [0.35, 0.15, 5] }; app.invalidate("camera-and-instance-update");
  const second = await app.advance(16);
  if (second.status !== "rendered") throw new Error(`Unexpected second frame: ${second.status}`);
  const secondMetrics = app.requireResource(PBR_RENDERER_FRAME_STATE).current; if (!secondMetrics) throw new Error("Second frame produced no metrics");
  frames.push(secondMetrics);
  output.textContent = JSON.stringify({ rendererId: app.requireResource(PBR_RENDERER_RESOURCE).id, frames, pixelEvidence });
  output.setAttribute("data-status", "rendered");
  globalThis.finishDeepEngineConsumer = async () => {
    const aborted = new AbortController(); aborted.abort("external cancellation fixture"); let cancelled = false;
    try { await DeepApp.create({ state: null, plugins: [new PbrRendererPlugin<null>({
      canvas: document.querySelector<HTMLCanvasElement>("#cancel")!, gpu: navigator.gpu, signal: aborted.signal,
      view: () => state.view })] }); } catch { cancelled = true; }
    const firstDispose = app.dispose(), secondDispose = app.dispose(), sameDisposePromise = firstDispose === secondDispose;
    await firstDispose;
    output.textContent = JSON.stringify({ rendererId: "deep-webgpu", frames, pixelEvidence, cancelled, sameDisposePromise,
      disposed: app.status === "disposed" }); output.setAttribute("data-status", "passed");
  };
} catch (error) {
  output.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  output.setAttribute("data-status", "failed"); throw error;
}

function inspectPixels(bytes: Uint8Array, bytesPerRow: number, width: number, height: number,
  format: GPUTextureFormat, bytesPerPixel: number, metrics: FrameMetrics) {
  const first = bytes.slice(0, bytesPerPixel); let distinct = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * bytesPerRow + x * bytesPerPixel; let delta = 0;
    for (let channel = 0; channel < bytesPerPixel; channel++) delta += Math.abs(bytes[offset + channel]! - first[channel]!);
    if (delta > 2) distinct++;
  }
  if (distinct < 200) throw new Error(`GPU HDR readback contained only ${distinct} non-background pixels; corner=${[...first].join(",")}; metrics=${JSON.stringify(metrics)}`);
  return { width, height, format, source: "present-color", distinctFromCorner: distinct };
}
