/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { PbrEnvironmentSource } from "../src/webgpu/pbrEnvironmentSource.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot, type PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { reflectionProbeInfluenceWeightCpu, reflectionProbePairWeightsCpu } from "../src/lighting/reflectionProbeParallaxMath.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";

const WIDTH = 1920, HEIGHT = 1080;
function panorama(color: readonly number[], patterned = false) {
  const width = 32, height = 16, data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    const pattern = patterned ? .2 + .8 * Math.max(0, Math.cos((x / width + y / height * .25) * Math.PI * 4)) : 1;
    data[(y * width + x) * 3 + c] = color[c]! * pattern;
  }
  return { width, height, data };
}
const options = { specularSize: 64, diffuseSize: 16, sampleCount: 64 } as const;
const globalImage = panorama([.18, .2, .23]), warm = panorama([2.5, .32, .08], true), cool = panorama([.08, .4, 2.5], true);
const base: PbrEnvironmentSource = { kind: "radiance-hdr", image: globalImage, options };
const box = (x: number, outside = false) => ({ center: [x, 0, 0] as const,
  halfExtents: outside ? [.01, .01, .01] as const : [1.6, 2, 1.5] as const,
  influenceRadius: outside ? 10 : 1, blendDistance: outside ? 1 : 1 });
const pair: PbrEnvironmentSource = { ...base, reflectionProbes: [
  { box: box(-1.5), image: warm, options }, { box: box(1.5), image: cool, options }] };
const view = { width: WIDTH, height: HEIGHT, pixelRatio: 1, eye: [0, 0, 7] as const, target: [0, 0, 0] as const,
  up: [0, 1, 0] as const, extent: 4, verticalFovRadians: .9, near: .1, far: 40,
  background: [.016, .022, .032] as const, floor: [0, 0, 0] as const, exposure: 1, roughness: .18,
  authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0, temperature: 0, tint: 0 } },
  lights: { directional: [] } };
function rgb(frame: PbrFrameReadbackSnapshot, x: number, y = HEIGHT / 2) {
  const bytes = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength), offset = y * frame.bytesPerRow + x * 8;
  return [0, 1, 2].map(c => decodeHalfFloat(bytes.getUint16(offset + c * 2, true)));
}
function difference(a: PbrFrameReadbackSnapshot, b: PbrFrameReadbackSnapshot) {
  let changedPixels = 0, maxError = 0, finite = true;
  const left = new DataView(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength), right = new DataView(b.bytes.buffer, b.bytes.byteOffset, b.bytes.byteLength);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    let error = 0;
    for (let c = 0; c < 3; c++) {
      const av = decodeHalfFloat(left.getUint16(y * a.bytesPerRow + x * 8 + c * 2, true));
      const bv = decodeHalfFloat(right.getUint16(y * b.bytesPerRow + x * 8 + c * 2, true));
      finite &&= Number.isFinite(av) && Number.isFinite(bv); error = Math.max(error, Math.abs(av - bv));
    }
    if (error > .001) changedPixels++; maxError = Math.max(maxError, error);
  }
  return { changedPixels, maxError, finite };
}

