import { describe, expect, it } from "vitest";
import {
  SPLAT_MAX_SPLAT_COUNT,
  SPLAT_RECORD_FLOAT_STRIDE,
  SPLAT_RECORD_OFFSET_COLOR,
  SPLAT_RECORD_OFFSET_OPACITY,
  SPLAT_RECORD_OFFSET_ROTATION,
  SPLAT_RECORD_OFFSET_SCALE,
  SPLAT_RUNTIME_FORMAT_ID,
  SplatParseError,
} from "./splatFormatContract.js";
import { assertSplatRuntimeCount, decodeSplatRuntimeFormat } from "./decodeSplatRuntimeFormat.js";
import { buildSplatRuntimeFixture } from "./splatPlyTestUtils.js";

describe("decodeSplatRuntimeFormat (antimatter15 .splat, 32B per splat)", () => {
  it("converts the official wxyz byte quaternion to xyzw and accepts unaligned byte views", () => {
    const bytes = buildSplatRuntimeFixture([{ position: [1, 2, 3], scale: [.1, .2, .3],
      color: [255, 128, 64, 255], rotation: [192, 160, 144, 136] }]);
    const backing = new Uint8Array(bytes.length + 1); backing.set(bytes, 1);
    const result = decodeSplatRuntimeFormat(backing.subarray(1));
    const length = Math.hypot(64, 32, 16, 8);
    const expected = [32, 16, 8, 64].map(value => value / length);
    Array.from(result.records.subarray(8, 12)).forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 7));
  });
  it("rejects nonfinite positions and nonpositive scales from the f32 payload", () => {
    const bytes = buildSplatRuntimeFixture([{ position: [0, 0, 0], scale: [1, 1, 1], color: [0, 0, 0, 255], rotation: [255, 128, 128, 128] }]);
    const view = new DataView(bytes.buffer); view.setFloat32(0, Infinity, true);
    expect(() => decodeSplatRuntimeFormat(bytes)).toThrow(/invalid/);
    view.setFloat32(0, 0, true); view.setFloat32(12, -1, true);
    expect(() => decodeSplatRuntimeFormat(bytes)).toThrow(/invalid/);
  });
  it("expands 32B records to the unified 64B layout with straight-alpha colors and normalized rotation", () => {
    const bytes = buildSplatRuntimeFixture([
      {
        position: [1, 2, 3],
        scale: [0.5, 1, 2],
        color: [255, 128, 0, 255],
        rotation: [255, 0, 0, 0], // (1,0,0,0)/128-1 → 已是单位四元数方向
      },
    ]);
    const cloud = decodeSplatRuntimeFormat(bytes);
    expect(cloud.format).toBe(SPLAT_RUNTIME_FORMAT_ID);
    expect(cloud.splatCount).toBe(1);
    expect(cloud.shDegree).toBe(0);
    expect(cloud.shRest).toBeNull();
    expect(cloud.records.length).toBe(SPLAT_RECORD_FLOAT_STRIDE);

    expect([cloud.records[0], cloud.records[1], cloud.records[2]]).toEqual([1, 2, 3]);
    expect([cloud.records[SPLAT_RECORD_OFFSET_SCALE],
      cloud.records[SPLAT_RECORD_OFFSET_SCALE + 1],
      cloud.records[SPLAT_RECORD_OFFSET_SCALE + 2]]).toEqual([0.5, 1, 2]);
    expect(cloud.records[SPLAT_RECORD_OFFSET_COLOR]).toBeCloseTo(1, 12);
    expect(cloud.records[SPLAT_RECORD_OFFSET_COLOR + 1]).toBeCloseTo(128 / 255, 7);
    expect(cloud.records[SPLAT_RECORD_OFFSET_COLOR + 3]).toBe(1);
    expect(cloud.records[SPLAT_RECORD_OFFSET_OPACITY]).toBe(1);

    const rotation = Array.from(cloud.records.subarray(
      SPLAT_RECORD_OFFSET_ROTATION, SPLAT_RECORD_OFFSET_ROTATION + 4));
    expect(Math.hypot(...rotation)).toBeCloseTo(1, 7);
  });

  it("rejects lengths that are not multiples of 32 bytes", () => {
    expect(() => decodeSplatRuntimeFormat(new Uint8Array(31))).toThrow(/multiple of 32/u);
    expect(() => decodeSplatRuntimeFormat(new Uint8Array(33))).toThrow(/multiple of 32/u);
  });

  it("enforces the splat budget before decoding (guard is shared by the decode entry)", () => {
    // 预算路径用纯守卫直测:真分配 512MB 夹具只为触发一个比较是浪费。
    expect(() => assertSplatRuntimeCount(SPLAT_MAX_SPLAT_COUNT + 1)).toThrow(/budget/u);
    expect(() => assertSplatRuntimeCount(SPLAT_MAX_SPLAT_COUNT)).not.toThrow();
  });

  it("rejects an all-zero rotation u8 quadruple (maps to (0,0,0,0), not normalizable)", () => {
    const bytes = buildSplatRuntimeFixture([
      { position: [0, 0, 0], scale: [1, 1, 1], color: [0, 0, 0, 255], rotation: [128, 128, 128, 128] },
    ]);
    expect(() => decodeSplatRuntimeFormat(bytes)).toThrow(SplatParseError);
  });
});
