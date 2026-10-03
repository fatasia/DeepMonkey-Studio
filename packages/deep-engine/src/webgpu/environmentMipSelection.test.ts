import { describe, expect, it } from "vitest";
import { environmentMipSelection, environmentSpecularLod } from "./environmentMipSelection.js";
import { packPbrEnvironmentReflections } from "./pbrReflectionProbes.js";
import type { StudioEnvironment } from "./studioEnvironment.js";

describe("IBL chain-tail roughness domain", () => {
  it("keeps complete-chain LOD unchanged and clamps missing sharp layers", () => {
    const full = environmentMipSelection(8), tail = environmentMipSelection(8, 4);
    for (const r of [0, .25, .5, .75, 1]) {
      expect(environmentSpecularLod(full, r)).toBe(r * 7);
      expect(environmentSpecularLod(tail, r)).toBe(Math.max(0, r * 7 - 4));
    }
    expect(environmentSpecularLod(tail, .75)).toBe(1.25);
    expect(environmentSpecularLod(environmentMipSelection(8, 1), 1)).toBe(0);
  });
  it.each([0, 9, -1, 1.5, NaN, Infinity])("rejects kept count %s", kept => {
    expect(() => environmentMipSelection(8, kept)).toThrow();
  });
  it("packs independent global/probe offsets in reserved rows, preserving boxes", () => {
    const env = (kept: number) => ({ specularMipSelection: environmentMipSelection(8, kept) } as StudioEnvironment);
    const box = { center: [1, 2, 3] as const, halfExtents: [4, 5, 6] as const, blendDistance: 1, influenceRadius: 2 };
    const data = packPbrEnvironmentReflections({ ...env(4), reflectionProbes: [
      { box, environment: env(6) }, { box, environment: env(8) }] });
    expect([...data.slice(12, 16)]).toEqual([4, 2, 0, 0]);
    expect([...data.slice(0, 8)]).toEqual([1, 2, 3, 1, 4, 5, 6, 2]);
    expect([...packPbrEnvironmentReflections({} as StudioEnvironment).slice(12, 16)]).toEqual([0, 0, 0, 0]);
    expect(() => packPbrEnvironmentReflections({ specularMipSelection: { rawMips: 8, keptMips: 4, droppedMips: 0 } } as StudioEnvironment)).toThrow();
  });
});
