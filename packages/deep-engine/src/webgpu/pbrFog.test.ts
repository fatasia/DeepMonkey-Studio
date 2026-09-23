import { describe, expect, it } from "vitest";
import { packPbrFog, pbrFogFactor, snapshotPbrFog, validatePbrFog, type PbrFog } from "./pbrFog.js";

const linear: PbrFog = { kind: "linear", color: [2, 0.5, 0], near: 10, far: 30 };
const exp2: PbrFog = { kind: "exp2", color: [0.2, 0.3, 0.4], density: 0.018 };
const volumetric: PbrFog = { kind: "volumetric", color: [0.2, 0.3, 0.4], density: 0.018 };

describe("author PBR fog contract", () => {
  it("encodes explicit no-fog without inventing weather defaults", () => {
    expect(snapshotPbrFog(null)).toBeNull();
    expect([...packPbrFog(null)]).toEqual(Array(8).fill(0));
    expect(pbrFogFactor(null, 1000)).toBe(0);
  });

  it("packs stable two-vec4 linear and exp2 contracts", () => {
    expect([...packPbrFog(linear)]).toEqual([2, 0.5, 0, 1, 10, 30, 0, 0]);
    const packed = packPbrFog(exp2);
    expect([...packed.slice(3, 6)]).toEqual([2, 0, 0]);
    expect(packed[6]).toBeCloseTo(0.018, 8);
    expect(packed[7]).toBe(0);
  });

  it("owns and freezes a snapshot without mutating author values", () => {
    const author = { kind: "exp2" as const, color: [2, 3, 4] as [number, number, number], density: 0.01 };
    const snapshot = snapshotPbrFog(author);
    author.color[0] = 8; author.density = 0.3;
    expect(snapshot).toEqual({ kind: "exp2", color: [2, 3, 4], density: 0.01 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot!.color)).toBe(true);
  });

  it.each([[-1, 0], [10, 0], [15, 0.15625], [20, 0.5], [25, 0.84375], [30, 1], [100, 1]])(
    "matches smoothstep at depth %s", (depth, expected) => {
      expect(pbrFogFactor(linear, depth!)).toBe(expected);
    });

  it.each([0, 1, 10, 100, 1000])("matches density-squared exp2 at depth %s without the old 0.95 cap", depth => {
    expect(pbrFogFactor(exp2, depth)).toBeCloseTo(1 - Math.exp(-(0.018 ** 2) * depth ** 2), 14);
  });

  it("uses the bounded linear-depth volume contract", () => {
    expect([...packPbrFog(volumetric).slice(3, 6)]).toEqual([4, 0, 0]);
    expect(pbrFogFactor(volumetric, 10)).toBeCloseTo(1 - Math.exp(-0.018 * 10), 14);
    expect(snapshotPbrFog(volumetric)).toEqual(volumetric);
  });

  it("preserves signed camera depth and zero-density behavior", () => {
    expect(pbrFogFactor(exp2, -100)).toBe(pbrFogFactor(exp2, 100));
    expect(pbrFogFactor({ ...exp2, density: 0 }, 3e38)).toBe(0);
    expect(pbrFogFactor(exp2, 1000)).toBe(1);
  });

  it.each([NaN, Infinity, -Infinity, 1e40])("rejects invalid Float32 input %s", value => {
    expect(() => validatePbrFog({ ...exp2, density: value })).toThrow();
    expect(() => validatePbrFog({ ...linear, far: value })).toThrow();
    expect(() => validatePbrFog({ ...exp2, color: [value, 0, 0] })).toThrow();
    expect(() => pbrFogFactor(exp2, value)).toThrow();
  });

  it("rejects negative radiance/density and collapsed or reversed distances", () => {
    expect(() => validatePbrFog({ ...exp2, density: -1 })).toThrow();
    expect(() => validatePbrFog({ ...exp2, color: [-1, 0, 0] })).toThrow();
    expect(() => validatePbrFog({ ...linear, near: 30 })).toThrow();
    expect(() => validatePbrFog({ ...linear, near: -1 })).toThrow();
    expect(() => validatePbrFog({ ...linear, near: 1e8, far: 1e8 + 1 })).toThrow("Float32");
  });

  it.each([undefined, {}, [], { ...exp2, kind: "radial" }, { ...exp2, color: [1, 2] },
    { ...exp2, color: new Array(3) }, { ...exp2, density: "1" }, { ...linear, far: "30" }])(
    "rejects malformed runtime data %j", value => {
      expect(() => validatePbrFog(value as never)).toThrow();
    });
});
