import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2C_PROBE_EDGE_DITHER_PIXELS_PER_WIDTH, A2cFrameProbe, analyzeOpaqueHdrAlphaCoverage,
  judgeA2cProbeFrame } from "./a2cFrameProbe.js";
import { isPbrFrameReadbackSnapshot } from "./pbrFrameCaptureReadback.js";

const WIDTH = 32, HEIGHT = 32;

/** float32 → IEEE half(与生产 halfToFloat 互逆)。 */
function toHalf(value: number): number {
  const float = new Float32Array(1), bits = new Uint32Array(float.buffer);
  float[0] = value;
  const x = bits[0]!;
  const sign = (x >> 16) & 0x8000;
  const exponent = (x >> 23) & 0xff, fraction = x & 0x007fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (fraction ? 1 : 0);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 31) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    return sign | (fraction | 0x00800000) >> (14 - halfExponent);
  }
  return sign | halfExponent << 10 | fraction >> 13;
}

/** 逐像素场景:alpha 半覆盖(0.5)+ RGB 水平棋盘交替(0/1)⇒ 判据的有效臂读数。 */
function ditheredRgba16Float(): Uint8Array {
  const bytes = new Uint8Array(WIDTH * HEIGHT * 8);
  const view = new DataView(bytes.buffer);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    view.setUint16(pixel * 8, toHalf(0.2 + 0.6 * (pixel % 2)), true);      // R 交替
    view.setUint16(pixel * 8 + 2, toHalf(0.2 + 0.6 * ((pixel + 1) % 2)), true); // G 反相交替
    view.setUint16(pixel * 8 + 4, toHalf(0.5), true);                      // B 恒定
    view.setUint16(pixel * 8 + 6, toHalf(0.5), true);                      // alpha 半覆盖
  }
  return bytes;
}

/** 同 alpha、RGB 全平(实心板)⇒ 判据的无效臂读数。 */
function flatRgba16Float(): Uint8Array {
  const bytes = new Uint8Array(WIDTH * HEIGHT * 8);
  const view = new DataView(bytes.buffer);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    view.setUint16(pixel * 8, toHalf(0.5), true); view.setUint16(pixel * 8 + 2, toHalf(0.5), true);
    view.setUint16(pixel * 8 + 4, toHalf(0.5), true); view.setUint16(pixel * 8 + 6, toHalf(0.5), true);
  }
  return bytes;
}

describe("opaque-hdr a2c probe analysis", () => {
  it("counts alpha passthrough and horizontal dither edges (effective arm)", () => {
    const stats = analyzeOpaqueHdrAlphaCoverage({ width: WIDTH, height: HEIGHT, format: "rgba16float",
      bytesPerRow: WIDTH * 8, bytes: ditheredRgba16Float() });
    if ("error" in stats) throw new Error(stats.error);
    expect(stats.alphaNonOpaquePixels).toBe(WIDTH * HEIGHT);
    // 每行 W-1 个水平边缘 × H 行,远超 8·W 阈值。
    expect(stats.edgePixels).toBe((WIDTH - 1) * HEIGHT);
    expect(stats.edgePixels).toBeGreaterThan(8 * WIDTH);
  });

  it("keeps the flat solid-board readout below the threshold (ineffective arm)", () => {
    const stats = analyzeOpaqueHdrAlphaCoverage({ width: WIDTH, height: HEIGHT, format: "rgba16float",
      bytesPerRow: WIDTH * 8, bytes: flatRgba16Float() });
    if ("error" in stats) throw new Error(stats.error);
    expect(stats.alphaNonOpaquePixels).toBe(WIDTH * HEIGHT);
    expect(stats.edgePixels).toBe(0);
  });

  it("parses the rgba8unorm byte branch and fails closed on other formats", () => {
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
      bytes[pixel * 4] = pixel % 2 === 0 ? 32 : 224; bytes[pixel * 4 + 1] = 64; bytes[pixel * 4 + 2] = 64;
      bytes[pixel * 4 + 3] = 128; // alpha 半覆盖
    }
    const stats = analyzeOpaqueHdrAlphaCoverage({ width: WIDTH, height: HEIGHT, format: "rgba8unorm",
      bytesPerRow: WIDTH * 4, bytes });
    if ("error" in stats) throw new Error(stats.error);
    expect(stats.alphaNonOpaquePixels).toBe(WIDTH * HEIGHT);
    expect(stats.edgePixels).toBe((WIDTH - 1) * HEIGHT);
    expect(analyzeOpaqueHdrAlphaCoverage({ width: 1, height: 1, format: "bgra8unorm", bytesPerRow: 4,
      bytes: new Uint8Array(4) })).toEqual({ error: expect.stringContaining("unsupported opaque-hdr readback format") });
  });
});

