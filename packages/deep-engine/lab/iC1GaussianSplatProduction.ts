/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";
import { decodeSplatRuntimeFormat } from "../src/gaussianSplat/decodeSplatRuntimeFormat.js";
import type { SplatCloud } from "../src/gaussianSplat/decodeSplatPly.js";
import { projectSplatCpu, projectedSplatAlpha } from "../src/gaussianSplat/splatProjectionCpu.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
import { jitterViewProjection } from "../src/webgpu/cameraFrameHistory.js";
import { temporalAaJitter } from "../src/postprocess/temporalAaCpu.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot, type PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { GAUSSIAN_SPLAT_QUADS_WGSL } from "../src/gaussianSplat/splatQuadsWgsl.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { probeIC1SharedReactiveMask } from "./iC1SharedReactiveMask.js";

const view: RenderView = { width: 1920, height: 1080, pixelRatio: 1, eye: [0, 0, 6], target: [0, 0, 0],
  extent: 6, verticalFovRadians: .8, near: .1, far: 50, exposure: 1, roughness: .7,
  background: [.012, .021, .032], floor: [0, 0, 0] };
const emptyPacket = { geometries: [], materials: [], instances: [] };
const plate = { geometries: [{ id: "occluder", revision: 1,
  vertices: new Float32Array([-3, -2, 1, 0, 0, 1, 0, -2, 1, 0, 0, 1, 0, 2, 1, 0, 0, 1, -3, 2, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
  materials: [{ id: "opaque", baseColor: [.08, .12, .16] as const, roughness: .9, metallic: 0, doubleSided: true }],
  instances: [{ id: "occluder", geometry: "occluder", material: "opaque",
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
function referenceCloud(alpha = .8): SplatCloud {
  const a = Math.sin(Math.PI / 8), b = Math.cos(Math.PI / 8);
  return { format: "cpu-reference-v1", splatCount: 1, shDegree: 0, shRestCount: 0, shRest: null,
    records: new Float32Array([0, 0, 0, alpha, .3, .08, .02, 0, 0, 0, a, b, .1, .7, 1, alpha]) };
}
function pixel(image: PbrFrameReadbackSnapshot, x: number, y: number): number[] {
  const data = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  return [0, 1, 2].map(channel => decodeHalfFloat(data.getUint16(y * image.bytesPerRow + x * 8 + channel * 2, true)));
}
const turns = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
export async function runIC1GaussianSplatProduction(onFrame: (name: string) => Promise<void>, temporalAa = false) {
  const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
  canvas.style.width = "100vw"; canvas.style.height = "100vh"; document.body.append(canvas);
  const capture = new FrameCaptureSession();
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    features: { environment: false, groundPlane: false, groundGrid: false, fog: false, ambientOcclusion: false,
      screenSpaceReflection: false, temporalAa, spatialAa: false, bloom: false, vignette: false, occlusionCulling: false },
    frameCapture: { session: capture, readbacks: { requests: [{ resourceId: "opaque-hdr" }] } },
  });
  const session = renderer.session, device = session.device; let result: Record<string, unknown> = {};
  device.pushErrorScope("validation");
  let renderCount = 0;
  const render = async (currentView = view) => {
    const revision = renderCount++, metrics = renderer.render(currentView);
    if (!metrics) throw Error("C1 production frame missing");
    const image = (await renderer.frameReadbackResults)?.find(isPbrFrameReadbackSnapshot);
    if (!image) throw Error("C1 HDR capture unavailable");
    await device.queue.onSubmittedWorkDone();
    return { image, metrics, revision };
  };
  try {
    const sharedMasks = [await probeIC1SharedReactiveMask(session, true), await probeIC1SharedReactiveMask(session, false)];
    await renderer.setPacketValidated(emptyPacket);
    await renderer.stageSplatCloud(referenceCloud(0));
    const background = await render();
    await onFrame("background");
    const cloud = referenceCloud(); await renderer.stageSplatCloud(cloud);
    const sampled = await render();
    const vm = lookAt(view.eye, view.target), vp = multiply(perspective(.8, 1920 / 1080, .1, 50), vm);
    const actualVp = temporalAa ? jitterViewProjection(vp, temporalAaJitter(sampled.revision), 1920, 1080) : vp;
    const projected = projectSplatCpu(cloud.records, { viewMatrix: vm, viewProjectionMatrix: actualVp,
      cameraPosition: view.eye, viewportPixels: [1920, 1080], focalPixels: [1080 / (2 * Math.tan(.4)), 1080 / (2 * Math.tan(.4))], splatCount: 1 })!;
    const locations = [[960, 540], [985, 515], [1010, 490], [935, 565], [910, 590], [985, 540], [935, 540], [960, 515], [960, 565]];
    const samples = locations.map(([x, y]) => {
      const alpha = projectedSplatAlpha(projected, x! + .5, y! + .5), base = pixel(background.image, x!, y!);
      const actual = pixel(sampled.image, x!, y!), expected = [.1, .7, 1].map((color, channel) => color * alpha + base[channel]! * (1 - alpha));
      return { x, y, alpha, actual, expected, error: Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!))) };
    });
    await onFrame("reference-anisotropic");
    const firstStatus = renderer.splatRenderStatus; await render();
    const cachedStatus = renderer.splatRenderStatus;
    await render({ ...view, eye: [.1, 0, 6] }); const movedStatus = renderer.splatRenderStatus;
    const layers = referenceCloud(); layers.splatCount = 2;
    layers.records = new Float32Array([...referenceCloud(.55).records, ...referenceCloud(.7).records]);
    layers.records.set([1, .1, .1, .55], 12); layers.records[18] = -.3;
    await renderer.stageSplatCloud(layers); const ordered = await render();
    const orderVp = temporalAa ? jitterViewProjection(vp, temporalAaJitter(ordered.revision), 1920, 1080) : vp;
    const orderSamples = locations.slice(0, 5).map(([x, y]) => {
      let expected = pixel(background.image, x!, y!);
      for (const index of [1, 0]) {
        const record = layers.records.subarray(index * 16, index * 16 + 16);
        const projection = projectSplatCpu(record, { viewMatrix: vm, viewProjectionMatrix: orderVp,
          cameraPosition: view.eye, viewportPixels: [1920, 1080], focalPixels: [1080 / (2 * Math.tan(.4)), 1080 / (2 * Math.tan(.4))], splatCount: 2 })!;
        const alpha = projectedSplatAlpha(projection, x! + .5, y! + .5);
        expected = expected.map((value, channel) => value * (1 - alpha) + record[12 + channel]! * alpha);
      }
      const actual = pixel(ordered.image, x!, y!);
      return { x, y, expected, actual, error: Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!))) };
    });
    await renderer.setPacketValidated(plate); await renderer.stageSplatCloud(referenceCloud(0));
    const meshOnly = await render(); await renderer.stageSplatCloud(cloud); const occluded = await render();
    const blocked = [[930, 550], [940, 540], [920, 565]].map(([x, y]) => ({ x, y,
      delta: Math.max(...pixel(meshOnly.image, x!, y!).map((v, c) => Math.abs(v - pixel(occluded.image, x!, y!)[c]!))) }));
    const visible = [[980, 530], [990, 510]].map(([x, y]) => ({ x, y,
      delta: Math.max(...pixel(meshOnly.image, x!, y!).map((v, c) => Math.abs(v - pixel(occluded.image, x!, y!)[c]!))) }));
    await onFrame("mesh-occlusion");
    const before = renderer.splatRenderStatus;
    let invalidRetained = false;
    const invalid = referenceCloud(); invalid.records[4] = NaN;
    try { await renderer.stageSplatCloud(invalid); } catch { invalidRetained = renderer.splatRenderStatus?.generation === before?.generation; }
    const aborted = new AbortController(); aborted.abort();
    const cancelled = await renderer.stageSplatCloud(cloud, aborted.signal);
    const cancelledRetained = cancelled === "cancelled" && renderer.splatRenderStatus?.generation === before?.generation;
    const bytes = new Uint8Array(await (await fetch("/sample.splat")).arrayBuffer());
    const sampleHash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    const sampleSha256 = Array.from(new Uint8Array(sampleHash), value => value.toString(16).padStart(2, "0")).join("");
    const real = decodeSplatRuntimeFormat(bytes), baselineResources = session.resourceCount;
    const stageStart = performance.now(); await renderer.stageSplatCloud(real); await device.queue.onSubmittedWorkDone(); await turns();
    const stageMs = performance.now() - stageStart, residentResources = session.resourceCount;
    await renderer.setPacketValidated(emptyPacket);
    const realView: RenderView = { ...view, eye: [0, -.4, -5.5], target: [0, 0, 0], up: [0, -1, 0], extent: 6 };
    const warmFrames = [];
    for (let n = 0; n < 3; n++) {
      const started = performance.now(), actual = await render(realView);
      warmFrames.push({ cpuSubmitMs: actual.metrics.cpuSubmitMs, drawCalls: actual.metrics.drawCalls,
        wallReadbackMs: performance.now() - started, triangles: actual.metrics.triangles });
    }
    const realStatus = renderer.splatRenderStatus; await onFrame("bonsai-static");
    await render({ ...realView, eye: [1.8, -.4, -5.2] }); await onFrame("bonsai-orbit");
    const orbitStatus = renderer.splatRenderStatus;
    renderer.clearSplatCloud(); await device.queue.onSubmittedWorkDone(); await turns();
    const clearStatus = renderer.splatRenderStatus, clearedResources = session.resourceCount;
    result = { temporalAa, sharedMasks, shaderHash: sha256Utf8(GAUSSIAN_SPLAT_QUADS_WGSL), samples,
      maxProjectionError: Math.max(...samples.map(sample => sample.error)), orderSamples,
      maxSortBlendError: Math.max(...orderSamples.map(sample => sample.error)), firstStatus, cachedStatus, movedStatus,
      blocked, visible, invalidRetained, cancelledRetained, sampleSha256, sampleBytes: bytes.byteLength,
      splatCount: real.splatCount, stageMs, warmFrames, realStatus, orbitStatus,
      baselineResources, residentResources, clearedResources, cleared: clearStatus === undefined };
  } catch (error) { result.failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error); }
  finally {
    result.validationError = (await device.popErrorScope())?.message;
    result.errors = session.diagnostics; renderer.dispose(); await turns(); result.remainingResources = session.resourceCount;
  }
  const r = result as any;
  result.passed = !r.failure && !r.validationError && r.errors.length === 0 && r.remainingResources === 0
    && r.maxProjectionError < .002 && r.maxSortBlendError < .002 && r.blocked.every((p: any) => p.delta < .002) && r.visible.every((p: any) => p.delta > .05)
    && r.firstStatus.sortCount === r.cachedStatus.sortCount && r.movedStatus.sortCount === r.cachedStatus.sortCount + 1
    && r.realStatus.sortCount === 1 && r.orbitStatus.sortCount === 2 && r.invalidRetained && r.cancelledRetained && r.cleared
    && r.sharedMasks.every((m: any) => m.passed) && r.splatCount === 272956 && r.sampleSha256 === "9e67a38943cd02aa0388c5abf3cb0465a330b7b45ad8aa3d3decc82e5cc8fbb1";
  return result;
}
