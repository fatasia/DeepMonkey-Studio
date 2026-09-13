import { PbrRenderer, sphereMesh, type RenderPacket, type RenderView } from "@bim-studio/deep-engine/webgpu";

const INSTANCE_COUNT = 256;
const SIDE = 16;

/**
 * Exercises the renderer-owned frame history with a real two-frame submission. The packet has
 * two 128-instance batches so both the opaque and transparent paths can cross the Hi-Z threshold.
 */
export async function verifyDefaultPbrIntegration(renderer: PbrRenderer, view: RenderView,
  restore: () => Promise<void>): Promise<Record<string, unknown>> {
  await renderer.setPacketValidated(integrationPacket());
  const first = await renderer.validateFrame(view);
  const second = await renderer.validateFrame(view);
  const relit = await renderer.validateFrame({ ...view, lights: { directional: [{
    directionWorld: [-0.4, -1, 0.25], color: [0.72, 0.86, 1], intensity: 1.8,
  }] } });
  await renderer.setPacketValidated(integrationLodPacket());
  const lod = await renderer.validateFrame({ ...view, lodBudget: { maxObjects: 24, maxTriangles: 8_192 } });
  const checks = {
    firstFrameFallsBack: first.hiZOccludedBatches === 0 && !first.occlusionCulling,
    secondFrameUsesHiZ: second.hiZOccludedBatches >= 2 && second.occlusionCulling,
    forwardPlusIsBound: second.lightCount >= 1 && second.lightClusters > 0,
    weightedOitRuns: second.weightedOit,
    authoredSunDrivesShadowWithoutDoubleLighting: relit.shadowUpdated && relit.lightCount === 0,
    packetLodIndirectRuns: lod.lodSelectionBatches === 1 && lod.lodIndirectDraws === 2
      && lod.frustumCulledBatches === 0 && !lod.occlusionCulling,
  };
  await restore();
  return { action: "default-pbr-integration", success: Object.values(checks).every(Boolean),
    instances: INSTANCE_COUNT, first, second, relit, lod, checks };
}

export function integrationLodPacket(): RenderPacket {
  const geometries = [["lod-high", 12, 8], ["lod-medium", 8, 5], ["lod-low", 4, 3]]
    .map(([id, segments, rings]) => ({ id: String(id), revision: 0,
      ...sphereMesh(Number(segments), Number(rings)) }));
  const lod = { levels: [
    { geometry: "lod-high", minProjectedDiameterPixels: 120, geometricError: 0, resident: true },
    { geometry: "lod-medium", minProjectedDiameterPixels: 4, geometricError: 0.25, resident: false },
    { geometry: "lod-low", minProjectedDiameterPixels: 0, geometricError: 1, resident: true },
  ] } as const;
  const instances = Array.from({ length: 64 }, (_, index) => ({ id: `lod-${index}`,
    geometry: "lod-high", material: "lod-surface", lod,
    transform: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0,
      index % 8 - 3.5, 0.55, Math.floor(index / 8) - 3.5, 1] }));
  return { geometries, materials: [{ id: "lod-surface", baseColor: [0.3, 0.65, 0.9],
    metallic: 0.2, roughness: 0.4 }], instances };
}

export function integrationPacket(): RenderPacket {
  const geometry = { id: "default-integration-sphere", revision: 0, ...sphereMesh(12, 8) };
  const instances = Array.from({ length: INSTANCE_COUNT }, (_, index) => {
    const x = (index % SIDE - (SIDE - 1) / 2) * 1.05;
    const z = (Math.floor(index / SIDE) - (SIDE - 1) / 2) * 1.05;
    const material = index < INSTANCE_COUNT / 2 ? "opaque" : "blend";
    return { id: `integration-${index}`, geometry: geometry.id, material,
      transform: [0.42, 0, 0, 0, 0, 0.42, 0, 0, 0, 0, 0.42, 0, x, 0.45, z, 1] };
  });
  return { geometries: [geometry], materials: [
    { id: "opaque", baseColor: [0.22, 0.48, 0.82], metallic: 0.35, roughness: 0.32 },
    { id: "blend", baseColor: [0.95, 0.3, 0.1], metallic: 0.05, roughness: 0.4, alphaMode: "BLEND", baseColorAlpha: 0.48 },
  ], instances };
}
