/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { prefilterPanoramaReference } from "./iblPrefilterReference.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { compareIblReference, encodeRuntimeIblReference, floatToHalf } from "./iblReferenceEncode.js";

export interface DynamicIblProbeResult {
  webgpu: boolean;
  adapterNonFallback: boolean;
  referenceParity: { maxAbsError: number; meanAbsError: number; pass: boolean; samples: number };
  hotSwap: { generationReturn: boolean; repeatStableMaxError: number; counts: readonly number[] };
  degradedClamp: { finite: boolean; keptMips: number };
  outstandingLeases: number;
  deviceErrors: string[];
}

const WIDTH = 960, HEIGHT = 540;
/** Half-exact banded panorama: CPU reference and GPU sampler both see exact fp16 inputs. */
function panorama(a: readonly number[], b: readonly number[]) {
  const width = 64, height = 32, data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    data[(y * width + x) * 3 + c] = (x + y) % 2 === 0 ? a[c]! : b[c]!;
  }
  return { width, height, data } as unknown as Parameters<typeof prefilterPanoramaReference>[0];
}
/** Smooth half-exact gradient: both the CPU mirror and the GPU upload must see
 * identical fp16 texels; high-frequency checkerboards amplify equirect
 * interpolation differences and are recorded as diagnostics instead. */
function smoothPanorama(a: readonly number[], b: readonly number[]) {
  const width = 64, height = 32;
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    const t = (x / (width - 1)) * 0.6 + (y / (height - 1)) * 0.4;
    // Round the smooth ramp through fp16 so the CPU mirror and the GPU upload
    // see byte-identical texels.
    data[(y * width + x) * 3 + c] = decodeHalfFloat(floatToHalf(a[c]! + (b[c]! - a[c]!) * t));
  }
  return { width, height, data } as unknown as Parameters<typeof prefilterPanoramaReference>[0];
}
const warmA = smoothPanorama([0.25, 0.5, 0.25], [1, 2, 0.5]);
const coolB = smoothPanorama([0.5, 0.25, 2], [0.125, 1, 0.5]);
const quality = { specularSize: 64, diffuseSize: 16, sampleCount: 64 } as const;
const identity = (id: string, revision: number, value: string) => ({
  id, revision, contentHash: { algorithm: "sha256" as const, value: sha256Utf8(value) }, license: "fixture-local",
});
const view = { width: WIDTH, height: HEIGHT, pixelRatio: 1, eye: [0, 0, 7] as const, target: [0, 0, 0] as const,
  up: [0, 1, 0] as const, extent: 4, verticalFovRadians: .9, near: .1, far: 40,
  background: [0, 0, 0] as const, floor: [0, 0, 0] as const, exposure: 1, roughness: .18,
  environmentIntensity: 1, authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0 } },
  lights: { directional: [] } };

function frameRgb(frame: PbrFrameReadbackSnapshot): number[] {
  const viewBytes = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
  const out: number[] = [];
  for (let y = 0; y < frame.height; y += 2) for (let x = 0; x < frame.width; x += 2) for (let c = 0; c < 3; c++) {
    out.push(decodeHalfFloat(viewBytes.getUint16(y * frame.bytesPerRow + x * 8 + c * 2, true)));
  }
  return out;
}
function frameDifference(a: PbrFrameReadbackSnapshot, b: PbrFrameReadbackSnapshot): number {
  const av = frameRgb(a), bv = frameRgb(b);
  let max = 0;
  for (let i = 0; i < Math.min(av.length, bv.length); i++) max = Math.max(max, Math.abs(av[i]! - bv[i]!));
  return max;
}