/** Actual PbrRenderer publication, rollback and two-cubemap production shading; no substitute rendering pass. */
export async function runIC15ReflectionProbeProduction(onFrame: (name: string) => Promise<void>) {
  const canvas = document.createElement("canvas"); canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = "100vw"; canvas.style.height = "100vh"; document.body.append(canvas);
  const capture = new FrameCaptureSession();
  const frames: Array<Record<string, unknown>> = [];
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: base, features: { environment: true, groundPlane: false, groundGrid: false, fog: false,
      ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false, spatialAa: false,
      bloom: false, vignette: false, occlusionCulling: false },
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    frameCapture: { session: capture, readbacks: { requests: [{ resourceId: "opaque-hdr" }] } },
  });
  const session = renderer.session, device = session.device, errors: string[] = [];
  const deviceEpoch = session.recovery?.epoch ?? 0;
  device.pushErrorScope("validation");
  let result: Record<string, unknown>;
  try {
    await renderer.setPacketValidated({ geometries: [{ id: "metal-wall", revision: 1,
      vertices: new Float32Array([-4, -2, 0, 0, 0, 1, 4, -2, 0, 0, 0, 1, 4, 2, 0, 0, 0, 1, -4, 2, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }], materials: [{ id: "metal", baseColor: [.8, .8, .8], metallic: 1, roughness: .18, doubleSided: true }],
      instances: [{ id: "wall", geometry: "metal-wall", material: "metal", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] });
    const frame = async (name: string) => {
      const metrics = renderer.render(view);
      if (!metrics) throw Error("Reflection frame did not submit.");
      const passes = capture.records().at(-1)?.passes.map(pass => pass.passId) ?? [];
      if (!passes.includes("opaque") || !passes.includes("present")) throw Error("Reflection fixture must execute HDR opaque and present passes.");
      frames.push({ name, drawCalls: metrics.drawCalls, triangles: metrics.triangles, postProcessPasses: metrics.postProcessPasses, passes });
      if (session.device !== device) throw Error("Reflection frame changed device epoch.");
      const captures = await renderer.frameReadbackResults;
      const hdr = captures?.find(isPbrFrameReadbackSnapshot);
      if (!hdr || hdr.format !== "rgba16float") throw Error("Production HDR attachment unavailable.");
      await onFrame(name); return hdr;
    };
    const initial = await frame("global"), baselineCount = session.resourceCount;
    await renderer.stageEnvironment({ ...base, reflectionProbes: [] });
    const empty = difference(await frame("empty"), initial);
    const cancel = new AbortController(); await renderer.stageEnvironment(pair, cancel.signal); cancel.abort();
    const cancellation = difference(await frame("cancelled"), initial);
    let invalidRejected = false;
    try { await renderer.stageEnvironment({ ...base, reflectionProbes: [{ box: { ...box(0), halfExtents: [0, 1, 1] } }] }); }
    catch { invalidRejected = true; }
    const rejection = difference(await frame("rejected"), initial);
    await renderer.stageEnvironment(pair); const submit = device.queue.submit; let submitRejected = false;
    try { device.queue.submit = () => { throw Error("C15 candidate submit rejected"); }; renderer.render(view); }
    catch (error) { if (!String(error).includes("C15 candidate submit rejected")) throw error; submitRejected = true; }
    finally { device.queue.submit = submit; }
    const rollback = difference(await frame("rolled-back"), initial);
    await renderer.stageEnvironment(pair); const projected = await frame("two-probes"), pairedCount = session.resourceCount;
    const changed = difference(projected, initial), crossBoundary = [420, 620, 800, 900, 960, 1020, 1120, 1300, 1500].map(x => ({ x, rgb: rgb(projected, x) }));
    await renderer.stageEnvironment({ ...base, reflectionProbes: [pair.reflectionProbes![0]!] });
    const primary = await frame("single-primary");
    await renderer.stageEnvironment({ ...base, reflectionProbes: [pair.reflectionProbes![1]!] });
    const secondary = await frame("single-secondary");
    const weightedSamples = [420, 620, 800, 900, 944, 960, 976, 1020, 1120, 1300, 1500].map(x => {
      // Pixel center -> same perspective camera's z=0 plane, independent of shader uniforms.
      const world = [(2 * (x + .5) / WIDTH - 1) * 7 * Math.tan(.9 / 2) * WIDTH / HEIGHT,
        (1 - 2 * (HEIGHT / 2 + .5) / HEIGHT) * 7 * Math.tan(.9 / 2), 0] as const;
      const raw = [reflectionProbeInfluenceWeightCpu(world, box(-1.5)), reflectionProbeInfluenceWeightCpu(world, box(1.5))];
      const swapped = raw[0]! < raw[1]!, pairWeights = reflectionProbePairWeightsCpu(raw[swapped ? 1 : 0]!, raw[swapped ? 0 : 1]!);
      const weights = swapped ? pairWeights.slice().reverse() : pairWeights, global = rgb(initial, x);
      const locals = [rgb(primary, x), rgb(secondary, x)].map((single, i) => single.map((value, c) =>
        raw[i]! > 0 ? (value - global[c]! * (1 - raw[i]!)) / raw[i]! : global[c]!));
      const coverage = Math.min(raw[0]! + raw[1]!, 1), actual = rgb(projected, x);
      const expected = global.map((value, c) => value * (1 - coverage)
        + coverage * (locals[0]![c]! * weights[0]! + locals[1]![c]! * weights[1]!));
      const maxError = Math.max(...actual.map((value, c) => Math.abs(value - expected[c]!)));
      return { x, world, raw, weights, actual, expected, maxError };
    });
    const weightedMaxError = Math.max(...weightedSamples.map(sample => sample.maxError));
    let centerMaxStep = 0;
    for (let x = 900; x < 1020; x++) centerMaxStep = Math.max(centerMaxStep,
      ...rgb(projected, x).map((value, c) => Math.abs(value - rgb(projected, x + 1)[c]!)));
    await renderer.stageEnvironment({ ...base, reflectionProbes: [
      { box: box(-1.5, true), image: warm, options }, { box: box(1.5, true), image: cool, options }] });
    const parallax = difference(await frame("planar-control"), projected);
    await renderer.stageEnvironment({ ...base, reflectionProbes: [{ box: box(100), image: warm, options }] });
    const outside = difference(await frame("outside"), initial);
    await renderer.stageEnvironment(base); const restored = difference(await frame("restored"), initial);
    result = { empty, cancellation, invalidRejected, rejection, submitRejected, rollback, changed, parallax, outside, restored,
      crossBoundary, weightedSamples, weightedMaxError, centerMaxStep, frames, baselineCount, pairedCount, finalCount: session.resourceCount, memory: session.resourceMemory,
      shaderHash: sha256Utf8(sceneShader), adapter: session.adapterInfo, deviceEpoch, sameDeviceAtCompletion: session.device === device,
      passed: weightedMaxError < .005 && centerMaxStep < .05 && invalidRejected && submitRejected && changed.changedPixels > 100 && parallax.changedPixels > 100
        && changed.finite && parallax.finite && pairedCount === baselineCount + 2 && session.resourceCount === baselineCount
        && [empty, cancellation, rejection, rollback, outside, restored].every(row => row.finite && row.maxError === 0) };
  } finally { const validation = await device.popErrorScope(); if (validation) errors.push(validation.message); renderer.dispose(); canvas.remove(); }
  return { ...result, passed: result!.passed === true && errors.length === 0 && session.resourceCount === 0 && !session.hasErrors,
    errors, remainingResources: session.resourceCount, diagnostics: session.diagnostics,
    scope: "actual 1920x1080 PBR HDR, bounded two-probe shading, global fallback, candidate cancellation/rejection/submission rollback" };
}