describe("a2c probe verdict (handoff criterion: alphaNonOpaque>0 && edgePixels>8·W)", () => {
  it("judges effective when alpha passthrough coexists with dither density", () => {
    const verdict = judgeA2cProbeFrame(7, WIDTH, { alphaNonOpaquePixels: 5000, edgePixels: 8 * WIDTH + 1 });
    expect(verdict.verdict).toBe("effective");
    expect(verdict.frame).toBe(7);
    expect(verdict.edgeDitherThreshold).toBe(8 * WIDTH);
    expect(verdict.reason).toBeUndefined();
  });

  it("judges ineffective when alpha passthrough lands on a flat board", () => {
    const verdict = judgeA2cProbeFrame(7, WIDTH, { alphaNonOpaquePixels: 5000, edgePixels: 8 * WIDTH });
    expect(verdict.verdict).toBe("ineffective");
    expect(verdict.reason).toContain("without generating sample masks");
  });

  it("fails open as inconclusive when the a2c material produced no partial alpha", () => {
    const verdict = judgeA2cProbeFrame(7, WIDTH, { alphaNonOpaquePixels: 0, edgePixels: 3 });
    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.reason).toContain("no non-opaque target alpha");
  });

  it("fails open as inconclusive when the readback is unavailable", () => {
    const verdict = judgeA2cProbeFrame(7, WIDTH, { error: "opaque-hdr probe readback unavailable: absent" });
    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.reason).toContain("unavailable");
  });
});

