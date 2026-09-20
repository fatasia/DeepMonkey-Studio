import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { PbrRenderer, type RenderView } from "../src/webgpu/pbrRenderer.js";
import type { PbrRendererFeatureOptions } from "../src/webgpu/pbrRendererFeatures.js";
import { spherePacket } from "../src/webgpu/spherePacket.js";
import { runR12ShaderPackageCaptureProbe } from "./r12ShaderPackageCaptureProbe.js";

const disabled: PbrRendererFeatureOptions = {
  environment: false, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, screenSpaceReflection: false, temporalAa: false,
  spatialAa: false, occlusionCulling: false, bloom: false, vignette: false,
};
const view: RenderView = { width: 192, height: 128, pixelRatio: 1,
  eye: [3, 2, 4], target: [0, 0, 0], extent: 4, background: [0.03, 0.04, 0.05],
  floor: [0.2, 0.2, 0.2], exposure: 1, roughness: 0.4 };

/** Records production PbrRenderer submissions, not manually synthesized capture records. */
export async function runR12FrameCaptureProbe() {
  const cases = [];
  for (const scenario of [
    { name: "direct", features: disabled, transparent: false },
    { name: "ssr-only", features: { ...disabled, screenSpaceReflection: true }, transparent: false },
    { name: "defaults", features: {}, transparent: false },
    { name: "transparent", features: {}, transparent: true },
  ]) {
    const canvas = document.createElement("canvas"); document.body.append(canvas);
    const capture = new FrameCaptureSession();
    let renderer: PbrRenderer | undefined;
    try {
      renderer = await PbrRenderer.create(canvas, navigator.gpu, AbortSignal.timeout(60_000),
        { features: scenario.features, frameCapture: { session: capture } });
      const packet = spherePacket(new Float32Array([0, 0, 0, 1, 0.3, 0.5, 0.8, 0.2, 0.4, 0, 0, 0]));
      await renderer.setPacketValidated(scenario.transparent ? { ...packet,
        materials: packet.materials.map(material => ({ ...material, alphaMode: "BLEND" as const, baseColorAlpha: 0.5 })) } : packet);
      const metrics = [];
      for (let frame = 0; frame < 2; frame++) {
        metrics.push(await renderer.validateFrame(view));
        await renderer.session.device.queue.onSubmittedWorkDone();
      }
      const records = capture.records();
      const expectedPasses = scenario.name === "direct" ? ["opaque"]
        : scenario.name === "ssr-only" ? ["opaque", "screen-space-reflection-trace", "screen-space-reflection-composite", "present"]
        : ["opaque", "ambient-occlusion", "apply-ambient-occlusion",
          ...(scenario.transparent ? ["transparent-oit", "composite-oit"] : []), "temporal-aa", "bloom", "present"];
      const checks = {
        twoCommittedFrames: records.length === 2 && capture.activeFrameId === undefined,
        planHashPresent: records.every(record => !!record.planHash),
        submittedTimeline: records.every(record => record.markers.map(marker => marker.markerId).join(",") === "encode-start,submit,submitted"),
        executorPresent: records.every(record => record.passes.length > 0 && record.passes.every(pass => !!pass.executor)),
        exactPassSequence: records.every(record => record.passes.map(pass => pass.passId).join(",") === expectedPasses.join(",")),
        noGpuDiagnostics: renderer.session.diagnostics.length === 0,
        transparentExecuted: metrics.every(metric => metric.weightedOit === scenario.transparent),
      };
      cases.push({ name: scenario.name, success: Object.values(checks).every(Boolean), checks,
        adapter: renderer.session.adapterInfo, metrics, records, gpuQueueCompleted: true });
    } catch (error) {
      cases.push({ name: scenario.name, success: false, error: error instanceof Error ? error.stack : String(error), records: capture.records() });
    } finally { renderer?.dispose(); canvas.remove(); }
  }
  const shaderPackage = await runR12ShaderPackageCaptureProbe();
  return { success: cases.every(entry => entry.success) && shaderPackage.success, cases, shaderPackage,
    sourceMap: "unverified: built-in PBR passes do not consume a DeepShaderPackageV2; no invented bindings",
    scope: "Real GPU encode/submit and validation; not resource snapshot/readback or visual quality acceptance" };
}
