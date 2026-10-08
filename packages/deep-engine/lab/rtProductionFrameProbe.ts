/// <reference types="@webgpu/types" />
import { PbrRenderer, type RenderView } from "../src/webgpu/pbrRenderer.js";
import type { RenderPacket } from "../src/renderPacket.js";
import { buildReflectionScene, REFLECTION_EYE, REFLECTION_TARGET } from "./reflectionRayGpuCases.js";

function packet(): RenderPacket {
  const scene = buildReflectionScene();
  return {
    geometries: scene.blasList.map(blas => {
      const vertices: number[] = [], indices: number[] = [];
      for (let i = 0; i < blas.indices.length; i += 3) {
        const corners = [0, 1, 2].map(k => Array.from(blas.vertices.slice(blas.indices[i + k]! * 3, blas.indices[i + k]! * 3 + 3)));
        const a = corners[0]!, b = corners[1]!, c = corners[2]!;
        const u = b.map((v, k) => v - a[k]!), v = c.map((v, k) => v - a[k]!);
        const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const length = Math.hypot(...n); const normal = n.map(value => value / length);
        for (const corner of corners) { indices.push(indices.length); vertices.push(...corner, ...normal); }
      }
      return { id: blas.id, revision: 1, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
    }),
    materials: [{ id: "reflective", baseColor: [0.6, 0.3, 0.12], roughness: 0.25, metallic: 0.6 }],
    instances: scene.blasList.map(blas => ({ id: blas.id, geometry: blas.id, material: "reflective",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })),
  };
}

async function leg(rayTracedReflections: boolean) {
  const canvas = document.createElement("canvas");
  canvas.style.width = "1920px"; canvas.style.height = "1080px";
  document.querySelector("#canvases")!.append(canvas);
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    rayTracedShadowScene: buildReflectionScene().tlas.packed, msaaSampleCount: 4,
    features: { rayTracedShadows: true, rayTracedReflections, screenSpaceReflection: true,
      fog: false, volumetricFog: false, groundGrid: false, groundPlane: false, bloom: false,
      ambientOcclusion: false, temporalAa: false, spatialAa: false, vignette: false, occlusionCulling: false },
  });
  const view: RenderView = { width: 1920, height: 1080, pixelRatio: 1, extent: 8,
    eye: REFLECTION_EYE, target: REFLECTION_TARGET, background: [0.005, 0.01, 0.015], floor: [0, 0, 0],
    exposure: 1, roughness: 0.25, fog: null, near: 0.1, far: 80, verticalFovRadians: Math.PI / 4 };
  try {
    await renderer.setPacketValidated(packet());
    const warm = [];
    for (let i = 0; i < 10; i++) { warm.push(await renderer.validateFrame(view)); await new Promise(resolve => setTimeout(resolve, 0)); }
    renderer.setDiagnosticsSampling(true);
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now(), frame = await renderer.validateFrame(view);
      await renderer.gpuTimer.collect(frame.frame, frame.frame);
      samples.push({ wallMs: performance.now() - start, rt: frame.rtReflections, frame: frame.frame });
    }
    return { rayTracedReflections, width: canvas.width, height: canvas.height, samples,
      warmRt: warm.map(frame => frame.rtReflections), telemetry: renderer.performanceTelemetry.snapshot(),
      diagnostics: renderer.deviceDiagnostics.map(value => value.message), timingDiagnostics: renderer.gpuTimer.diagnostics };
  } finally { renderer.dispose(); canvas.remove(); }
}

export async function runRtProductionFrameProbe() {
  const baseline = await leg(false), twoBounce = await leg(true);
  return { purpose: "Real production PbrRenderer SSR versus SSR + two-bounce RT, 1080p, 4x MSAA, three-instance fixture",
    success: twoBounce.samples.every(sample => sample.rt?.dispatched && sample.rt.indirectDispatched)
      && !baseline.diagnostics.length && !twoBounce.diagnostics.length,
    baseline, twoBounce };
}

document.querySelector<HTMLButtonElement>("#run")?.addEventListener("click", async event => {
  (event.currentTarget as HTMLButtonElement).disabled = true;
  let result;
  try { result = await runRtProductionFrameProbe(); }
  catch (error) { result = { success: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }; }
  document.querySelector("#result")!.textContent = JSON.stringify(result, null, 2);
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
});
