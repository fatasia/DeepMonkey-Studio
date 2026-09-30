import { describe, expect, it } from "vitest";
import { decodeRadianceHdr, type RadianceHdrImage } from "./radianceHdr.js";
import { encodeRadianceHdr, quantizeRgbe } from "./radianceHdrEncode.js";

const image = (width: number, height: number, fill: (x: number, y: number) => readonly
  [number, number, number]): RadianceHdrImage => {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fill(x, y);
    const offset = (y * width + x) * 3;
    data[offset] = r; data[offset + 1] = g; data[offset + 2] = b;
  }
  return { width, height, data };
};

/**
 * RGBE 三通道共享一个指数：绝对量化步长由像素内最大分量决定（步长 = pixelMax·2^(E-8)，
 * E 使 max·scale∈[128,256) → 步长/pixelMax ≤ 1/128），小分量的相对误差没有下界保证。
 * 正确口径 = 每分量绝对误差 ≤ 0.01·pixelMax（半格最坏 0.0039·max，钳位翻倍留裕量）。
 */
const expectRoundTrip = (source: RadianceHdrImage): void => {
  const decoded = decodeRadianceHdr(encodeRadianceHdr(source));
  expect([decoded.width, decoded.height]).toEqual([source.width, source.height]);
  for (let pixel = 0; pixel < source.width * source.height; pixel++) {
    const offset = pixel * 3;
    const pixelMax = Math.max(source.data[offset]!, source.data[offset + 1]!, source.data[offset + 2]!);
    for (let channel = 0; channel < 3; channel++) {
      const original = source.data[offset + channel]!, recovered = decoded.data[offset + channel]!;
      if (original === 0) { expect(recovered).toBe(0); continue; }
      expect(Math.abs(recovered - original)).toBeLessThanOrEqual(pixelMax / 100);
    }
  }
};

describe("I-C16 Radiance HDR encode/decode roundtrip", () => {
  it("quantizes the reference triple exactly like the decoder's writePixel inverse", () => {
    expect(Array.from(quantizeRgbe(1, 0.5, 0.25))).toEqual([128, 64, 32, 129]);
    expect(Array.from(quantizeRgbe(0, 0, 0))).toEqual([0, 0, 0, 0]);
    // 表示域边界：≈2^-126 下溢钳零；>2^127 上溢 fail-closed。
    expect(Array.from(quantizeRgbe(1e-40, 0, 0))).toEqual([0, 0, 0, 0]);
    expect(() => quantizeRgbe(1e39, 0, 0)).toThrow(/RGBE representable range/);
  });
  it("round-trips a constant image through modern RLE run packets", () => {
    expectRoundTrip(image(8, 2, () => [1, 0.5, 0.25]));
  });
  it("preserves top-left row order (no flip) for -Y +X output", () => {
    const source = image(3, 2, (x, y) => [y === 0 ? 4 + x : 1 + x, 0, 0]);
    const decoded = decodeRadianceHdr(encodeRadianceHdr(source));
    expect(decoded.data[0]).toBeCloseTo(4, 5); // 顶行首像素 = data[0]，不翻转。
    expect(decoded.data[3 * 3]).toBeCloseTo(1, 5); // 底行首像素。
  });
  it("round-trips literal packets and mixed runs at odd widths", () => {
    expectRoundTrip(image(1, 4, (x, y) => [0.5 + 0.1 * y + 0.01 * x, 0.03, 0.007]));
    expectRoundTrip(image(3, 3, (x, y) => [x === y ? 2 : 0.1, 0.2, 0.3]));
    expectRoundTrip(image(300, 1, (x) => [x < 2 ? x + 1 : x % 7 * 0.5, 1, 0])); // 多包字面量。
  });
  it("round-trips the HDR dynamic range within the RGBE domain", () => {
    expectRoundTrip(image(16, 4, (x, y) =>
      [10 ** (-2 + (x + y) * 0.15), 10 ** (2 - x * 0.3), 10 ** (x === 0 ? 5.5 : 1)]));
  });
  it("round-trips a deterministic pseudo-random field", () => {
    let state = 0x2545F491;
    const next = (): number => { state = (state * 1103515245 + 12345) >>> 0; return state / 0xFFFFFFFF; };
    expectRoundTrip(image(24, 8, () => [next() * 3, next() * 0.02, next() ** 3 * 50]));
  });
  it("encodes zero pixels as decoder-zero RGBE", () => {
    const decoded = decodeRadianceHdr(encodeRadianceHdr(image(2, 2, () => [0, 0, 0])));
    for (const value of decoded.data) expect(value).toBe(0);
  });
  it("rejects negative, non-finite, and malformed input fail-closed", () => {
    const negative = image(2, 2, (x) => [x === 0 ? -0.5 : 1, 1, 1]);
    expect(() => encodeRadianceHdr(negative)).toThrow(/finite and non-negative/);
    const nan = image(2, 2, (x) => [x === 0 ? Number.NaN : 1, 1, 1]);
    expect(() => encodeRadianceHdr(nan)).toThrow(/finite and non-negative/);
    expect(() => encodeRadianceHdr(undefined as never)).toThrow(TypeError);
    expect(() => encodeRadianceHdr({ width: 0, height: 2, data: new Float32Array(6) }))
      .toThrow(RangeError);
    expect(() => encodeRadianceHdr({ width: 2, height: 2, data: new Float32Array(5) }))
      .toThrow(/width\*height\*3/);
    expect(() => encodeRadianceHdr({ width: 32768, height: 1, data: new Float32Array(32768 * 3) }))
      .toThrow(/below 32768/);
  });
});
