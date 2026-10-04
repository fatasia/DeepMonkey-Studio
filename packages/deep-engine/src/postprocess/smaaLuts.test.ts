// SMAA LUT 溯源与指纹门禁(AA-M2 L3):测试内独立解码仓内 three 0.185.1 SMAAPass.js
// L216/L218 的 data:image/png;base64 原数据(PNG inflate+unfilter 自包含实现),
// 与入库载荷(smaaLutsData.ts + smaaLuts.ts 的 sha256)逐字节对拍——换 three 版本、
// 手改 base64 或解码逻辑漂移都会在此抓红。规格实测:AreaTex 160×560 RGB(B 通道恒 0,
// 入库 rg8 交错)、SearchTex 66×33 灰度(官方 1px padding 规格,值域 {0,1,2})。
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SMAA_AREA_TEXTURE_HEIGHT, SMAA_AREA_TEXTURE_WIDTH, SMAA_SEARCH_TEXTURE_HEIGHT,
  SMAA_SEARCH_TEXTURE_WIDTH, DEEP_SMAA_AREA_SHA256, DEEP_SMAA_SEARCH_SHA256,
  decodeSmaaAreaLut, decodeSmaaSearchLut } from "./smaaLuts.js";
import { DEEP_SMAA_AREA_BASE64, DEEP_SMAA_SEARCH_BASE64 } from "./smaaLutsData.js";

const smaaPassSource = readFileSync(
  fileURLToPath(new URL("../../node_modules/three/examples/jsm/postprocessing/SMAAPass.js", import.meta.url)), "utf8");

/** 最小 PNG 解码(8-bit 灰度/RGB 非隔行),与 scripts/extractSmaaLuts.mts 同逻辑。 */
function decodePng(base64: string): { width: number; height: number; channels: number; pixels: Buffer } {
  const buffer = Buffer.from(base64, "base64");
  let offset = 8;
  const idat: Buffer[] = [];
  let width = 0, height = 0, colorType = -1;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]!; }
    else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : -1;
  expect(channels).toBeGreaterThan(0);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const scanline = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels]! : 0;
      const b = previous[x]!;
      const c = x >= channels ? previous[x - channels]! : 0;
      let value = scanline[x]!;
      if (filter === 1) value = (value + a) & 255;
      else if (filter === 2) value = (value + b) & 255;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      current[x] = value;
    }
    previous = current;
  }
  return { width, height, channels, pixels };
}

describe("SMAA LUT provenance gate", () => {
  const uris = [...smaaPassSource.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(match => match[1]!);

  it("finds exactly the two official LUT data URIs in the pinned three SMAAPass.js", () => {
    expect(uris).toHaveLength(2);
  });

  it("reproduces the committed payloads byte-for-byte from the SMAAPass.js data URIs", () => {
    const area = decodePng(uris[0]!), search = decodePng(uris[1]!);
    expect([area.width, area.height, area.channels]).toEqual([160, 560, 3]);
    expect([search.width, search.height, search.channels]).toEqual([66, 33, 1]);
    const areaBin = Buffer.alloc(160 * 560 * 2);
    for (let pixel = 0; pixel < 160 * 560; pixel++) {
      expect(area.pixels[pixel * 3 + 2]).toBe(0); // B channel carries nothing (official RG LUT)
      areaBin[pixel * 2] = area.pixels[pixel * 3]!;
      areaBin[pixel * 2 + 1] = area.pixels[pixel * 3 + 1]!;
    }
    expect(createHash("sha256").update(areaBin).digest("hex")).toBe(DEEP_SMAA_AREA_SHA256);
    expect(createHash("sha256").update(search.pixels).digest("hex")).toBe(DEEP_SMAA_SEARCH_SHA256);
    // 载荷与指纹同步(base64 ↔ sha256 双重锁)。
    const decodedArea = decodeSmaaAreaLut(), decodedSearch = decodeSmaaSearchLut();
    expect(Buffer.from(decodedArea.buffer, decodedArea.byteOffset, decodedArea.length).equals(areaBin)).toBe(true);
    expect(Buffer.from(decodedSearch.buffer, decodedSearch.byteOffset, decodedSearch.length).equals(search.pixels)).toBe(true);
    expect(DEEP_SMAA_AREA_BASE64.length).toBeGreaterThan(0);
    expect(DEEP_SMAA_SEARCH_BASE64.length).toBeGreaterThan(0);
  });

  it("exposes the documented sampling probes from the official tables", () => {
    const area = decodeSmaaAreaLut();
    // 官方正交表几何:e1/e2 各 5 档×16 texel,查表值域 [0, 222](量化 8bit)。
    const texel = (x: number, y: number): [number, number] => {
      const o = (y * 160 + x) * 2;
      return [area[o]!, area[o + 1]!];
    };
    expect(texel(0, 0)).toEqual([0, 0]); // 无边缘图案(pattern 0)= 零权重
    expect(texel(2, 2)).toEqual([0, 0]); // e1=e2=0 档近端:无 crossing → 零权重(官方几何语义)
    expect(SMAA_AREA_TEXTURE_WIDTH).toBe(160);
    expect(SMAA_AREA_TEXTURE_HEIGHT).toBe(560);
    expect(SMAA_SEARCH_TEXTURE_WIDTH).toBe(66);
    expect(SMAA_SEARCH_TEXTURE_HEIGHT).toBe(33);
    const search = decodeSmaaSearchLut();
    expect(Math.max(...search)).toBeLessThanOrEqual(2); // 官方编码:{0,1,2} 步长修正
    expect(search[0]).toBe(0); // padding 行
  });
});
