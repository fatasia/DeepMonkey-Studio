import { PbrRenderer, type FrameMetrics } from "../src/webgpu/pbrRenderer.js";
import { integrationFixture, integrationView, type IntegrationKind } from "./pbrDeformationIntegrationProbeFixture.js";
import { readIntegrationAttachments, summarizeIntegrationPixels } from "./pbrDeformationIntegrationProbeReadback.js";
import { integrationMaterialFixture } from "./pbrDeformationIntegrationProbeMaterials.js";
import { integrationEffectsPassesComplete, INTEGRATION_EFFECTS_UNVERIFIED } from "./pbrDeformationIntegrationProbeAssertions.js";

export type IntegrationVariant = "baseline" | "materials-effects";

/** Runs production renderer creation, packet publication and complete frame submission. */
export async function runPbrDeformationIntegrationProbe(canvas: HTMLCanvasElement, kind: IntegrationKind,
  variant: IntegrationVariant = "baseline", capture?: (name: string, canvas: HTMLCanvasElement) => void) {
  const effects = variant === "materials-effects";
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    deformation: true, shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    features: { environment: false, fog: false, groundPlane: false, groundGrid: false,
      ambientOcclusion: effects, temporalAa: effects, occlusionCulling: effects, bloom: false, vignette: false },
  });
  const session = renderer.session, fixture = effects ? integrationMaterialFixture(kind) : integrationFixture(kind);
  const observations: Array<ReturnType<typeof summarizeIntegrationPixels> & { name: string; metrics: FrameMetrics }> = [];
  const errors: string[] = [];
  let rejectedSubmission = false, shadowChangedPixels = 0, failure: string | undefined;
  for (const filter of ["validation", "out-of-memory", "internal"] as const) session.device.pushErrorScope(filter);
  try {
    await renderer.setPacketValidated(fixture.packet);
    let baseline: Float32Array | undefined;
    for (const name of effects ? ["baseline", "moved", "settled", "history-1", "history-2"] : ["baseline", "moved", "settled"]) {
      if (name === "moved") {
        renderer.updateInstances(fixture.moved);
        const queue = session.device.queue, submit = queue.submit;
        try {
          queue.submit = () => { throw new Error("Probe cancelled before submission"); };
          try { renderer.render(integrationView); }
          catch (error) { if (String(error).includes("Probe cancelled")) rejectedSubmission = true; else throw error; }
        } finally { queue.submit = submit; }
      }
      const metrics = renderer.render(integrationView);
      if (!metrics) throw new Error("Production renderer did not produce a frame.");
      capture?.(name, canvas);
      const pixels = await readIntegrationAttachments(renderer);
      observations.push({ name, metrics, ...summarizeIntegrationPixels(pixels) });
      if (name === "baseline") baseline = pixels;
      if (name === "moved") for (let pixel = 0; pixel < 128 ** 2; pixel++)
        if (Math.abs(pixels[pixel * 8 + 6]! - baseline![pixel * 8 + 6]!) > 0.01) shadowChangedPixels++;
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    for (let scope = 0; scope < 3; scope++) {
      const error = await session.device.popErrorScope(); if (error) errors.push(error.message);
    }
    renderer.dispose();
  }
  const [baseline, moved, settled] = observations;
  const expectedMotionX = -0.7 / (6 * Math.tan(0.5));
  const passed = !failure && errors.length === 0 && session.diagnostics.length === 0 && session.resourceCount === 0
    && session.adapterInfo?.isFallbackAdapter === false && rejectedSubmission && shadowChangedPixels > 50
    && observations.length === (effects ? 5 : 3) && observations.every(value => value.finite && value.channels.every(channel => channel.pixels > 50)
      && value.shadowPixels > 50 && value.metrics.frustumCulledBatches + value.metrics.hiZOccludedBatches >= 1)
    && moved!.channels[0]!.centroidX - baseline!.channels[0]!.centroidX > 20
    && Math.abs(moved!.channels[0]!.motionX - expectedMotionX) < 0.002
    && Math.abs(baseline!.channels[0]!.motionX) < 0.001 && Math.abs(settled!.channels[0]!.motionX) < 0.001
    && [1, 2].every(channel => observations.every(value => Math.abs(value.channels[channel]!.centroidX - baseline!.channels[channel]!.centroidX) < (effects ? 1 : 1e-6)
      && Math.abs(value.channels[channel]!.motionX) < 0.001))
    && (!effects || observations.some(value => value.metrics.hiZOccludedBatches >= 1)
      && observations.every(value => integrationEffectsPassesComplete(value.metrics)));
  return { passed, kind, variant, observations, expectedMotionX, rejectedSubmission, shadowChangedPixels,
    adapter: session.adapterInfo, errors, diagnostics: session.diagnostics, remainingResources: session.resourceCount,
    ...(effects ? { expectedEffectsPasses: "HiZ mip levels + AO 4 + TAA 1 + OIT 2 + spatial AA 1", unverified: INTEGRATION_EFFECTS_UNVERIFIED } : {}),
    ...(failure ? { failure } : {}), scope: "Production PbrRenderer deformation:true; mixed static/two-pose, HDR/shadow/motion/culling, failed-submit retry" };
}
