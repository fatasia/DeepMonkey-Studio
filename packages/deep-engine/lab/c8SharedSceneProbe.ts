/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { DeepWebGpuBackend } from "../src/threeBridge/DeepWebGpuBackend.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { installThreeMaterialMath } from "../../../apps/web/src/viewer/threeMaterialMath.js";
import { installThreeDisplayToneMapping } from "../../../apps/web/src/viewer/threeDisplayToneMapping.js";
import { createSharedSceneFixture, sharedProjection, sharedProfile, type SharedStage } from "./c8SharedSceneFixture.js";
import { bounded, readSharedDeepFrame } from "./c8SharedSceneReadback.js";

export async function runSharedSceneProbe() {
  const fixture = createSharedSceneFixture(), canvas = document.createElement("canvas");
  canvas.width = sharedProfile.width; canvas.height = sharedProfile.height;
  const errors: string[] = [], frames = [];
  const lifetime = new AbortController();
  let backend: DeepWebGpuBackend | undefined, renderer: THREE.WebGLRenderer | undefined, hdrTarget: THREE.WebGLRenderTarget | undefined;
  let device: GPUDevice | undefined, scopes = 0;
  try {
    installThreeMaterialMath(); installThreeDisplayToneMapping();
    renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(sharedProfile.width, sharedProfile.height, false); renderer.setPixelRatio(1); renderer.setClearColor(0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
    hdrTarget = new THREE.WebGLRenderTarget(sharedProfile.width, sharedProfile.height, { type: THREE.FloatType });
    const projection = sharedProjection(), firstView = fixture.view(0, .5);
    backend = await bounded<DeepWebGpuBackend>(DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu, projection, root: fixture.root, view: firstView, signal: lifetime.signal,
      renderer: { shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } }, pipelines: { firstFrameSubset: true, deferDeformation: true },
        frameCapture: { session: new FrameCaptureSession(), readbacks: { requests: [{ resourceId: "present-color" }] } },
        features: { toneMapping: "three-aces-r185", environment: false, groundPlane: false, groundGrid: false, fog: false, ambientOcclusion: false,
          temporalAa: false, spatialAa: false, occlusionCulling: false, bloom: false, vignette: false } } }).then(created => {
      if (lifetime.signal.aborted) created.dispose(); return created;
    }));
    if (!(backend.runtime instanceof PbrRenderer)) throw Error("Shared root must use the formal production PbrRenderer factory");
    const runtime = backend.runtime; device = runtime.session.device;
    if (runtime.session.adapterInfo?.isFallbackAdapter !== false) throw Error("A non-fallback production adapter is required");
    device.addEventListener("uncapturederror", event => errors.push(event.error.message));
    for (const filter of ["validation", "out-of-memory", "internal"] as const) { device.pushErrorScope(filter); scopes++; }
    // First publication is production create/prepareScene. Subsequent packets
    // are staged by the same backend sync API, with the original author root.
    for (const stage of ["strict-emissive", "direct-diagnostic"] as SharedStage[]) {
      fixture.setStage(stage);
      for (let camera = 0; camera < 2; camera++) for (const exposure of sharedProfile.exposures) {
        const view = fixture.view(camera, exposure), rootHash = fixture.rootHash();
        const publication = await bounded(backend.sync(fixture.root, 1, lifetime.signal, view));
        if (publication.status !== "committed" || publication.packet.instances.length !== 6) throw Error("Production shared-root packet publication failed");
        const packetHash = sha256Utf8(JSON.stringify(publication.packet));
        renderer.toneMappingExposure = exposure; renderer.setRenderTarget(hdrTarget); renderer.render(fixture.scene, fixture.camera);
        const floats = new Float32Array(sharedProfile.width * sharedProfile.height * 4);
        renderer.readRenderTargetPixels(hdrTarget, 0, 0, sharedProfile.width, sharedProfile.height, floats);
        const threeHdr = new Float32Array(sharedProfile.width * sharedProfile.height * 3);
        for (let y = 0; y < sharedProfile.height; y++) for (let x = 0; x < sharedProfile.width; x++) for (let lane = 0; lane < 3; lane++) {
          threeHdr[(y * sharedProfile.width + x) * 3 + lane] = floats[((sharedProfile.height - 1 - y) * sharedProfile.width + x) * 4 + lane]!;
        }
        renderer.setRenderTarget(null); renderer.render(fixture.scene, fixture.camera);
        const gl = renderer.getContext(), bytes = new Uint8Array(sharedProfile.width * sharedProfile.height * 4), threeDisplay = new Uint8Array(bytes.length);
        gl.readPixels(0, 0, sharedProfile.width, sharedProfile.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        for (let y = 0; y < sharedProfile.height; y++) threeDisplay.set(bytes.subarray(y * sharedProfile.width * 4, (y + 1) * sharedProfile.width * 4), (sharedProfile.height - 1 - y) * sharedProfile.width * 4);
        if (gl.getError() !== gl.NO_ERROR || errors.length) throw Error("Actual Three shared scene draw failed");
        const metrics = backend.render(view); if (!metrics || metrics.drawCalls < 2 || metrics.triangles < 1000) throw Error(`Production Deep shared scene did not draw the six-instance batched frame: ${JSON.stringify(metrics)}`);
        const deep = await readSharedDeepFrame(runtime, sharedProfile.width, sharedProfile.height);
        const profileHash = sha256Utf8(JSON.stringify({ ...sharedProfile, stage, camera, exposure, lights: view.lights }));
        frames.push({ name: `${stage}/${sharedProfile.cameras[camera]!.name}/exposure-${exposure}`, stage, camera, exposure,
          rootHash, packetHash, profileHash, three: { hdr: Array.from(threeHdr), display: Array.from(threeDisplay), rootHash, profileHash,
            drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
          deep: { ...deep, rootHash: fixture.rootHash(), profileHash, drawCalls: metrics.drawCalls, triangles: metrics.triangles } });
      }
    }
    while (scopes > 0) { scopes--; const error = await device.popErrorScope(); if (error) errors.push(error.message); }
    if (errors.length) throw Error(errors.join("\n"));
    return { width: sharedProfile.width, height: sharedProfile.height, frames, errors, profile: sharedProfile,
      diagnostics: { productionBackend: backend.id, deviceState: runtime.session.state, adapter: runtime.session.adapterInfo } };
  } finally {
    lifetime.abort();
    while (scopes > 0 && device) { scopes--; await device.popErrorScope().catch(() => undefined); }
    backend?.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); hdrTarget?.dispose(); fixture.dispose();
  }
}
