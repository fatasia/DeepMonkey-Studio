import golden from "../../deep-engine-native/tests/fixtures/runtime-package-prefiltered-ibl-v1.json";
import { validateRuntimePrefilteredIbl } from "../src/runtimePackage/environment.js";
import type { RuntimePrefilteredIbl } from "../src/runtimePackage/environmentTypes.js";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { integrationView } from "./pbrDeformationIntegrationProbeFixture.js";
import { readIntegrationAttachments } from "./pbrDeformationIntegrationProbeReadback.js";

const source = validateRuntimePrefilteredIbl(golden.payloads["environment.prefiltered.golden"], "environment.prefiltered.golden", 1);
function alternate(): RuntimePrefilteredIbl {
  const replace = (data: string) => {
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    for (let offset = 0; offset < bytes.length; offset += 8) {
      bytes.set([0, 0x30, 0, 0x34, 0, 0x3c], offset);
    }
    return btoa(String.fromCharCode(...bytes));
  };
  return { ...source, specular: { mips: source.specular.mips.map(mip => ({ ...mip, dataBase64: replace(mip.dataBase64) })) },
    diffuse: { mips: source.diffuse.mips.map(mip => ({ ...mip, dataBase64: replace(mip.dataBase64) })) } };
}
function difference(a: Float32Array, b: Float32Array) {
  let changedPixels = 0, maxError = 0, brightness = 0;
  for (let pixel = 0; pixel < 128 * 128; pixel++) {
    let error = 0;
    for (let channel = 0; channel < 3; channel++) {
      const index = pixel * 8 + channel;
      error = Math.max(error, Math.abs(a[index]! - b[index]!)); brightness += a[index]!;
    }
    if (error > 0.001) changedPixels++;
    maxError = Math.max(maxError, error);
  }
  return { changedPixels, maxError, brightness, finite: a.every(Number.isFinite) && b.every(Number.isFinite) };
}

export async function runPrefilteredIblProbe(canvas: HTMLCanvasElement) {
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "prefiltered-ibl", environment: source },
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    features: { environment: true, groundPlane: false, groundGrid: false, ambientOcclusion: false,
      temporalAa: false, occlusionCulling: false, bloom: false, vignette: false, fog: false },
  });
  const session = renderer.session, device = session.device, errors: string[] = [], counts: number[] = [];
  const scopes = ["validation", "out-of-memory", "internal"] as const;
  scopes.forEach(scope => device.pushErrorScope(scope));
  let failure: string | undefined, result: Record<string, unknown> = {}, passed = false;
  try {
    const original = materializeRuntimeRenderPacket(golden.payloads["scene.lod"], "$.packet");
    await renderer.setPacketValidated({ geometries: original.geometries, materials: [
      { id: "ibl-only", baseColor: [0.7, 0.7, 0.7], metallic: 0.4, roughness: 0.5, doubleSided: true },
    ], instances: [{ id: "ibl-plane", geometry: original.geometries[0]!.id, material: "ibl-only",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] });
    const view = { ...integrationView, lights: { directional: [{ directionWorld: [0, 0, -1] as const,
      color: [1, 1, 1] as const, intensity: 0, castShadow: false }] } };
    const frame = async () => {
      if (!renderer.render(view)) throw Error("IBL frame was not submitted.");
      const pixels = await readIntegrationAttachments(renderer); counts.push(session.resourceCount); return pixels;
    };
    const initial = await frame();
    const cancelled = new AbortController();
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: alternate() }, cancelled.signal);
    cancelled.abort();
    const cancellation = difference(await frame(), initial);
    let invalidRejected = false;
    try { await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: { ...source,
      brdfLut: { ...source.brdfLut, dataBase64: "invalid" } } }); } catch { invalidRejected = true; }
    const rejection = difference(await frame(), initial);
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: alternate() });
    const submit = device.queue.submit; let submissionRejected = false;
    try {
      device.queue.submit = () => { throw Error("IBL candidate submission rejected"); };
      try { renderer.render(view); } catch (error) {
        if (!String(error).includes("IBL candidate submission rejected")) throw error;
        submissionRejected = true;
      }
    } finally { device.queue.submit = submit; }
    const submissionRollback = difference(await frame(), initial);
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: alternate() });
    const changed = difference(await frame(), initial);
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: source });
    const restored = difference(await frame(), initial);
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: alternate() });
    await renderer.stageEnvironment({ kind: "prefiltered-ibl", environment: source });
    const latest = difference(await frame(), initial);
    result = { cancellation, invalidRejected, rejection, submissionRejected, submissionRollback, changed, restored, latest, counts };
    passed = invalidRejected && submissionRejected && changed.finite && changed.changedPixels > 20 && changed.brightness > 0
      && [cancellation, rejection, submissionRollback, restored, latest].every(value => value.finite && value.maxError === 0)
      && counts.every(count => count === counts[0]);
  } catch (error) { failure = String(error); }
  finally {
    for (const _scope of scopes) { const error = await device.popErrorScope(); if (error) errors.push(error.message); }
    renderer.dispose();
  }
  return { passed: passed && !failure && session.adapterInfo?.isFallbackAdapter === false && errors.length === 0 && session.diagnostics.length === 0 && session.resourceCount === 0,
    ...result, failure, errors, adapter: session.adapterInfo, diagnostics: session.diagnostics,
    remainingResources: session.resourceCount, packageHash: golden.packageHash.value,
    scope: "Production PbrRenderer, shared synthetic Native IBL fixture, same id/revision with different texels; no direct light." };
}
