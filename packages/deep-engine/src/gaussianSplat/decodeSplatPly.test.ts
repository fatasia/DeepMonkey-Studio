import { describe, expect, it } from "vitest";
import {
  SPLAT_RECORD_FLOAT_STRIDE,
  SPLAT_RECORD_OFFSET_COLOR,
  SPLAT_RECORD_OFFSET_OPACITY,
  SPLAT_RECORD_OFFSET_ROTATION,
  SPLAT_RECORD_OFFSET_SCALE,
  SPLAT_SH_C0,
  SplatParseError,
} from "./splatFormatContract.js";
import { decodeSplatPly } from "./decodeSplatPly.js";
import {
  assertFixtureIsValid,
  buildSplatPlyFixture,
} from "./splatPlyTestUtils.js";

describe("decodeSplatPly (fail-closed payload decoding)", () => {
  it("decodes scale via exp, opacity via sigmoid, color via 0.5+SH_C0·dc, and normalizes the quaternion", () => {
    const fixture = buildSplatPlyFixture({
      splatCount: 2,
      shRestCount: 45,
      overrides: [
        { splatIndex: 0, property: "x", value: 1.5 },
        { splatIndex: 0, property: "y", value: -2.25 },
        { splatIndex: 0, property: "z", value: 3 },
        { splatIndex: 0, property: "opacity", value: 0 }, // sigmoid(0) = 0.5
        { splatIndex: 0, property: "scale_0", value: Math.log(0.5) }, // exp → 0.5
        { splatIndex: 0, property: "scale_1", value: Math.log(2) },
        { splatIndex: 0, property: "scale_2", value: Math.log(1) },
        { splatIndex: 0, property: "rot_0", value: 2 }, // (w,x,y,z)=(2,0,0,0) → w=1
        { splatIndex: 0, property: "rot_1", value: 0 },
        { splatIndex: 0, property: "rot_2", value: 0 },
        { splatIndex: 0, property: "rot_3", value: 0 },
        { splatIndex: 0, property: "f_dc_0", value: 1 }, // 0.5 + 0.28209…·1
        { splatIndex: 0, property: "f_dc_1", value: -4 }, // clamp → 0
        { splatIndex: 0, property: "f_dc_2", value: 4 }, // clamp → 1
        { splatIndex: 1, property: "opacity", value: 100 }, // sigmoid ≈ 1
      ],
    });
    assertFixtureIsValid(fixture);
    const cloud = decodeSplatPly(fixture.bytes);

    expect(cloud.splatCount).toBe(2);
    expect(cloud.shDegree).toBe(3);
    expect(cloud.shRest).not.toBeNull();
    expect(cloud.shRest!.length).toBe(2 * 45);
    expect(cloud.records.length).toBe(2 * SPLAT_RECORD_FLOAT_STRIDE);

    const first = cloud.records;
    expect([first[0], first[1], first[2]]).toEqual([1.5, -2.25, 3]);
    expect(first[SPLAT_RECORD_OFFSET_OPACITY]).toBeCloseTo(0.5, 12);
    expect(first[SPLAT_RECORD_OFFSET_SCALE]).toBeCloseTo(0.5, 12);
    expect(first[SPLAT_RECORD_OFFSET_SCALE + 1]).toBeCloseTo(2, 12);
    expect(first[SPLAT_RECORD_OFFSET_SCALE + 2]).toBe(1);
    expect(first[SPLAT_RECORD_OFFSET_ROTATION + 3]).toBeCloseTo(1, 12); // w
    expect(first[SPLAT_RECORD_OFFSET_ROTATION]).toBe(0);
    expect(first[SPLAT_RECORD_OFFSET_COLOR]).toBeCloseTo(0.5 + SPLAT_SH_C0, 7);
    expect(first[SPLAT_RECORD_OFFSET_COLOR + 1]).toBe(0);
    expect(first[SPLAT_RECORD_OFFSET_COLOR + 2]).toBe(1);
    expect(first[SPLAT_RECORD_OFFSET_COLOR + 3]).toBeCloseTo(0.5, 12);
    expect(cloud.records[SPLAT_RECORD_FLOAT_STRIDE + SPLAT_RECORD_OFFSET_OPACITY]).toBeCloseTo(1, 5);
  });

  it("rejects truncated and over-long payloads with byte-exact expectations", () => {
    const fixture = buildSplatPlyFixture({ splatCount: 3 });
    assertFixtureIsValid(fixture);
    // 默认夹具 17 属性 × 3 粒 = 204B 负载;截 4B 后 found=200。
    const truncated = fixture.bytes.subarray(0, fixture.bytes.byteLength - 4);
    expect(() => decodeSplatPly(truncated)).toThrow(/expected 204 bytes after the header, found 200/u);

    const padded = new Uint8Array(fixture.bytes.byteLength + 8);
    padded.set(fixture.bytes, 0);
    expect(() => decodeSplatPly(padded)).toThrow(/8 unexpected trailing byte/u);
  });

  it("names the exact splat index and field for non-finite values and dead quaternions", () => {
    const nanFixture = buildSplatPlyFixture({
      splatCount: 3,
      overrides: [{ splatIndex: 2, property: "scale_1", value: Number.NaN }],
    });
    expect(() => decodeSplatPly(nanFixture.bytes))
      .toThrow(/Splat #2 field "scale_1" is not finite/u);

    const infFixture = buildSplatPlyFixture({
      splatCount: 2,
      overrides: [{ splatIndex: 0, property: "f_dc_1", value: Number.POSITIVE_INFINITY }],
    });
    expect(() => decodeSplatPly(infFixture.bytes))
      .toThrow(/Splat #0 field "f_dc_1" is not finite/u);

    const deadQuaternion = buildSplatPlyFixture({
      splatCount: 1,
      overrides: (["rot_0", "rot_1", "rot_2", "rot_3"] as const)
        .map((property) => ({ splatIndex: 0, property, value: 0 })),
    });
    expect(() => decodeSplatPly(deadQuaternion.bytes))
      .toThrow(/zero length/u);
  });

  it("normalizes equal-component quaternions exactly ((1,1,1,1) → 0.5 each)", () => {
    const fixture = buildSplatPlyFixture({
      splatCount: 1,
      overrides: (["rot_0", "rot_1", "rot_2", "rot_3"] as const)
        .map((property) => ({ splatIndex: 0, property, value: 1 })),
    });
    const cloud = decodeSplatPly(fixture.bytes);
    const rotation = Array.from(
      cloud.records.subarray(SPLAT_RECORD_OFFSET_ROTATION, SPLAT_RECORD_OFFSET_ROTATION + 4));
    const length = Math.hypot(...rotation);
    expect(length).toBeCloseTo(1, 12);
    expect(new Set(rotation).size).toBe(1);
    expect(rotation[0]).toBeCloseTo(0.5, 12);
  });
});
