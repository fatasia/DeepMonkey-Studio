/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot, type PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { marchVolumetricFogPassCpu } from "../src/fog/volumetricFogPassCpu.js";
import { pbrGodRaysFrame } from "../src/webgpu/pbrGodRaysFrame.js";
import { resolvePbrSceneLighting } from "../src/lighting/pbrSceneLighting.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { VOLUMETRIC_GOD_RAYS_CSM_WGSL } from "../src/fog/volumetricGodRaysPassWgsl.js";

const WIDTH = 1920, HEIGHT = 1080;
const profile = { medium: { baseExtinction: .075, scaleHeight: 30, anisotropy: .35, albedo: .85 },
  light: { direction: [-.6, -.25, -1] as const, radiance: [16, 14, 11] as const }, steps: 48, maxDistance: 30 };
const primary = { directionWorld: profile.light.direction, color: profile.light.radiance, intensity: 1 };
const view: RenderView = { width: WIDTH, height: HEIGHT, pixelRatio: 1, eye: [0, 0, 8], target: [0, 0, -4], up: [0, 1, 0],
  extent: 10, verticalFovRadians: .9, near: .1, far: 60, background: [.015, .022, .033], floor: [0, 0, 0],
  exposure: 1, roughness: .8,
  authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0, temperature: 0, tint: 0 } } };
