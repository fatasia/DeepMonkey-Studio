import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { prepareRenderPacket, type RenderPacket } from "../src/renderPacket.js";
import { createPacketResidencyLoader } from "../src/webgpu/packetResidencyLoader.js";
import type { GpuRenderResidencyRuntime } from "../src/webgpu/gpuRenderResidencyRuntime.js";
import { integrationView } from "./pbrDeformationIntegrationProbeFixture.js";
import { readLocalSpotAtlas } from "./localSpotLodReadback.js";
import { readIntegrationAttachments } from "./pbrDeformationIntegrationProbeReadback.js";
import { observeMeshletCommands } from "./packetMeshletCommands.js";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function packet(selectedLevels: number[], revision: number, meshlets: boolean, directional: boolean): RenderPacket {
  const geometries = (directional ? [-.5, .5] : [-3, 3]).map((x, index) => ({ id: `g${index}`, revision: 1,
    vertices: new Float32Array([x - .5, -.5, 0, 0, 0, 1, x + .5, -.5, 0, 0, 0, 1, x, .5, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }));
  if (meshlets) for (const geometry of geometries) {
    const original = geometry.vertices, vertices = new Float32Array(1344 * 18), indices = new Uint32Array(1344 * 3);
    for (let triangle = 0; triangle < 1344; triangle++) {
      vertices.set(original, triangle * 18);
      // Half of the real meshlets lie outside every tested view; no level-0 proxy bounds.
      if (triangle >= 672) for (let vertex = 0; vertex < 3; vertex++) vertices[triangle * 18 + vertex * 6]! += 30;
      indices.set([triangle * 3, triangle * 3 + 1, triangle * 3 + 2], triangle * 3);
    }
    geometry.vertices = vertices; geometry.indices = indices;
  }
  return { geometries, materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1, doubleSided: true }],
    instances: [{ id: "author", material: "m", geometry: "g0", transform: identity,
      lod: { strategy: "author-selected", revision, selectedLevels,
        levels: geometries.map((geometry, index) => ({ geometry: geometry.id, distance: index * 5, hysteresis: 0 })) } }] };
}
const view = { ...integrationView, lights: {
  directional: [{ directionWorld: [0, 0, -1] as const, color: [1, 1, 1] as const, intensity: 1, castShadow: false }],
  spots: [-3, 3].map((x, index) => ({ positionWorld: [x, 0, 3] as const, directionWorld: [0, 0, -1] as const,
    range: 8, color: [1, 1, 1] as const, intensity: 5, innerConeCos: .96, outerConeCos: .9,
    shadow: { key: `spot${index}`, importance: 2 - index } })),
} };
export async function runLocalSpotLodProbe(canvas: HTMLCanvasElement, referenceCanvas: HTMLCanvasElement, meshlets = false, directional = false, resident = false) {
  const options = { shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
    features: { environment: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
      temporalAa: false, occlusionCulling: false, bloom: false, vignette: false, fog: false } };
  const actual = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, { ...options, meshlets });
  const reference = await PbrRenderer.create(referenceCanvas, navigator.gpu, new AbortController().signal, options);
  const results: unknown[] = [], errors: string[] = [];
  const commands = meshlets ? observeMeshletCommands(actual.session.device) : undefined;
  for (const renderer of [actual, reference]) renderer.session.device.pushErrorScope("validation");
  let failure: string | undefined;
  let residency: GpuRenderResidencyRuntime | undefined;
  try {
    for (const [index, selected] of [[0], [1], [], [0, 1]].entries()) {
      const source = packet(selected!, index + 1, meshlets, directional);
      if (!index && resident) {
        const loader = createPacketResidencyLoader(prepareRenderPacket(source));
        residency = loader.createRuntime(actual.session, { maxResidentBytes: 8 * 1024 * 1024, maxUploadBytesPerFrame: 8 * 1024 * 1024 }, { meshlets });
        await actual.stageResidentPacketValidated(await loader.loadInto(residency, { frame: 1 }));
      } else if (!index) await actual.setPacketValidated(source);
      else actual.updateInstances({ materials: source.materials, instances: source.instances });
      await reference.setPacketValidated({ ...source, instances: selected!.map(level => ({
        id: `reference${level}`, geometry: `g${level}`, material: "m", transform: identity })) });
      const activeView = directional ? integrationView : view;
      const metrics = actual.render(activeView); reference.render(activeView);
      const pixels = directional ? await readIntegrationAttachments(actual) : await readLocalSpotAtlas(actual);
      const expected = directional ? await readIntegrationAttachments(reference) : await readLocalSpotAtlas(reference);
      let maxError = 0; const shadows = [0, 0];
      for (let pixel = 0; pixel < pixels.length; pixel++) {
        maxError = Math.max(maxError, Math.abs(pixels[pixel]! - expected[pixel]!));
        if (directional) { if (pixel % 8 === 6 && pixels[pixel]! < .999) shadows[0]!++; }
        else if (pixel < 512 * 1024 && pixels[pixel]! < .999) shadows[pixel % 1024 < 512 ? 0 : 1]!++;
      }
      const cached = actual.render(activeView);
      const visibleCommands = await commands?.read();
      const passed = pixels.every(Number.isFinite) && maxError < (directional ? .00002 : .00001)
        && (directional ? (selected!.length ? shadows[0]! > 20 : shadows[0] === 0)
          : shadows.every((count, level) => selected!.includes(level) ? count > 20 : count === 0))
        && (!visibleCommands || visibleCommands.every(count => count === 0 || count === 32)
          && visibleCommands.reduce<number>((sum, count) => sum + count, 0) === selected!.length * (directional ? 64 : 32))
        && (meshlets ? (cached?.meshletPasses ?? 0) === 0 && (selected!.length === 0 || (metrics?.meshletPasses ?? 0) > 0)
          : (cached?.authorFrustumPasses ?? 0) === selected!.length);
      results.push({ selected, passed, maxError, shadows, visibleCommands, metrics, cachedAuthorPasses: cached?.authorFrustumPasses });
    }
  } catch (error) { failure = String(error); }
  finally {
    commands?.restore();
    for (const renderer of [actual, reference]) { const error = await renderer.session.device.popErrorScope(); if (error) errors.push(error.message); renderer.dispose(); }
    residency?.dispose();
  }
  return { passed: !failure && results.length === 4 && results.every(result => (result as { passed: boolean }).passed)
    && !errors.length && !actual.session.diagnostics.length && !reference.session.diagnostics.length
    && actual.session.resourceCount === 0 && reference.session.resourceCount === 0,
    results, errors, failure, adapter: actual.session.adapterInfo, resources: [actual.session.resourceCount, reference.session.resourceCount],
    diagnostics: [actual.session.diagnostics, reference.session.diagnostics],
    scope: "Production PbrRenderer local spot atlas compared with explicitly expanded selected geometry. Two off-camera silhouettes in disjoint spot cones." };
}
