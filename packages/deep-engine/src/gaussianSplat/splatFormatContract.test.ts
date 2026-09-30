import { describe, expect, it } from "vitest";
import {
  SPLAT_MAX_SPLAT_COUNT,
  SPLAT_PLY_HEADER_MAX_BYTES,
  SPLAT_REQUIRED_PROPERTIES,
  SplatParseError,
  parseSplatPlyHeader,
  splatPlyPayloadByteLength,
} from "./splatFormatContract.js";
import {
  LUIGI_REAL_HEADER,
  LUIGI_REAL_HEADER_BYTE_LENGTH,
  buildSplatPlyFixture,
} from "./splatPlyTestUtils.js";

function headerFrom(properties: string[], formatLine = "format binary_little_endian 1.0"): Uint8Array {
  return buildSplatPlyFixture({ propertyNames: properties, formatLine, splatCount: 1 }).bytes;
}

describe("splatFormatContract (3DGS PLY fail-closed header contract)", () => {
  it("parses the real INRIA-shaped header (17 float properties, no f_rest, normals present)", () => {
    const header = new TextEncoder().encode(`${LUIGI_REAL_HEADER}\n`);
    const payload = new Uint8Array(14526 * 17 * 4);
    const bytes = new Uint8Array(header.length + payload.length);
    bytes.set(header, 0);
    bytes.set(payload, header.length);

    const contract = parseSplatPlyHeader(bytes);
    expect(contract.format).toBe("ply-binary-little-endian-3dgs-v1");
    expect(contract.splatCount).toBe(14526);
    expect(contract.floatStride).toBe(17);
    expect(contract.byteStride).toBe(68);
    expect(contract.shDegree).toBe(0);
    expect(contract.shRestCount).toBe(0);
    expect(contract.hasNormals).toBe(true);
    expect(contract.headerByteLength).toBe(LUIGI_REAL_HEADER_BYTE_LENGTH);
    expect(contract.propertyColumns.get("rot_3")).toBe(16);
    expect(splatPlyPayloadByteLength(contract)).toBe(987_768);
  });

  it("rejects files without the PLY magic before scanning any header text", () => {
    expect(() => parseSplatPlyHeader(new TextEncoder().encode("not a ply"))).toThrow(SplatParseError);
    expect(() => parseSplatPlyHeader(new Uint8Array(0))).toThrow(/magic/u);
  });

  it("rejects ASCII and big-endian formats explicitly instead of downgrading", () => {
    const required = [
      "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
      "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
    ];
    expect(() => parseSplatPlyHeader(headerFrom(required, "format ascii 1.0")))
      .toThrow(/binary_little_endian/u);
    expect(() => parseSplatPlyHeader(headerFrom(required, "format binary_big_endian 1.0")))
      .toThrow(/binary_little_endian/u);
  });

  it("rejects each missing required property by name (fail-closed per field)", () => {
    const full = [
      "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
      "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
    ];
    for (const dropped of full) {
      const without = full.filter((name) => name !== dropped);
      try {
        parseSplatPlyHeader(headerFrom(without));
        expect.unreachable(`missing "${dropped}" must be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(SplatParseError);
        expect((error as Error).message).toContain(dropped);
      }
    }
  });

  it("accepts only complete SH bands (0/9/24/45 contiguous) and rejects partial sets", () => {
    const base = [
      "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
      "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
    ];
    const degrees = [0, 1, 2, 3];
    const bands = [0, 9, 24, 45];
    for (const band of bands) {
      const fixture = buildSplatPlyFixture({ propertyNames: base, shRestCount: band, splatCount: 1 });
      expect(parseSplatPlyHeader(fixture.bytes).shDegree).toBe(degrees[bands.indexOf(band)]);
    }
    // 10 个 f_rest:带不完整(合法集只有 0/9/24/45)。
    const partialHeader = ["ply", "format binary_little_endian 1.0", "element vertex 1",
      ...base.map((name) => `property float ${name}`),
      ...Array.from({ length: 10 }, (_, i) => `property float f_rest_${i}`),
      "end_header", ""].join("\n");
    const partialBytes = new TextEncoder().encode(partialHeader);
    expect(() => parseSplatPlyHeader(new Uint8Array([...partialBytes, 0, 0, 0, 0])))
      .toThrow(/complete SH band/u);

    // 缺口带:只有 f_rest_1,不是从 f_rest_0 连续。
    const holed = buildSplatPlyFixture({ propertyNames: [...base, "f_rest_1"], splatCount: 1 });
    expect(() => parseSplatPlyHeader(holed.bytes)).toThrow(/complete SH band/u);
  });

  it("rejects non-vertex elements, duplicate properties, bad types and oversized counts", () => {
    const headerText = ["ply", "format binary_little_endian 1.0", "element vertex 1",
      "property float x", "element face 0", "property list uchar int vertex_indices",
      "end_header", ""].join("\n");
    expect(() => parseSplatPlyHeader(new TextEncoder().encode(headerText)))
      .toThrow(/element "face"/u);

    const duplicated = buildSplatPlyFixture({
      propertyNames: [...SPLAT_REQUIRED_PROPERTIES, "x"],
      splatCount: 1,
    });
    expect(() => parseSplatPlyHeader(duplicated.bytes)).toThrow(/duplicate/i);

    const halfType = ["ply", "format binary_little_endian 1.0", "element vertex 1",
      "property double x", "property float y", "property float z", "property float f_dc_0",
      "property float f_dc_1", "property float f_dc_2", "property float opacity",
      "property float scale_0", "property float scale_1", "property float scale_2",
      "property float rot_0", "property float rot_1", "property float rot_2", "property float rot_3",
      "end_header", ""].join("\n");
    expect(() => parseSplatPlyHeader(new TextEncoder().encode(halfType))).toThrow(/double/u);

    const oversized = new TextEncoder().encode(
      `ply\nformat binary_little_endian 1.0\nelement vertex ${SPLAT_MAX_SPLAT_COUNT + 1}\n` +
      "property float x\nend_header\n");
    expect(() => parseSplatPlyHeader(oversized)).toThrow(/budget/u);
  });

  it("refuses unbounded header scans (no end_header inside the budget)", () => {
    const junk = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\n${"x".repeat(SPLAT_PLY_HEADER_MAX_BYTES)}`);
    expect(() => parseSplatPlyHeader(junk)).toThrow(/end_header/u);
  });
});