function probeFixture(fill: (bytes: Uint8Array, bytesPerRow: number, width: number, height: number) => void) {
  // 挂起式 device.lost(与 pbrFrameCaptureReadback.test 同构):readback ticket 监听它,
  // 立即 resolve 会把读回判成 device lost。
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  const device = { limits: { maxBufferSize: 1 << 28 }, lost,
    createBuffer: (descriptor: GPUBufferDescriptor) => {
      const bytes = new Uint8Array(descriptor.size as number);
      const buffer = { size: descriptor.size, usage: descriptor.usage, mapState: "unmapped", bytes,
        destroy: vi.fn(), unmap: vi.fn(() => { buffer.mapState = "unmapped"; }),
        mapAsync: () => Promise.resolve().then(() => { buffer.mapState = "mapped"; }),
        getMappedRange: (offset = 0, size = bytes.byteLength) => bytes.buffer.slice(offset, offset + size),
      };
      return buffer as unknown as GPUBuffer & { bytes: Uint8Array };
    } } as unknown as GPUDevice;
  const encoder = { copyTextureToBuffer: vi.fn(
    (_source: GPUImageCopyTexture, destination: GPUImageCopyBuffer, size: GPUExtent3D) => {
      const target = destination.buffer as unknown as { bytes: Uint8Array };
      const width = (size as GPUExtent3DDict).width, height = (size as GPUExtent3DDict).height;
      fill(target.bytes, destination.bytesPerRow!, width, height);
    }) } as unknown as GPUCommandEncoder;
  const texture = { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1,
    dimension: "2d", format: "rgba16float", usage: (globalThis as { GPUTextureUsage: { COPY_SRC: number } }).GPUTextureUsage.COPY_SRC } as unknown as GPUTexture;
  return { device, encoder, texture };
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 1, COPY_DST: 2, MAP_READ: 4 });
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("A2cFrameProbe one-shot controller", () => {
  it("stays idle without a2c batches and probes exactly once (settled verdict freezes)", async () => {
    const probe = new A2cFrameProbe();
    expect(probe.wantsProbe(false)).toBe(false);
    expect(probe.metrics()).toBeUndefined();
    const fixture = probeFixture((bytes, bytesPerRow) => bytes.fill(0x11));
    probe.beginFrame(1, fixture.device, fixture.encoder, fixture.texture);
    probe.collectAfterSubmit();
    await vi.waitFor(() => expect(probe.metrics()).toBeDefined());
    const verdict = probe.metrics()!;
    // 0x11 全平:alpha≈0.067 全部非 opaque、零边缘 ⇒ 判无效(与取证读数同构)。
    expect(verdict.verdict).toBe("ineffective");
    expect(verdict.frame).toBe(1);
    expect(verdict.edgeDitherThreshold).toBe(8 * WIDTH);
    expect(probe.wantsProbe(true)).toBe(false);
    // 终态后 beginFrame 是 no-op,不会再排队读回。
    probe.beginFrame(2, fixture.device, fixture.encoder, fixture.texture);
    probe.cancelFrame();
    expect(probe.metrics()).toBe(verdict);
  });

  it("settles effective when the mocked readback carries the dither pattern", async () => {
    const probe = new A2cFrameProbe();
    const fixture = probeFixture((bytes, bytesPerRow, width, height) => {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = y * bytesPerRow + x * 8;
        bytes[offset] = x % 2 === 0 ? 0x3d : 0x00; bytes[offset + 1] = x % 2 === 0 ? 0x00 : 0x3d;
        bytes[offset + 6] = 0x38; bytes[offset + 7] = 0x38; // half 0.5
      }
    });
    probe.beginFrame(3, fixture.device, fixture.encoder, fixture.texture);
    probe.collectAfterSubmit();
    await vi.waitFor(() => expect(probe.metrics()?.verdict).toBe("effective"));
    expect(probe.metrics()).toMatchObject({ frame: 3, verdict: "effective" });
  });

  it("freezes an inconclusive verdict when the frame fails before submit (no retry loop)", () => {
    const probe = new A2cFrameProbe();
    const fixture = probeFixture(() => undefined);
    expect(probe.wantsProbe(true)).toBe(true);
    probe.beginFrame(4, fixture.device, fixture.encoder, fixture.texture);
    probe.cancelFrame("frame failed before submit; probe cancelled");
    expect(probe.metrics()).toMatchObject({ frame: 4, verdict: "inconclusive" });
    expect(probe.metrics()?.reason).toContain("cancelled");
    expect(probe.wantsProbe(true)).toBe(false);
  });

  it("reports unavailable readbacks as inconclusive instead of failing the loop", async () => {
    const probe = new A2cFrameProbe();
    const lost = new Promise<GPUDeviceLostInfo>(() => {});
    const device = { limits: { maxBufferSize: 1 << 28 }, lost, createBuffer: () => { throw new Error("no buffers"); } } as unknown as GPUDevice;
    const encoder = { copyTextureToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
    const texture = { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1,
      dimension: "2d", format: "rgba16float", usage: (globalThis as { GPUTextureUsage: { COPY_SRC: number } }).GPUTextureUsage.COPY_SRC } as unknown as GPUTexture;
    probe.beginFrame(5, device, encoder, texture);
    probe.collectAfterSubmit();
    await vi.waitFor(() => expect(probe.metrics()?.verdict).toBe("inconclusive"));
    expect(probe.metrics()?.reason).toContain("unavailable");
    expect(isPbrFrameReadbackSnapshot).toBeDefined();
  });
});
