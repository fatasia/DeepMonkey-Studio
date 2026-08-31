import { describe, expect, it } from "vitest";
import {
  JT_MAX_HEADER_SAMPLE_BYTES,
  JT_MAX_TOC_ENTRY_COUNT,
  probeJtStructure,
  type JtByteOrder
} from "./jtStructureProbe.js";

describe("JT structure probe", () => {
  it.each([
    { byteOrder: "little-endian" as const, tocOffset: 160 },
    { byteOrder: "big-endian" as const, tocOffset: 192 }
  ])("recognizes a JT 10 header and TOC in $byteOrder order", ({ byteOrder, tocOffset }) => {
    const input = fixture({ version: "10.5", byteOrder, tocOffset, entryCount: 3, fileSize: 512 });
    const result = probeJtStructure(input);

    expect(result).toMatchObject({
      status: "toc-recognized",
      recognizedFormat: "jt",
      probeScope: "structure-only",
      geometryParsed: false,
      version: { major: 10, minor: 5 },
      byteOrder,
      toc: { offset: tocOffset, offsetWidthBytes: 8, entrySizeBytes: 32, entryCount: 3, declaredTableBytes: 100 },
      issues: []
    });
  });

  it("uses the legacy 32-bit TOC layout for JT 8.x and 9.x", () => {
    for (const version of ["8.1", "9.5"]) {
      const result = probeJtStructure(fixture({ version, byteOrder: "little-endian", tocOffset: 128, entryCount: 2, fileSize: 256 }));
      expect(result.status, version).toBe("toc-recognized");
      expect(result.toc, version).toMatchObject({ offsetWidthBytes: 4, entrySizeBytes: 28, entryCount: 2, declaredTableBytes: 60 });
    }
  });

  it("returns a header-only result when the caller has not range-read the TOC", () => {
    const complete = fixture({ version: "10.0", byteOrder: "little-endian", tocOffset: 200, entryCount: 1, fileSize: 300 });
    const result = probeJtStructure({ fileSize: complete.fileSize, headerBytes: complete.headerBytes });

    expect(result.status).toBe("header-recognized");
    expect(result.toc).toMatchObject({ offset: 200 });
    expect(result.geometryParsed).toBe(false);
  });

  it("rejects invalid headers and does not infer JT from a file extension", () => {
    const invalidText = new Uint8Array(109).fill(0x20);
    expect(probeJtStructure({ fileSize: 200, headerBytes: invalidText }).issues[0]?.code).toBe("invalid-version-header");

    const brokenMarker = fixture({ version: "10.0", byteOrder: "little-endian", tocOffset: 160, entryCount: 1, fileSize: 256 });
    brokenMarker.headerBytes[77] = 0x20;
    expect(probeJtStructure(brokenMarker)).toMatchObject({ status: "invalid", recognizedFormat: "jt", issues: [{ code: "invalid-translation-marker" }] });

    const badOrder = fixture({ version: "10.0", byteOrder: "little-endian", tocOffset: 160, entryCount: 1, fileSize: 256 });
    badOrder.headerBytes[80] = 2;
    expect(probeJtStructure(badOrder).issues[0]?.code).toBe("invalid-byte-order");
  });

  it("reports versions whose binary layout is not implemented without parsing their TOC", () => {
    const input = fixture({ version: "11.0", byteOrder: "little-endian", tocOffset: 160, entryCount: 1, fileSize: 256 });
    const result = probeJtStructure(input);
    expect(result).toMatchObject({
      status: "unsupported-version",
      recognizedFormat: "jt",
      version: { major: 11, minor: 0 },
      issues: [{ code: "unsupported-version" }]
    });
    expect(result.toc).toBeUndefined();
  });

  it("bounds attacker-controlled samples, offsets, and TOC counts", () => {
    const hugeHeader = new Uint8Array(JT_MAX_HEADER_SAMPLE_BYTES + 1);
    expect(probeJtStructure({ fileSize: hugeHeader.length, headerBytes: hugeHeader }).issues[0]?.code).toBe("header-sample-too-large");

    const outOfBounds = fixture({ version: "10.0", byteOrder: "little-endian", tocOffset: 500, entryCount: 1, fileSize: 256 });
    expect(probeJtStructure(outOfBounds).issues[0]?.code).toBe("toc-out-of-bounds");

    const oversizedCount = fixture({ version: "10.0", byteOrder: "little-endian", tocOffset: 160, entryCount: JT_MAX_TOC_ENTRY_COUNT + 1, fileSize: 1_000_000_000 });
    expect(probeJtStructure(oversizedCount).issues[0]?.code).toBe("invalid-toc-entry-count");

    const impossibleTable = fixture({ version: "10.0", byteOrder: "little-endian", tocOffset: 160, entryCount: 10, fileSize: 200 });
    expect(probeJtStructure(impossibleTable).issues[0]?.code).toBe("toc-table-out-of-bounds");
  });
});

function fixture(options: {
  version: string;
  byteOrder: JtByteOrder;
  tocOffset: number;
  entryCount: number;
  fileSize: number;
}) {
  const major = Number(options.version.split(".")[0]);
  const headerBytes = new Uint8Array(major >= 10 ? 109 : 105).fill(0x20);
  const label = new TextEncoder().encode(`Version ${options.version} JT test`);
  headerBytes.set(label.subarray(0, 75));
  headerBytes.set([0x20, 0x0a, 0x0d, 0x0a, 0x20], 75);
  const littleEndian = options.byteOrder === "little-endian";
  headerBytes[80] = littleEndian ? 0 : 1;
  const headerView = new DataView(headerBytes.buffer);
  headerView.setInt32(81, 0, littleEndian);
  if (major >= 10) headerView.setBigUint64(85, BigInt(options.tocOffset), littleEndian);
  else headerView.setInt32(85, options.tocOffset, littleEndian);

  const tocBytes = new Uint8Array(4);
  new DataView(tocBytes.buffer).setInt32(0, options.entryCount, littleEndian);
  return { fileSize: options.fileSize, headerBytes, tocSample: { offset: options.tocOffset, bytes: tocBytes } };
}
