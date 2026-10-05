import { describe, expect, it } from "vitest";
import { compareFrameFingerprints, frameFingerprint } from "./pbrFrameFingerprintDiff.js";
import type { PbrFrameReadbackSnapshot } from "./pbrFrameCaptureReadback.js";

function rgbaSnapshot(width: number, height: number, seed: (x: number, y: number) => readonly [number, number, number, number]):
  PbrFrameReadbackSnapshot {
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256; // 256B 对齐,制造 padding(宽 10 时每行空 216B)。
  const bytes = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = seed(x, y);
      const base = y * bytesPerRow + x * 4;
      bytes[base] = r; bytes[base + 1] = g; bytes[base + 2] = b; bytes[base + 3] = a;
    }
  }
  return Object.freeze({ frameId: "f", resourceId: "present-color", width, height,
    format: "rgba8unorm", bytesPerRow, bytes });
}

describe("frame fingerprint diff (gpui-fast 借鉴项 2)", () => {
  const frame = (paint: (x: number, y: number) => readonly [number, number, number, number], frameId = "f") => {
    const snap = rgbaSnapshot(10, 8, paint);
    return { ...snap, frameId };
  };

  it("is deterministic: identical input yields identical hash and block means", () => {
    const paint = ((x: number, y: number) => [(x * 7) % 256, (y * 11) % 256, 30, 255]) as (x: number, y: number) => readonly [number, number, number, number];
    const a = frameFingerprint(frame(paint)), b = frameFingerprint(frame(paint));
    expect(b.hash).toBe(a.hash);
    expect(Array.from(b.blockMeans)).toEqual(Array.from(a.blockMeans));
  });

  it("ignores bytesPerRow padding: same content with wider padding keeps the hash", () => {
    // 同 10px 宽内容,两份快照 bytesPerRow 不同(128 对齐 vs 256 对齐),padding 区字节填毒 0xFF。
    const paint = ((x: number, y: number) => [x, y, 5, 255]) as (x: number, y: number) => readonly [number, number, number, number];
    const tight = rgbaSnapshot(10, 8, paint);
    const wideBytesPerRow = Math.ceil(10 * 4 / 512) * 512;
    const wide = new Uint8Array(wideBytesPerRow * 8).fill(0xff);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) {
      const [r, g, b, a] = paint(x, y);
      const base = y * wideBytesPerRow + x * 4;
      wide[base] = r; wide[base + 1] = g; wide[base + 2] = b; wide[base + 3] = a;
    }
    const a = frameFingerprint(tight);
    const b = frameFingerprint({ ...tight, bytesPerRow: wideBytesPerRow, bytes: wide });
    expect(b.hash).toBe(a.hash);
  });

  it("identical frames diff to zero; a localized change is pinpointed to its block", () => {
    const base = (x: number, y: number) => [x * 20, y * 20, 0, 255] as const;
    const a = frameFingerprint(frame(base));
    const b = frameFingerprint(frame(base));
    const same = compareFrameFingerprints(a, b);
    expect(same).toMatchObject({ compatible: true, changedBlocks: 0, ratio: 0, firstChangedBlock: undefined });

    // 9,7(右下角)单像素改红 → 必落在网格末块 (blocksX-1, blocksY-1) = (9,7)。
    const changed = rgbaSnapshot(10, 8, (x, y) => (x === 9 && y === 7 ? [255, 0, 0, 255] : base(x, y)));
    const c = frameFingerprint(changed);
    const diff = compareFrameFingerprints(a, c);
    expect(diff.compatible).toBe(true);
    if (diff.compatible) {
      expect(diff.changedBlocks).toBe(1);
      expect(diff.firstChangedBlock).toEqual([9, 7]);
      expect(diff.ratio).toBeGreaterThan(0);
      expect(diff.maxBlockDelta).toBeGreaterThan(0);
    }
  });

  it("mismatched size/format/resource is explicitly incompatible, never compared", () => {
    const paint = (x: number, y: number) => [x, y, 0, 255] as const;
    const a = frameFingerprint(frame(paint));
    const otherSize = frameFingerprint({ ...frame(paint), width: 12 });
    const otherFormat = frameFingerprint({ ...frame(paint), format: "bgra8unorm" });
    const otherResource = frameFingerprint({ ...frame(paint), resourceId: "opaque-hdr" });
    for (const other of [otherSize, otherFormat, otherResource]) {
      const diff = compareFrameFingerprints(a, other);
      expect(diff.compatible).toBe(false);
    }
  });

  it("swaps BGRA back to RGBA channel order (bgra8unorm fingerprints match rotated rgba content)", () => {
    // rgba 快照像素 (r,g,b) 与 bgra 快照像素 (b,g,r) 存储不同、内容相同 → 指纹一致。
    const rgba = frameFingerprint(rgbaSnapshot(8, 8, (x, y) => [x * 30, y * 30, 9, 255]));
    const bgraBytesPerRow = Math.ceil(8 * 4 / 256) * 256;
    const bytes = new Uint8Array(bgraBytesPerRow * 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const base = y * bgraBytesPerRow + x * 4;
      bytes[base] = 9; bytes[base + 1] = y * 30; bytes[base + 2] = x * 30; bytes[base + 3] = 255;
    }
    const bgra = frameFingerprint({ frameId: "f", resourceId: "present-color", width: 8, height: 8,
      format: "bgra8unorm", bytesPerRow: bgraBytesPerRow, bytes });
    expect(bgra.hash).toBe(rgba.hash);
  });
});