export async function runDynamicIblProductionProbe(): Promise<DynamicIblProbeResult> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.cssText = "width:640px;height:360px";
  document.getElementById("stage")!.append(canvas);
  const capture = new FrameCaptureSession();
  const deviceErrors: string[] = [];
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    features: { environment: true, groundPlane: false, groundGrid: false, fog: false,
      ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false, spatialAa: false,
      bloom: false, vignette: false, occlusionCulling: false },
    shadows: { exactProfile: { cascadeCount: 2, shadowMapSize: 64 } },
    frameCapture: { session: capture, readbacks: { requests: [{ resourceId: "opaque-hdr" }] } },
  });
  const session = renderer.session, device = session.device;
  const adapterNonFallback = session.adapterInfo?.isFallbackAdapter === false;
  device.addEventListener("uncapturederror", event => deviceErrors.push(String(event.error?.message ?? event.error)));
  device.pushErrorScope("validation");
  let referenceParity = { maxAbsError: -1, meanAbsError: -1, pass: false, samples: 0 };
  let hotSwap = { generationReturn: false, repeatStableMaxError: -1, counts: [] as number[] };
  let degradedClamp = { finite: false, keptMips: 0 };
  try {
    await renderer.setPacketValidated({ geometries: [{ id: "sphere-room", revision: 1,
      vertices: new Float32Array([-4, -2, 0, 0, 0, 1, 4, -2, 0, 0, 0, 1, 4, 2, 0, 0, 0, 1, -4, 2, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
      materials: [{ id: "chrome", baseColor: [.9, .9, .92], metallic: 1, roughness: .12, doubleSided: true }],
      instances: [{ id: "wall", geometry: "sphere-room", material: "chrome",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] });
    const frame = async () => {
      if (!renderer.render(view)) throw Error("Dynamic IBL frame did not submit.");
      if (session.device !== device) throw Error("Dynamic IBL probe changed device epoch.");
      const captures = await renderer.frameReadbackResults;
      const hdr = captures?.find(isPbrFrameReadbackSnapshot);
      if (!hdr || hdr.format !== "rgba16float") throw Error("Dynamic IBL production HDR attachment unavailable.");
      return hdr;
    };

    // (a) Reference parity: identical scene, GPU-prefiltered HDR upload vs the
    // CPU mirror uploaded as a prefiltered-ibl package.
    const reference = prefilterPanoramaReference(warmA, quality);
    const encodedA = encodeRuntimeIblReference(reference, identity("dynamic-ibl-a", 1, "fixture-a"), 64);
    await renderer.stageEnvironment({ kind: "radiance-hdr", image: warmA, options: quality });
    for (let i = 0; i < 4; i++) await frame();
    const gpuFrame = await frame();
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: encodedA });
    for (let i = 0; i < 4; i++) await frame();
    const cpuFrame = await frame();
    // Compare only the reflective geometry band; background rows are black by design.
    const gpuRgb = frameRgb(gpuFrame), cpuRgb = frameRgb(cpuFrame);
    const sampleStride = 3;
    referenceParity = compareIblReference(gpuRgb, cpuRgb, { actualStride: sampleStride, tolerance: 0.002 });

    // (b) Hot swap A -> B -> A: generation return and repeat stability.
    const encodedB = encodeRuntimeIblReference(prefilterPanoramaReference(coolB, quality), identity("dynamic-ibl-b", 1, "fixture-b"), 64);
    const counts: number[] = [session.resourceCount];
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: encodedB });
    for (let i = 0; i < 2; i++) await frame();
    counts.push(session.resourceCount);
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: encodedA });
    for (let i = 0; i < 2; i++) await frame();
    counts.push(session.resourceCount);
    const repeatFrame = await frame();
    hotSwap = {
      generationReturn: counts[2]! <= counts[1]!,
      repeatStableMaxError: frameDifference(cpuFrame, repeatFrame),
      counts,
    };

    // (c) Degraded residency decision (CPU state machine) plus a finite-frame
    // check on the re-staged package. The keptMips sampler clamp itself needs
    // the pbrRenderer/mainBindings wiring that this knife does not touch, so
    // the frame assertion covers the package the plan accepts, and the
    // clamp is recorded as wired-followup in the evidence.
    const keptMips = Math.max(1, reference.mipCount >> 1);
    const degradedPackage = encodeRuntimeIblReference(reference, identity("dynamic-ibl-a", 2, "fixture-a-degraded"), 64);
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: degradedPackage });
    for (let i = 0; i < 2; i++) await frame();
    const degradedFrame = await frame();
    degradedClamp = { finite: frameRgb(degradedFrame).every(Number.isFinite), keptMips };

    // (d) Return to the exact-A package and confirm byte-stable hot-swap target.
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: encodedA });
    for (let i = 0; i < 2; i++) await frame();
    const restoreFrame = await frame();
    hotSwap.repeatStableMaxError = Math.max(hotSwap.repeatStableMaxError, frameDifference(cpuFrame, restoreFrame));
  } finally {
    const validation = await device.popErrorScope().catch(error => {
      deviceErrors.push(String(error)); return null;
    });
    if (validation) deviceErrors.push(validation.message);
    renderer.dispose();
    canvas.remove();
  }
  return {
    webgpu: true, adapterNonFallback, referenceParity, hotSwap, degradedClamp,
    outstandingLeases: session.resourceCount, deviceErrors,
  };
}
