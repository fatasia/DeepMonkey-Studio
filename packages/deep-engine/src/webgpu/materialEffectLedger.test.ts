import { describe, expect, it } from "vitest";
import { prepareRenderPacket, type RenderPacket } from "../renderPacket.js";
import { compileMaterialEffectLedger } from "./materialEffectLedger.js";

const packet = (): RenderPacket => ({
  geometries: [{ id: "g", revision: 1,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "coated-metal", baseColor: [0.2, 0.4, 0.8], metallic: 0.75, roughness: 0.125,
    alphaMode: "BLEND", premultipliedAlpha: true, baseColorAlpha: 0.6,
    emissiveFactor: [0.1, 0.2, 0.3], emissiveStrength: 2, fog: false, doubleSided: true }],
  instances: [{ id: "part-7", geometry: "g", material: "coated-metal", receiveShadow: false,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
});

describe("material effect ledger", () => {
  it("traces author identity to the exact packed draw record", () => {
    const source = packet(), prepared = prepareRenderPacket(source);
    const ledger = compileMaterialEffectLedger(source, prepared.batches);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ instanceId: "part-7", materialId: "coated-metal",
      instanceRecord: 0, authored: { metallic: 0.75, roughness: 0.125, surfaceFlags: 181,
        alpha: expect.closeTo(0.6), emissiveStrength: 1,
        pipeline: { alphaMode: "BLEND", doubleSided: true, premultipliedAlpha: true, castShadow: true } },
      consumed: { metallic: 0.75, roughness: 0.125, surfaceFlags: 181,
        alpha: expect.closeTo(0.6), emissiveStrength: 1,
        pipeline: { alphaMode: "BLEND", doubleSided: true, premultipliedAlpha: true, castShadow: true } } });
    expect(ledger.entries[0]!.batchKey).toBe(prepared.batches[0]!.key);
    expect(Object.isFrozen(ledger.entries[0]!.consumed)).toBe(true);
  });

  it("ignores the internal texture-array material row encoded above the surface flag bits", () => {
    const source = packet(), prepared = prepareRenderPacket(source), batch = prepared.batches[0]!;
    const encoded = new Float32Array(batch.data);
    encoded[31] += 7 * 1024;
    const ledger = compileMaterialEffectLedger(source, [{ ...batch, data: encoded }]);
    expect(ledger.entries[0]!.consumed.surfaceFlags).toBe(181);
  });

  it("fails closed on packed value drift, duplicate identity, or an unknown consumed record", () => {
    const source = packet(), prepared = prepareRenderPacket(source), batch = prepared.batches[0]!;
    const drifted = new Float32Array(batch.data); drifted[28] = 0.5;
    expect(() => compileMaterialEffectLedger(source, [{ ...batch, data: drifted }])).toThrow(/roughness/);
    expect(() => compileMaterialEffectLedger(source, [{ ...batch, premultipliedAlpha: undefined }]))
      .toThrow(/pipeline/);
    expect(() => compileMaterialEffectLedger({ ...source, instances: [source.instances[0]!, source.instances[0]!] },
      prepared.batches)).toThrow(/duplicate instance identity|missing consumed instance/);
    expect(() => compileMaterialEffectLedger({ ...source, instances: [] }, prepared.batches)).toThrow(/unknown consumed instance/);
  });
});
