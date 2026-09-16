import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveSpatialAaCpu } from "./spatialAaCpu.js";
import { SPATIAL_AA_PRESENT_WGSL } from "./spatialAaWgsl.js";

function edge(width: number, height: number, offset = 0, alpha = 1) {
  return { width, height, color: Float32Array.from({ length: width * height * 4 }, (_, i) => {
    const pixel = Math.floor(i / 4), x = pixel % width, y = Math.floor(pixel / width);
    const coverage = Number(x + .5 < .61 * (y + .5) + width * .16 + offset);
    return i % 4 === 3 ? (alpha === 1 ? 1 : coverage * alpha) : coverage * alpha;
  }) };
}
describe("display-domain spatial AA", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("is Naga-valid", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "spatial-aa.wgsl", "--input-kind", "wgsl"], { input: SPATIAL_AA_PRESENT_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each([[32, 32], [64, 32], [17, 49]])("improves supersampled diagonal coverage at %ix%i without blurring interiors", (width, height) => {
    const input = edge(width, height), output = resolveSpatialAaCpu(input);
    let rawError = 0, aaError = 0, partial = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      let reference = 0;
      for (let sy = 0; sy < 32; sy++) for (let sx = 0; sx < 32; sx++) reference += Number(x + (sx + .5) / 32 < .61 * (y + (sy + .5) / 32) + width * .16) / 1024;
      const i = (y * width + x) * 4;
      rawError += (input.color[i]! - reference) ** 2; aaError += (output[i]! - reference) ** 2;
      if (output[i]! > 0 && output[i]! < 1) partial++;
      if (Math.abs(x + .5 - .61 * (y + .5) - width * .16) > 2) expect(output[i]).toBe(input.color[i]);
    }
    expect(partial).toBeGreaterThan(10); expect(aaError).toBeLessThan(rawError * .75);
  });
  it("has no history or motion trails and preserves premultiplied translucent edges", () => {
    const first = edge(32, 32, -4), moved = edge(32, 32, 4), original = moved.color.slice();
    resolveSpatialAaCpu(first);
    expect(resolveSpatialAaCpu(moved)).toEqual(resolveSpatialAaCpu(edge(32, 32, 4)));
    expect(moved.color).toEqual(original);
    const transparent = resolveSpatialAaCpu(edge(32, 32, 0, .5));
    for (let i = 0; i < transparent.length; i += 4) {
      expect(transparent[i]).toBe(transparent[i + 3]); expect(transparent[i]!).toBeLessThanOrEqual(.5);
    }
  });
  it.each([0, .02, .5, 1])("preserves flat fields exactly (%s), including display white highlights", value => {
    const color = new Float32Array(13 * 7 * 4).fill(value);
    expect(resolveSpatialAaCpu({ width: 13, height: 7, color })).toEqual(color);
  });
  it("preserves sub-threshold texture detail and clamps single-pixel boundaries", () => {
    const color = Float32Array.from({ length: 32 }, (_, i) => i % 4 === 3 ? 1 : Math.floor(i / 4) % 2 ? .51 : .5);
    expect(resolveSpatialAaCpu({ width: 8, height: 1, color })).toEqual(color);
    expect(resolveSpatialAaCpu({ width: 1, height: 1, color: [1, .5, .25, 1] })).toEqual(new Float32Array([1, .5, .25, 1]));
  });
  it("rejects malformed dimensions, HDR/nonfinite values and never mutates inputs", () => {
    for (const width of [0, -1, .5, Infinity]) expect(() => resolveSpatialAaCpu({ width, height: 1, color: [] })).toThrow("dimensions");
    for (const value of [NaN, Infinity, -1, 2]) expect(() => resolveSpatialAaCpu({ width: 1, height: 1, color: [value, 0, 0, 1] })).toThrow("display-encoded");
  });
});
