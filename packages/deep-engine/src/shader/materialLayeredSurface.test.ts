import { expect, it } from "vitest";
import { normalizeLayeredSurfaceParameters, packLayeredSurfaceBlock, resolveLayerSurface } from "./materialLayeredSurface.js";
import { packLayeredMaterialFloatArray } from "./materialLayeredParameters.js";
it("preserves the old scalar ABI while isolating per-layer surface snapshots", () => {
  const color: [number, number, number] = [.2, .4, .8];
  const normalized = normalizeLayeredSurfaceParameters({ layers: [{ coverage: .7, surface: { baseColor: color, metallic: .3 } }] });
  color[0] = 1; expect(normalized.surfaces[0]!.baseColor![0]).toBeCloseTo(.2);
  expect(packLayeredMaterialFloatArray(normalized)).toHaveLength(22);
  const base = { baseColor: [1, 0, 0] as const, metallic: 0, roughness: .6 };
  expect(resolveLayerSurface(base, normalized.surfaces[0])).toMatchObject({ roughness: .6, metallic: Math.fround(.3) });
  expect(resolveLayerSurface(base, undefined)).toBe(base);
});
it("packs two surface layers in the separate 304B storage ABI and preserves unsigned texture indices", () => {
  const normalized = normalizeLayeredSurfaceParameters({ layers: [{ coverage: .5, mode: "overlay", surface: { baseColor: [.2, .3, .4], roughness: .2 } }] });
  const block = packLayeredSurfaceBlock(normalized, [{ baseColor: { arrayLayer: 7, slot: { texture: "t", texCoord: 1, uvTransform: [1, 0, .2, 0, 1, .3] } } }]);
  const codes = new Uint32Array(block.buffer);
  expect(block.byteLength).toBe(304); expect(Array.from(codes.subarray(0, 2))).toEqual([1, 1]);
  expect(Array.from(block.subarray(12, 16))).toEqual([Math.fround(.2), Math.fround(.3), Math.fround(.4), .5]);
  expect(block[18]).toBe(1); expect(block[19]).toBe(5); expect(block[23]).toBe(2); expect(codes[36]).toBe(7);
  expect(Array.from(block.subarray(40))).toEqual(new Array(36).fill(0));
});
it("prunes zero coverage together with its own surface/texture rather than shifting the wrong layer", () => {
  const normalized = normalizeLayeredSurfaceParameters({ layers: [{ coverage: 0, surface: { baseColor: [1, 0, 0] } },
    { coverage: 1, surface: { baseColor: [0, 1, 0] } }] });
  const block = packLayeredSurfaceBlock(normalized, [{}, { baseColor: { arrayLayer: 9, slot: { texture: "green", texCoord: 0, uvTransform: [1, 0, 0, 0, 1, 0] } } }]);
  expect(Array.from(block.subarray(12, 16))).toEqual([0, 1, 0, 1]); expect(new Uint32Array(block.buffer)[36]).toBe(9);
});
it("rejects invalid surface channels and UV data before GPU admission", () => {
  for (const value of [NaN, Infinity, -1, 2]) expect(() => normalizeLayeredSurfaceParameters({ layers: [{ surface: { roughness: value } }] })).toThrow();
  expect(() => normalizeLayeredSurfaceParameters({ layers: [{ surface: { baseColorTexture: { texture: "t", texCoord: 2 as 1 } } }] })).toThrow();
  const normalized = normalizeLayeredSurfaceParameters({ layers: [{ coverage: 1 }] });
  expect(() => packLayeredSurfaceBlock(normalized, [{ baseColor: { arrayLayer: -1, slot: { texture: "t", texCoord: 0, uvTransform: [1, 0, 0, 0, 1, 0] } } }])).toThrow();
});