function plane(id: string, w: number, h: number) {
  return { id, revision: 1, vertices: new Float32Array([-w, -h, 0, 0, 0, 1, w, -h, 0, 0, 0, 1,
    w, h, 0, 0, 0, 1, -w, h, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}
const transform = (x: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];
function rgb(frame: PbrFrameReadbackSnapshot, x: number, y: number) {
  const data = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
  return [0, 1, 2].map(c => decodeHalfFloat(data.getUint16(y * frame.bytesPerRow + x * 8 + c * 2, true)));
}
function compare(a: PbrFrameReadbackSnapshot, b: PbrFrameReadbackSnapshot) {
  let maxError = 0, changedPixels = 0, finite = true;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const av = rgb(a, x, y), bv = rgb(b, x, y), error = Math.max(...av.map((v, c) => Math.abs(v - bv[c]!)));
    finite &&= [...av, ...bv].every(Number.isFinite); maxError = Math.max(maxError, error); if (error > .001) changedPixels++;
  }
  return { maxError, changedPixels, finite };
}

/** The production PBR frame, actual mesh shadow draw and original fog composite. */
export async function runIC18GodRaysProduction(onFrame: (name: string) => Promise<void>, exposure = 1) {
  const canvas = document.createElement("canvas"); canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = "100vw"; canvas.style.height = "100vh"; document.body.append(canvas);
  const capture = new FrameCaptureSession(), frames: Array<Record<string, unknown>> = [];
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    features: { environment: false, volumetricFog: true, groundPlane: false, groundGrid: false, fog: false,
      ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false, spatialAa: false,
      bloom: false, vignette: false, occlusionCulling: false },
    shadows: { exactProfile: { cascadeCount: 2, shadowMapSize: 512 } },
    frameCapture: { session: capture, readbacks: { requests: [{ resourceId: "present-color" }, { resourceId: "opaque-hdr" }, { resourceId: "linear-depth" }] } },
  });
  const session = renderer.session, device = session.device, epoch = session.recovery?.epoch ?? 0;
  device.pushErrorScope("validation"); let result: Record<string, unknown> = {}, validationError: string | undefined;
  try {
    await renderer.setPacketValidated({ geometries: [plane("receiver", 15, 8), plane("occluder", 1.1, 3)],
      materials: [{ id: "matte", baseColor: [.16, .2, .24], metallic: 0, roughness: .8, doubleSided: true }],
      instances: [{ id: "back-wall", geometry: "receiver", material: "matte", transform: transform(0, -8) },
        { id: "front-blocker", geometry: "occluder", material: "matte", transform: transform(-1, 0) }] });
    async function frame(name: string, strength?: number, castShadow = true, fog = true) {
      const metrics = renderer.render({ ...view, exposure, lights: { directional: [{ ...primary, castShadow }] },
        postProcess: { volumetricFog: fog, ...(fog ? { volumetricFogProfile: { ...profile,
          ...(strength === undefined ? {} : { godRaysStrength: strength }) } } : {}) } });
      if (!metrics) throw Error("God rays production frame did not submit.");
      const passes = capture.records().at(-1)?.passes.map(pass => pass.passId) ?? [];
      if (!passes.includes("opaque") || !passes.includes("present") || (fog && !passes.includes("volumetric-fog-march"))) throw Error("Actual production passes missing.");
      const reads = await renderer.frameReadbackResults;
      const select = (id: string) => reads?.find(row => isPbrFrameReadbackSnapshot(row) && row.resourceId === id) as PbrFrameReadbackSnapshot | undefined;
      const color = select("present-color"), opaque = select("opaque-hdr"), depth = select("linear-depth");
      if (!color || !opaque || !depth || color.format !== "rgba16float") throw Error("God rays production attachments unavailable.");
      frames.push({ name, passes, metrics, resources: session.resourceCount }); await onFrame(name);
      return { color, opaque, depth };
    }
    const legacy = await frame("legacy-fog"), initialCount = session.resourceCount;
    const shadowZero = await frame("shadow-zero", 0), shadowOne = await frame("shadow-one", 1), shadowTwo = await frame("shadow-two", 2);
    const warmCount = session.resourceCount, clearZero = await frame("clear-zero", 0, false), clearOne = await frame("clear-one", 1, false);
    const stableCount = session.resourceCount, restored = compare((await frame("legacy-restored")).color, legacy.color);
    const off = await frame("all-fog-off", undefined, true, false), offIdentity = compare(off.color, off.opaque);
    const values = new Array<number>(WIDTH * HEIGHT), dv = new DataView(clearOne.depth.bytes.buffer, clearOne.depth.bytes.byteOffset, clearOne.depth.bytes.byteLength);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) values[y * WIDTH + x] = dv.getFloat32(y * clearOne.depth.bytesPerRow + x * 4, true);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -8, 1]);
    const light = pbrGodRaysFrame(resolvePbrSceneLighting({ directional: [primary] }).primary, identity).light;
    // Independent existing fog kernel: bilinear upsample at the exact full-resolution pixel center.
    function expectedScatter(x: number, y: number) {
      const hx = (x + .5) / 2 - .5, hy = (y + .5) / 2 - .5, ix = Math.floor(hx), iy = Math.floor(hy), fx = hx - ix, fy = hy - iy;
      const output = [0, 0, 0];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const sample = marchVolumetricFogPassCpu({ width: WIDTH, height: HEIGHT, depth: values },
          { ...profile, light, verticalFovRadians: .9 }, Math.min(959, Math.max(0, ix + i)), Math.min(539, Math.max(0, iy + j)));
        for (let c = 0; c < 3; c++) output[c]! += sample[c]! * (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      }
      return output;
    }
    const samples = [400, 600, 800, 960, 1120, 1320, 1520].flatMap(x => [300, 540, 780].map(y => {
      const s0 = rgb(shadowZero.color, x, y), s1 = rgb(shadowOne.color, x, y), s2 = rgb(shadowTwo.color, x, y);
      const c0 = rgb(clearZero.color, x, y), c1 = rgb(clearOne.color, x, y), cpu = expectedScatter(x, y);
      const shadow = s1.map((v, c) => v - s0[c]!), clear = c1.map((v, c) => v - c0[c]!);
      return { x, y, shadow, clear, cpu, occlusion: clear[0]! - shadow[0]!,
        cpuError: Math.max(...clear.map((v, c) => Math.abs(v - cpu[c]!))),
        linearityError: Math.max(...s2.map((v, c) => Math.abs(v - s0[c]! - 2 * shadow[c]!))) };
    }));
    const cpuError = Math.max(...samples.map(row => row.cpuError)), linearityError = Math.max(...samples.map(row => row.linearityError));
    const occludedSamples = samples.filter(row => row.occlusion > .01).length;
    result = { exposure, frames, samples, cpuError, linearityError, occludedSamples, restored, offIdentity, initialCount, warmCount, stableCount,
      memory: session.resourceMemory, shaderHash: sha256Utf8(VOLUMETRIC_GOD_RAYS_CSM_WGSL), adapter: session.adapterInfo,
      epoch, sameDevice: session.device === device, passed: cpuError < .005 && linearityError < .005 && occludedSamples >= 2
        && restored.maxError === 0 && offIdentity.maxError === 0 && restored.finite && warmCount === stableCount && session.device === device };
  } finally {
    const validation = await device.popErrorScope(); validationError = validation?.message; renderer.dispose(); canvas.remove();
  }
  return { ...result, validationError, remainingResources: session.resourceCount, diagnostics: session.diagnostics,
    passed: result.passed === true && !validationError && !session.hasErrors && session.resourceCount === 0 };
}
