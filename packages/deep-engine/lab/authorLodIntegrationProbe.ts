import golden from "../../deep-engine-native/tests/fixtures/runtime-package-author-lod-v1.json";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import type { RenderPacket, RenderAuthorSelectedLodProfile } from "../src/renderPacket.js";
import { PbrRenderer, type FrameMetrics } from "../src/webgpu/pbrRenderer.js";
import { integrationView } from "./pbrDeformationIntegrationProbeFixture.js";
import { readIntegrationAttachments } from "./pbrDeformationIntegrationProbeReadback.js";

const original = materializeRuntimeRenderPacket(golden.payloads["scene.author-lod"], "$.packet");
function selection(revision: number, mode: "initial" | "next" | "none" | "multi"): RenderPacket {
  // The golden silhouettes are single planes; enable two-sided shadow casting for this raster comparison.
  return { ...original, materials: original.materials.map(material => ({ ...material, doubleSided: true })), instances: original.instances.map(instance => {
    const profile = instance.lod as RenderAuthorSelectedLodProfile;
    const selectedLevels = mode === "initial" ? profile.selectedLevels : mode === "none" ? []
      : mode === "multi" ? [0, 2] : profile.selectedLevels.map(index => (index + 1) % 3).sort();
    return { ...instance, lod: { ...profile, revision, selectedLevels } };
  }) };
}
function referencePacket(packet: RenderPacket): RenderPacket {
  return { ...packet, instances: packet.instances.flatMap(instance => {
    const { lod, ...source } = instance;
    const profile = lod as RenderAuthorSelectedLodProfile;
    return profile.selectedLevels.map(index => ({ ...source, id: `${source.id}/level-${index}`,
      geometry: profile.levels[index]!.geometry }));
  }) };
}
async function observe(renderer: PbrRenderer, metrics: FrameMetrics) {
  const color = (renderer as unknown as { transparency: { currentColor?: GPUTexture } }).transparency.currentColor;
  if (metrics.weightedOit && !color) throw Error("Missing production OIT output.");
  return readIntegrationAttachments(renderer, metrics.weightedOit ? color : undefined);
}
function compare(actual: Float32Array, expected: Float32Array) {
  let hdrMaxError = 0, shadowMaxError = 0, coloredPixels = 0, shadowPixels = 0;
  for (let pixel = 0; pixel < 128 * 128; pixel++) {
    const offset = pixel * 8;
    for (let channel = 0; channel < 3; channel++)
      hdrMaxError = Math.max(hdrMaxError, Math.abs(actual[offset + channel]! - expected[offset + channel]!));
    shadowMaxError = Math.max(shadowMaxError, Math.abs(actual[offset + 6]! - expected[offset + 6]!));
    if (actual[offset]! + actual[offset + 1]! + actual[offset + 2]! > .01) coloredPixels++;
    if (actual[offset + 6]! < .99) shadowPixels++;
  }
  return { hdrMaxError, shadowMaxError, coloredPixels, shadowPixels,
    finite: actual.every(Number.isFinite) && expected.every(Number.isFinite) };
}

export async function runAuthorLodIntegrationProbe(canvas: HTMLCanvasElement, referenceCanvas: HTMLCanvasElement) {
  const options = { shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    features: { environment: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
      temporalAa: false, occlusionCulling: false, bloom: false, vignette: false, fog: false } };
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, options);
  let reference: PbrRenderer | undefined;
  const session = renderer.session, queue = session.device.queue, write = queue.writeBuffer;
  const updates: string[] = [], results: unknown[] = [], errors: string[] = [];
  let failure: string | undefined, retry = false;
  const scopes = ["validation", "out-of-memory", "internal"] as const;
  scopes.forEach(scope => session.device.pushErrorScope(scope));
  try {
    reference = await PbrRenderer.create(referenceCanvas, navigator.gpu, new AbortController().signal, options);
    scopes.forEach(scope => reference!.session.device.pushErrorScope(scope));
    queue.writeBuffer = (...args: Parameters<GPUQueue["writeBuffer"]>) => {
      updates.push(args[0].label); write.apply(queue, args);
    };
    for (const [index, mode] of (["initial", "next", "none", "multi"] as const).entries()) {
      const packet = selection(index + 4, mode);
      updates.length = 0;
      if (index === 0) await renderer.setPacketValidated(packet);
      else renderer.updateInstances({ materials: packet.materials, instances: packet.instances });
      if (index === 1) {
        const submit = queue.submit;
        try {
          queue.submit = () => { throw Error("Author LOD probe rejected submission"); };
          try { renderer.render(integrationView); } catch (error) { if (String(error).includes("probe rejected")) retry = true; else throw error; }
        } finally { queue.submit = submit; }
      }
      const metrics = renderer.render(integrationView);
      if (!metrics) throw Error("Author LOD frame was not rendered.");
      const actual = await observe(renderer, metrics);
      await reference.setPacketValidated(referencePacket(packet));
      const expectedMetrics = reference.render(integrationView);
      if (!expectedMetrics) throw Error("Reference frame was not rendered.");
      const comparison = compare(actual, await observe(reference, expectedMetrics));
      const geometryWrites = updates.filter(label => ["Deep vertices", "Deep indices", "Deep tangents"].includes(label)).length;
      const instanceWrites = updates.filter(label => label === "Deep packet instances").length;
      const passed = comparison.finite && comparison.hdrMaxError < .002 && comparison.shadowMaxError < .0001
        && (index === 0 || geometryWrites === 0 && instanceWrites === 0)
        && (mode === "none" ? comparison.coloredPixels === 0 && comparison.shadowPixels === 0
          : comparison.coloredPixels > 20 && comparison.shadowPixels > 20);
      results.push({ mode, passed, ...comparison, geometryWrites, instanceWrites, metrics });
    }
  } catch (error) { failure = String(error); }
  finally {
    queue.writeBuffer = write;
    for (let i = 0; i < scopes.length; i++) {
      const error = await session.device.popErrorScope(); if (error) errors.push(error.message);
      if (reference) { const error = await reference.session.device.popErrorScope(); if (error) errors.push(error.message); }
    }
    renderer.dispose(); reference?.dispose();
  }
  return { passed: !failure && retry && results.length === 4 && results.every(result => (result as { passed: boolean }).passed)
    && errors.length === 0 && session.diagnostics.length === 0 && reference?.session.diagnostics.length === 0
    && session.resourceCount === 0 && reference?.session.resourceCount === 0,
    results, retry, errors, failure, adapter: session.adapterInfo,
    diagnostics: [...session.diagnostics, ...(reference?.session.diagnostics ?? [])],
    remainingResources: session.resourceCount + (reference?.session.resourceCount ?? 0),
    scope: "Formal PbrRenderer; shared Native golden with two-sided planar casters; selected geometry reference; HDR/shadow and incremental upload observation" };
}

const canvas = document.querySelector<HTMLCanvasElement>("#actual")!;
const reference = document.querySelector<HTMLCanvasElement>("#reference")!;
runAuthorLodIntegrationProbe(canvas, reference).then(result => {
  document.querySelector("pre")!.textContent = JSON.stringify(result, null, 2);
  document.title = result.passed ? "Author LOD Integration PASS" : "Author LOD Integration FAIL";
});
