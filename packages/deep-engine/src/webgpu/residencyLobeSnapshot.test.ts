import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { snapshotResidencyPacket } from "./packetResidencySnapshot.js";
import { sceneChunkBatchIdentity } from "./sceneChunkRevision.js";
import { STOCK_MATERIAL_INSTANCE_OPTIONS } from "../materialInstanceAbi.js";
import type { RenderPacket } from "../renderPacketTypes.js";

const packet = (): RenderPacket => ({
  geometries: [{ id: "g", revision: 1, vertices: new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 0.5,
    extendedParameters: { ior: 1.5, clearcoat: { factor: 0.9, roughness: 0.1 }, anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0.5 } },
    advancedParameters: { sheen: { color: [0.5, 0.5, 0.5], roughness: 0.4 }, volume: { thickness: 1, attenuationColor: [0.5, 1, 0.5] } } }],
  instances: [{ id: "i", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
} as RenderPacket);

describe("resident packet snapshots keep material lobe parameters", () => {
  it("a residency snapshot of an untextured lobe material has the same chunk identity as the live batch", () => {
    const prepared = prepareRenderPacket(packet(), STOCK_MATERIAL_INSTANCE_OPTIONS);
    const snapshot = snapshotResidencyPacket(prepared);
    const live = prepared.batches[0]!, kept = snapshot.batches[0]!;
    expect(kept.textures?.extendedParameters).toEqual(live.textures?.extendedParameters);
    expect(kept.textures?.advanced).toEqual(live.textures?.advanced);
    expect(sceneChunkBatchIdentity(kept)).toBe(sceneChunkBatchIdentity(live));
  });
});