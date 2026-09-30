import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DIRECT_DFG_185_DIM, DIRECT_DFG_185_HALVES, DIRECT_DFG_185_WGSL_ARRAY, decodeDirectDfg185, sampleDirectDfg185 } from "./directDfgLut185.js";

it("canonical halves match the upstream three@0.185.1 DFGLUTData bytes", () => {
  const upstream = readFileSync(new URL("../../../deep-engine/node_modules/three/src/renderers/shaders/DFGLUTData.js", import.meta.url), "utf8");
  const tokens = upstream.match(/new Uint16Array\( \[([\s\S]*?)\] \)/)![1].match(/0x[0-9a-fA-F]+/g)!.map(t => parseInt(t, 16));
  expect(tokens).toHaveLength(512);
  expect(Array.from(DIRECT_DFG_185_HALVES)).toEqual(tokens);
  expect(DIRECT_DFG_185_DIM).toBe(16);
});

it("decodes halves exactly and preserves the documented boundary texels", () => {
  expect(decodeDirectDfg185(240)).toEqual([1, 0]);
  const [lastX, lastY] = decodeDirectDfg185(255);
  expect(lastX).toBeGreaterThan(0.2);
  expect(lastY).toBeLessThan(1e-4);
  expect(Number.isFinite(decodeDirectDfg185(0)[0])).toBe(true);
});

it("bilinear sampler matches GL clamp-to-edge semantics at half texel convention", () => {
  expect(sampleDirectDfg185(0, 1)).toEqual([1, 0]);
  const [r0, g0] = decodeDirectDfg185(0);
  expect(sampleDirectDfg185(-1, -1)).toEqual([r0, g0]);
  expect(sampleDirectDfg185(2, 2)).toEqual(decodeDirectDfg185(255));
  const texelCenter = 8.5 / 16;
  expect(sampleDirectDfg185(texelCenter, 0)).toEqual(decodeDirectDfg185(8));
  for (const [rough, nv] of [[0.97, 0.52], [0.15, 0.907], [1, 0], [0.5, 0.5], [0.06, 0.001]]) {
    const u = Math.min(Math.max(rough, 0), 1) * 16 - .5, v = Math.min(Math.max(nv, 0), 1) * 16 - .5;
    const fu0 = Math.floor(u), fv0 = Math.floor(v);
    const i0 = Math.min(Math.max(fu0, 0), 15), j0 = Math.min(Math.max(fv0, 0), 15);
    const i1 = Math.min(Math.max(fu0 + 1, 0), 15), j1 = Math.min(Math.max(fv0 + 1, 0), 15);
    const fu = Math.min(Math.max(u - fu0, 0), 1), fv = Math.min(Math.max(v - fv0, 0), 1);
    const [x0, y0] = decodeDirectDfg185(j0 * 16 + i0), [x1, y1] = decodeDirectDfg185(j0 * 16 + i1);
    const [x2, y2] = decodeDirectDfg185(j1 * 16 + i0), [x3, y3] = decodeDirectDfg185(j1 * 16 + i1);
    const got = sampleDirectDfg185(rough, nv);
    expect(got[0]).toBeCloseTo((x0 * (1 - fu) + x1 * fu) * (1 - fv) + (x2 * (1 - fu) + x3 * fu) * fv, 12);
    expect(got[1]).toBeCloseTo((y0 * (1 - fu) + y1 * fu) * (1 - fv) + (y2 * (1 - fu) + y3 * fu) * fv, 12);
  }
});

it("the generated WGSL literal round-trips to the same decoded table", () => {
  const numbers = DIRECT_DFG_185_WGSL_ARRAY.match(/vec2f\(([0-9.e+-]+), ([0-9.e+-]+)\)/g)!;
  expect(numbers).toHaveLength(256);
  for (let index = 0; index < 256; index++) {
    const [x, y] = numbers[index].match(/vec2f\(([0-9.e+-]+), ([0-9.e+-]+)\)/)!.slice(1).map(Number);
    const [rx, ry] = decodeDirectDfg185(index);
    expect(x).toBe(rx);
    expect(y).toBe(ry);
  }
});
