import { describe, expect, it } from "vitest";
import {
  SPLAT_RECORD_FLOAT_STRIDE,
  SPLAT_RECORD_BYTE_STRIDE,
  SPLAT_MAX_SPLAT_COUNT,
  SPLAT_RECORD_OFFSET_COLOR,
  SPLAT_RECORD_OFFSET_OPACITY,
  SPLAT_RECORD_OFFSET_ROTATION,
  SPLAT_RECORD_OFFSET_SCALE,
  SplatParseError,
} from "./splatFormatContract.js";
import {
  SPLAT_ALPHA_CUTOFF,
  SPLAT_COVARIANCE_PAD_PX2,
  SPLAT_QUAD_CORNER_COUNT,
  SPLAT_UNIFORM_BYTE_LENGTH,
  SPLAT_UNIFORM_FLOAT_COUNT,
  assertSplatFrameBudget,
  createSplatQuadVertexArray,
  splatRecordBufferByteLength,
  writeSplatUniforms,
} from "./splatGpuResources.js";
import {
  DEEP_GAUSSIAN_SPLAT_ENTRY_FRAGMENT,
  DEEP_GAUSSIAN_SPLAT_ENTRY_VERTEX,
  DEEP_GAUSSIAN_SPLAT_RECORD_BYTES,
  DEEP_GAUSSIAN_SPLAT_RECORD_VEC4_STRIDE,
  DEEP_GAUSSIAN_SPLAT_STORAGE_BINDING,
  DEEP_GAUSSIAN_SPLAT_UNIFORM_BINDING,
  DEEP_GAUSSIAN_SPLAT_UNIFORM_BYTES,
  GAUSSIAN_SPLAT_QUADS_WGSL,
} from "./splatQuadsWgsl.js";

const VIEW = new Float32Array(16).fill(0);
const VIEW_PROJECTION = new Float32Array(16).fill(0);

describe("splatGpuResources (layout contract shared with the WGSL half)", () => {
  it("keeps CPU record stride, GPU record bytes and the WGSL ABI constants in lockstep", () => {
    expect(SPLAT_RECORD_FLOAT_STRIDE).toBe(DEEP_GAUSSIAN_SPLAT_RECORD_VEC4_STRIDE * 4);
    expect(SPLAT_RECORD_BYTE_STRIDE).toBe(DEEP_GAUSSIAN_SPLAT_RECORD_BYTES);
    expect(SPLAT_UNIFORM_FLOAT_COUNT * 4).toBe(SPLAT_UNIFORM_BYTE_LENGTH);
    expect(SPLAT_UNIFORM_BYTE_LENGTH).toBe(DEEP_GAUSSIAN_SPLAT_UNIFORM_BYTES);
    expect(splatRecordBufferByteLength(3)).toBe(3 * SPLAT_RECORD_BYTE_STRIDE);
    expect(splatRecordBufferByteLength(0)).toBe(0);
  });

  it("writes the uniform block in the exact field order the WGSL struct expects", () => {
    const view = Array.from({ length: 16 }, (_, i) => i);
    const viewProjection = Array.from({ length: 16 }, (_, i) => 100 + i);
    const target = new Float32Array(SPLAT_UNIFORM_FLOAT_COUNT);
    writeSplatUniforms(target, {
      viewMatrix: view,
      viewProjectionMatrix: viewProjection,
      cameraPosition: [7, 8, 9],
      viewportPixels: [1920, 1080],
      focalPixels: [1000, 1000],
      splatCount: 123456,
    });
    expect(Array.from(target.subarray(0, 16))).toEqual(view);
    expect(Array.from(target.subarray(16, 32))).toEqual(viewProjection);
    expect([target[32], target[33], target[34], target[35]]).toEqual([7, 8, 9, 0]);
    expect([target[36], target[37], target[38], target[39]]).toEqual([1920, 1080, 1000, 1000]);
    expect(target[40]).toBe(123456);
    // uniform 缓冲是 f32:1/255 与 0.3 落盘后带 f32 舍入,不与 JS double 逐位相等。
    expect(target[41]).toBeCloseTo(SPLAT_ALPHA_CUTOFF, 7);
    expect(target[42]).toBeCloseTo(SPLAT_COVARIANCE_PAD_PX2, 7);
    expect(target[43]).toBe(0);
  });

  it("rejects a wrongly sized uniform target and out-of-budget instance counts", () => {
    expect(() => writeSplatUniforms(new Float32Array(4), {
      viewMatrix: VIEW, viewProjectionMatrix: VIEW_PROJECTION,
      cameraPosition: [0, 0, 0], viewportPixels: [1, 1], focalPixels: [1, 1], splatCount: 0,
    })).toThrow(SplatParseError);

    expect(() => assertSplatFrameBudget(SPLAT_MAX_SPLAT_COUNT)).not.toThrow();
    expect(() => assertSplatFrameBudget(SPLAT_MAX_SPLAT_COUNT + 1)).toThrow(/budget/u);
    expect(() => assertSplatFrameBudget(-1)).toThrow(/budget/u);
    expect(() => assertSplatFrameBudget(Number.NaN)).toThrow(/budget/u);
  });

  it("builds a 4-corner strip vertex array spanning [-2,2] in sigma units", () => {
    const corners = createSplatQuadVertexArray();
    expect(corners.length).toBe(SPLAT_QUAD_CORNER_COUNT * 2);
    expect(Array.from(corners)).toEqual([-2, -2, 2, -2, 2, 2, -2, 2]);
  });

  it("keeps the WGSL mirror consuming the same bindings and entry points the contract publishes", () => {
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain("@group(0) @binding(0) var<uniform> frame : SplatFrameParams;");
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain(
      `@group(0) @binding(${DEEP_GAUSSIAN_SPLAT_STORAGE_BINDING}) var<storage, read> splats : array<vec4f>;`);
    expect(DEEP_GAUSSIAN_SPLAT_UNIFORM_BINDING).toBe(0);
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain(`fn ${DEEP_GAUSSIAN_SPLAT_ENTRY_VERTEX}(`);
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain(`fn ${DEEP_GAUSSIAN_SPLAT_ENTRY_FRAGMENT}(`);
    // record 布局互钉:着色器按 4×vec4f 取位,与 CPU 端偏移常量同族。
    expect(GAUSSIAN_SPLAT_QUADS_WGSL).toContain("const RECORD_VEC4_STRIDE = 4u;");
    expect(SPLAT_RECORD_OFFSET_OPACITY).toBe(3);
    expect(SPLAT_RECORD_OFFSET_SCALE).toBe(4);
    expect(SPLAT_RECORD_OFFSET_ROTATION).toBe(8);
    expect(SPLAT_RECORD_OFFSET_COLOR).toBe(12);
  });
});
