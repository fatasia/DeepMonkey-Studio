import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RenderPacket } from "../src/renderPacket.js";
import type { AuthorGridView } from "../src/webgpu/authorGridTypes.js";
import { integrationFixture, integrationView } from "./pbrDeformationIntegrationProbeFixture.js";
import { readIntegrationAttachments } from "./pbrDeformationIntegrationProbeReadback.js";

/** Observes the formal renderer's HDR attachment, never a substitute grid raster pass. */
export async function runAuthorGridProbe(canvas: HTMLCanvasElement) {
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    features: { environment: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
      temporalAa: false, occlusionCulling: false, bloom: false, vignette: false, fog: false },
  });
  const original = integrationFixture("skin").packet;
  const packet: RenderPacket = { geometries: original.geometries, materials: [original.materials[0]!],
    instances: [{ id: "occluder", geometry: original.geometries[0]!.id, material: original.materials[0]!.id,
      transform: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] }] };
  const grid: AuthorGridView = { model: [4,0,0,0, 0,4,0,0, 0,0,1,0, 0,0,-0.2,1], color: [1,1,1,0.5],
    texture: { id: "probe-grid", revision: 1, semantic: "baseColor", width: 2, height: 2, data: new Uint8Array(16).fill(255) } };
  const sample = (pixels: Float32Array, x: number) => Array.from(pixels.subarray((64 * 128 + x) * 8, (64 * 128 + x) * 8 + 3));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.015;
  const session = renderer.session, errors: string[] = [], results: Record<string, unknown> = {};
  session.device.pushErrorScope("validation");
  try {
    await renderer.setPacketValidated(packet);
    const draw = async (name: string, authorGrid: AuthorGridView) => {
      const metrics = renderer.render({ ...integrationView, authorGrid });
      if (!metrics) throw new Error("Grid probe frame was not rendered.");
      const preview = document.createElement("canvas"); preview.width = canvas.width; preview.height = canvas.height;
      preview.title = name; preview.getContext("2d")!.drawImage(canvas, 0, 0); document.querySelector("#previews")!.append(preview);
      const composite = (renderer as unknown as { transparency: { currentColor?: GPUTexture } }).transparency.currentColor;
      if (metrics.weightedOit && !composite) throw new Error("Transparent frame has no composite output.");
      const pixels = await readIntegrationAttachments(renderer, metrics.weightedOit ? composite : undefined);
      const values = { covered: sample(pixels, 46), open: sample(pixels, 90), metrics };
      results[name] = values; return values;
    };
    const opaque = await draw("opaque-depth", grid);
    const fog = await draw("fog", { ...grid, fog: { kind: "linear", color: [0,0,1], near: 0, far: 1 } });
    await renderer.setPacketValidated({ ...packet, materials: [{ ...packet.materials[0]!, alphaMode: "BLEND", baseColorAlpha: 0.5 }] });
    const blended = await draw("transparent-over-grid", grid);
    const valid = near(opaque.covered[0]!, 1) && near(opaque.covered[1]!, 0) && near(opaque.open[0]!, 0.5)
      && near(fog.open[0]!, 0) && near(fog.open[2]!, 0.5) && near(blended.covered[0]!, 0.75) && near(blended.covered[1]!, 0.25);
    results.passed = valid;
  } catch (error) { results.failure = String(error); }
  finally {
    const error = await session.device.popErrorScope(); if (error) errors.push(error.message);
    renderer.dispose();
  }
  return { ...results, passed: results.passed === true && errors.length === 0 && session.diagnostics.length === 0
    && session.resourceCount === 0, errors, diagnostics: session.diagnostics, resourcesAfterDispose: session.resourceCount };
}

const canvas = document.querySelector("#scene") as HTMLCanvasElement;
runAuthorGridProbe(canvas).then(result => { document.querySelector("#result")!.textContent = JSON.stringify(result, null, 2); });
