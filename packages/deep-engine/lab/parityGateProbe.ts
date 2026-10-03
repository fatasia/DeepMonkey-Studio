/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { DeepWebGpuBackend } from "../src/threeBridge/DeepWebGpuBackend.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { DEFAULT_DISPLAY_CONTRACT } from "../../contracts/src/displayContract.js";
import { projectStudioDeepLights } from "./parityGateLightsHost.js";
import { sharedProjection } from "./c8SharedSceneFixture.js";
import { bounded, readSharedDeepFrame } from "./c8SharedSceneReadback.js";
import { createParityScene, createExtendedLobeProbe, parityProfile, PARITY_EXTENDED_LOBES, PARITY_SCENARIO_IDS, type ParityScenarioId, type ParityScene } from "./parityGateScenes.js";
import { createThreeParityContext, renderThreeFrame } from "./parityGateThree.js";

/** 记录 Deep 桥对扩展 PBR 瓣的真实 fail-closed 行为，作为"已知缺口"的机器证据（不需要 GPU）。 */
export function probeExtendedLobeGaps() {
  return PARITY_EXTENDED_LOBES.map(lobe => {
    const probe = createExtendedLobeProbe(lobe);
    try {
      const result = sharedProjection().project(probe.root, { cameraLayerMask: 1 });
      return { lobe, projected: result.ok, issues: result.ok ? [] : result.issues.map(issue => ({ code: issue.code, feature: issue.feature })) };
    } finally { probe.dispose(); }
  });
}

function deepView(spec: ParityScene): RenderView {
  const lights = projectStudioDeepLights(spec.scene, 1, spec.shadows);
  if (lights.issues.length) throw Error(`Parity scene light projection failed: ${JSON.stringify(lights.issues)}`);
  const view: RenderView = { eye: [...spec.eye], target: [...spec.target], up: [...parityProfile.up], extent: 4, background: [0, 0, 0], floor: [0, 0, 0],
    width: parityProfile.width, height: parityProfile.height, pixelRatio: 1, exposure: parityProfile.exposure, roughness: .5,
    environmentIntensity: spec.environment ? DEFAULT_DISPLAY_CONTRACT.environment.environmentIntensity : 0, fog: null,
    verticalFovRadians: parityProfile.verticalFovRadians, near: parityProfile.near, far: parityProfile.far, lights: lights.lights,
    authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0 } } };
  return spec.post?.bloom ? { ...view, postProcess: { bloom: true, authorBloom: { strength: spec.post.bloom.strength, threshold: spec.post.bloom.threshold } } } : view;
}

async function runDeepFrame(spec: ParityScene, signal: AbortSignal, errors: string[]) {
  const canvas = document.createElement("canvas"); canvas.width = parityProfile.width; canvas.height = parityProfile.height;
  const view = deepView(spec), projection = sharedProjection();
  const shadowSize = spec.shadows ? DEFAULT_DISPLAY_CONTRACT.shadow.mapSize : 128;
  const backend = await bounded(DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu, projection, root: spec.root, view, signal,
    renderer: { shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: shadowSize } }, pipelines: { firstFrameSubset: true, deferDeformation: true },
      // 场景链路镜像:three 侧 MSAA 只在 antialias 场景启用(parityGateThree),Deep 侧同表。
      msaaSampleCount: spec.post?.antialias === true ? 4 : 1,
      frameCapture: { session: new FrameCaptureSession(), readbacks: { requests: [{ resourceId: "present-color" }] } },
      ...(spec.environment ? { environment: { kind: "radiance-hdr" as const, image: spec.environment, ...(spec.environmentOptions ? { options: spec.environmentOptions } : {}) } } : {}),
      features: { toneMapping: DEFAULT_DISPLAY_CONTRACT.toneMapping.operator, environment: spec.environment !== undefined, groundPlane: false, groundGrid: false, fog: false,
        ambientOcclusion: false, contactShadows: false, temporalAa: false, spatialAa: spec.post?.antialias === true, occlusionCulling: false, bloom: spec.post?.bloom !== undefined, vignette: false } } }));
  let device: GPUDevice | undefined, scopes = 0;
  try {
    if (!(backend.runtime instanceof PbrRenderer)) throw Error("Parity gate requires the formal production PbrRenderer");
    const runtime = backend.runtime; device = runtime.session.device;
    if (runtime.session.adapterInfo?.isFallbackAdapter !== false) throw Error("A non-fallback production adapter is required");
    device.addEventListener("uncapturederror", event => errors.push(event.error.message));
    for (const filter of ["validation", "out-of-memory", "internal"] as const) { device.pushErrorScope(filter); scopes++; }
    const publication = await bounded(backend.sync(spec.root, 1, signal, view));
    if (publication.status !== "committed") throw Error(`Deep parity packet publication failed: ${publication.status}`);
    const metrics = backend.render(view);
    if (!metrics || metrics.drawCalls < 1 || metrics.triangles < 100) throw Error(`Deep parity scene did not draw: ${JSON.stringify(metrics)}`);
    const frame = await readSharedDeepFrame(runtime, parityProfile.width, parityProfile.height);
    while (scopes > 0) { scopes--; const error = await device.popErrorScope(); if (error) errors.push(error.message); }
    return { ...frame, drawCalls: metrics.drawCalls, triangles: metrics.triangles, packetHash: sha256Utf8(JSON.stringify(publication.packet)),
      adapter: runtime.session.adapterInfo, shadowTier: metrics.shadowTier, shadowMapSize: metrics.shadowMapSize };
  } finally {
    while (scopes > 0 && device) { scopes--; await device.popErrorScope().catch(() => undefined); }
    backend.dispose();
  }
}

export async function runParityGateProbe(options: { readonly scenarios?: readonly ParityScenarioId[] } = {}) {
  const ids = options.scenarios ?? PARITY_SCENARIO_IDS, errors: string[] = [], lifetime = new AbortController();
  const three = createThreeParityContext(), scenarios = [];
  try {
    for (const id of ids) {
      const spec = createParityScene(id);
      try {
        const threeFrame = await renderThreeFrame(three, spec);
        const deepFrame = await runDeepFrame(spec, lifetime.signal, errors);
        if (errors.length || three.errors.length) throw Error(`${id}: ${[...errors, ...three.errors].join("\n")}`);
        scenarios.push({ id, width: parityProfile.width, height: parityProfile.height, three: threeFrame, deep: deepFrame });
      } finally { spec.dispose(); }
    }
    return { width: parityProfile.width, height: parityProfile.height, scenarios, errors, extendedLobeGaps: probeExtendedLobeGaps(),
      profile: { exposure: parityProfile.exposure, toneMapping: DEFAULT_DISPLAY_CONTRACT.toneMapping.operator, shadow: DEFAULT_DISPLAY_CONTRACT.shadow, bloom: DEFAULT_DISPLAY_CONTRACT.bloom } };
  } finally { lifetime.abort(); three.dispose(); }
}
export type ParityGateRun = Awaited<ReturnType<typeof runParityGateProbe>>;
export type { THREE };
