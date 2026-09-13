import { describe, expect, it } from "vitest";
import { parseModelProcessingRecord } from "./modelProcessingMetadata.js";
const stats = { bytes: 4, nodes: 1, meshes: 1, primitives: 1, triangles: 1, vertices: 3, materials: 1, textures: 0 };
const value = { schemaVersion: 1, operation: "optimize", preset: "balanced", inputFileName: "pump.glb", inputSha256: "a".repeat(64), optionsJson: "{}", layerEditsJson: "[]", before: stats, after: stats };
const field = (data: unknown) => ({ type: "field", value: JSON.stringify(data) });
describe("processing upload metadata", () => {
  it("keeps compatible old uploads and strips client-claimed output fingerprints", () => {
    expect(parseModelProcessingRecord(undefined)).toBeUndefined();
    expect(parseModelProcessingRecord(field({ ...value, outputSha256: "f".repeat(64) }))).toEqual(value);
  });
  it("rejects malformed hashes, oversized recipes and invalid metrics before persistence", () => {
    for (const patch of [{ inputSha256: "no" }, { optionsJson: "x".repeat(25_000) }, { after: { ...stats, triangles: -1 } }, { operation: "execute" }]) expect(() => parseModelProcessingRecord(field({ ...value, ...patch }))).toThrow();
    expect(() => parseModelProcessingRecord([field(value)])).toThrow();
  });
});
