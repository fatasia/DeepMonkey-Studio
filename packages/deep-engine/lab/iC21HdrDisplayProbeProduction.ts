import * as THREE from "three";
import { DeepWebGpuBackend } from "../src/threeBridge/DeepWebGpuBackend.js";
import { createSharedSceneFixture, sharedProjection } from "./c8SharedSceneFixture.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";

export interface HdrDisplayProbeResult {
  webgpu: boolean;
  scenario: string;
  adapterNonFallback: boolean;
  sdrFormatMatch: boolean;
  capabilityPresent: boolean;
  hdrMode: string;
  policyReason: string;
  failClosed: boolean;
  canvasProbePerformed: boolean;
  framesRendered: number;
  deviceErrors: string[];
}

type Scenario = "sdr-default" | "explicit-fallback";

export async function runHdrDisplayProductionProbe(): Promise<HdrDisplayProbeResult> {
  const scenario = ((new URLSearchParams(location.search).get("scenario") ?? "sdr-default") === "explicit-fallback"
    ? "explicit-fallback" : "sdr-default") as Scenario;
  const deviceErrors: string[] = [];
  const fixture = createSharedSceneFixture();
  fixture.setStage("direct-diagnostic");
  const view = fixture.view(0, .5);
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 360;
  canvas.style.cssText = "width:640px;height:360px";
  document.getElementById("stage")!.append(canvas);
  let backend: DeepWebGpuBackend | undefined;
  try {
    backend = await DeepWebGpuBackend.create({
      canvas, gpu: navigator.gpu, projection: sharedProjection(), root: fixture.root, view,
      renderer: {
        ...(scenario === "explicit-fallback" ? { hdrDisplay: { enabled: true } as const } : {}),
        pipelines: { firstFrameSubset: true },
        features: { toneMapping: "three-aces-r185", environment: false, groundPlane: false, groundGrid: false,
          fog: false, ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
          bloom: false, vignette: false },
      },
    });
    const runtime = backend.runtime;
    if (!(runtime instanceof PbrRenderer)) throw Error("production PbrRenderer runtime required");
    const session = runtime.session;
    session.device.addEventListener("uncapturederror", event => deviceErrors.push(String(event.error?.message ?? event.error)));
    const capability = session.hdrDisplayCapability;
    const preferred = navigator.gpu.getPreferredCanvasFormat();
    let frames = 0;
    for (let frame = 0; frame < 12; frame++) {
      runtime.render(view);
      frames++;
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    return {
      webgpu: true, scenario,
      adapterNonFallback: session.adapterInfo?.isFallbackAdapter === false,
      sdrFormatMatch: session.format === preferred,
      capabilityPresent: capability !== undefined,
      hdrMode: capability?.policy.mode ?? "none",
      policyReason: capability?.policy.reason ?? "",
      failClosed: capability?.policy.failClosed === true,
      canvasProbePerformed: capability?.canvasProbePerformed === true,
      framesRendered: frames, deviceErrors,
    };
  } finally {
    backend?.dispose();
    fixture.dispose();
  }
}

void THREE;
