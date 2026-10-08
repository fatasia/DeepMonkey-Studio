/// <reference types="@webgpu/types" />
import { PbrRenderer, type RenderView } from "../src/webgpu/pbrRenderer.js";
import type { RenderPacket } from "../src/renderPacket.js";
import { normalizeExtendedMaterialParameters } from "../src/shader/materialParameters.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { bounded, readSharedDeepFrame } from "./c8SharedSceneReadback.js";
import { validatePbrRenderView } from "../src/webgpu/pbrRenderViewValidation.js";

const WIDTH = 160, HEIGHT = 96;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function quad(id: string, x0: number, x1: number, z: number) {
  return { id, revision: 1, vertices: new Float32Array([
    x0, -2, z, 0, 0, 1, x1, -2, z, 0, 0, 1,
    x1, 2, z, 0, 0, 1, x0, 2, z, 0, 0, 1,
  ]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}
function packet(transmission: number | undefined, roughness = 0): RenderPacket {
  return { geometries: [quad("left", -3, 0, -0.5), quad("right", 0, 3, -0.5), quad("glass", -2, 2, 0)],
    materials: [
      { id: "left", baseColor: [0, 0, 0], roughness: 1, metallic: 0, emissiveFactor: [0.3, 0.015, 0.005] },
      { id: "right", baseColor: [0, 0, 0], roughness: 1, metallic: 0, emissiveFactor: [0.005, 0.3, 0.015] },
      { id: "glass", baseColor: [1, 1, 1], roughness, metallic: 0, doubleSided: true,
        alphaMode: "OPAQUE", baseColorAlpha: 1, ior: 1.45,
        extendedParameters: normalizeExtendedMaterialParameters({ ior: 1.45, transmission: { factor: transmission ?? 0 } }) },
    ], instances: [
      { id: "left", geometry: "left", material: "left", transform: identity, castShadow: false },
      { id: "right", geometry: "right", material: "right", transform: identity, castShadow: false },
      ...(transmission === undefined ? [] : [{ id: "glass", geometry: "glass", material: "glass", transform: identity, castShadow: false }]),
    ] };
}
function pixel(image: readonly number[], x: number, y = HEIGHT / 2): number[] {
  return image.slice((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3);
}
export async function runSceneTransmissionGpuProbe() {
  const canvas = document.createElement("canvas"); document.querySelector("#canvases")!.append(canvas);
  canvas.style.width = "640px"; canvas.style.height = "384px";
  const capture = new FrameCaptureSession();
  const renderer = await bounded(PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    advancedMaterials: true, msaaSampleCount: 4,
    pipelines: { firstFrameMainKeys: ["plain/depth/ccw", "material/depth/double", "material/blend/double"] },
    frameCapture: { session: capture, readbacks: { requests: [{ resourceId: "present-color" }] } },
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    features: { toneMapping: "three-aces-r185", environment: false, fog: false, groundPlane: false, groundGrid: false,
      ambientOcclusion: false, screenSpaceReflection: false, volumetricFog: false, temporalAa: false,
      spatialAa: false, occlusionCulling: false, bloom: false, vignette: false, contactShadows: false },
  }));
  const view: RenderView = { width: WIDTH, height: HEIGHT, pixelRatio: 1, eye: [0, 0, 3], target: [0, 0, 0],
    extent: 4, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 1,
    environmentIntensity: 0, fog: null, lights: { directional: [], ambient: [] },
    near: 0.1, far: 30, verticalFovRadians: Math.PI / 4 };
  validatePbrRenderView(view);
  const results = [];
  try {
    for (const direct of [false, true]) {
      const frames = [];
      for (const [name, transmission, roughness] of [
        ["background", undefined, 0], ["opaque", 0, 0], ["glass", 1, 0], ["rough", 1, 0.65],
      ] as const) {
        await bounded(renderer.setPacketValidated(packet(transmission, roughness)));
        const metrics = await bounded(renderer.validateFrame({ ...view, authorDirectDisplay: direct }));
        if (!metrics) throw Error("No production frame submitted");
        renderer.render({ ...view, authorDirectDisplay: direct });
        const image = await readSharedDeepFrame(renderer, WIDTH, HEIGHT);
        if (!image.hdr.every(Number.isFinite)) throw Error(`Nonfinite ${name} color`);
        frames.push({ name, left: pixel(image.display, 60), right: pixel(image.display, 100),
          edgeLeft: pixel(image.display, 77), edgeRight: pixel(image.display, 82),
          hdrLeft: image.hdr.slice((HEIGHT / 2 * WIDTH + 60) * 3, (HEIGHT / 2 * WIDTH + 60) * 3 + 3),
          weightedOit: metrics.weightedOit, passCount: metrics.postProcessPasses });
      }
      const background = frames[0]!, opaque = frames[1]!, glass = frames[2]!, rough = frames[3]!;
      const preserved = background.left.every((value, channel) => Math.abs(value - glass.left[channel]!) <= 8)
        && background.right.every((value, channel) => Math.abs(value - glass.right[channel]!) <= 8);
      const blocked = opaque.left.every(value => value <= 2) && opaque.right.every(value => value <= 2);
      const contrast = (frame: typeof rough) => Math.abs(frame.edgeLeft[0]! - frame.edgeRight[0]!) + Math.abs(frame.edgeLeft[1]! - frame.edgeRight[1]!);
      results.push({ direct, passed: preserved && blocked && glass.weightedOit && contrast(rough) < contrast(glass),
        preserved, blocked, sharpContrast: contrast(glass), roughContrast: contrast(rough), frames });
    }
    return { passed: results.every(result => result.passed) && renderer.deviceDiagnostics.length === 0,
      width: WIDTH, height: HEIGHT, alpha: 1, alphaMode: "OPAQUE", ior: 1.45, environmentIntensity: 0,
      diagnostics: renderer.deviceDiagnostics, results };
  } finally { renderer.dispose(); }
}
document.querySelector<HTMLButtonElement>("#run")?.addEventListener("click", async event => {
  (event.currentTarget as HTMLButtonElement).disabled = true;
  let result;
  try { result = await runSceneTransmissionGpuProbe(); }
  catch (error) { result = { passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }; }
  document.querySelector("#result")!.textContent = JSON.stringify(result, null, 2);
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
});
