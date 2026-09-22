import { expect, it } from "vitest";
import { packLightmapRadiance } from "./lightmapRadiance";
it("stores neutral HDR without clipping or chroma subtraction", () => {
  const result = packLightmapRadiance(new Float32Array([4,4,4,1,1,0,0,1]));
  expect(result.strength).toBe(4);expect([...result.pixels.slice(0,4)]).toEqual([255,255,255,255]);
  expect(result.pixels[4]).toBe(137);
});
it("keeps the LDR scale stable and rejects malformed/out-of-budget radiance", () => {
  expect(packLightmapRadiance(new Float32Array([0,0,0,1])).strength).toBe(1);
  for (const value of [-1,Infinity,NaN,257]) expect(()=>packLightmapRadiance(new Float32Array([value,0,0,1]))).toThrow();
  expect(()=>packLightmapRadiance(new Float32Array(3))).toThrow();
});
