// SMAA LUT 离线提取器:从仓内 three 0.185.1 examples/jsm/postprocessing/SMAAPass.js
// (L216 _getAreaTexture / L218 _getSearchTexture,data:image/png;base64)解码两张官方
// LUT 并入库 src/postprocess/smaaLutsData.ts(纯 base64 载荷)+ 校验 smaaLuts.ts 指纹。
// 重新生成:pnpm --dir packages/deep-engine exec tsx scripts/extractSmaaLuts.mts
// 校验模式(不重写,CI/复核用):tsx scripts/extractSmaaLuts.mts --check
//
// 解码为**裸像素 bin**(PNG inflate IDAT + unfilter 自实现,node:zlib,零第三方依赖):
//   AreaTex  160×560 PNG RGB8 → rg8 交错 160×560×2(B 通道实测恒 0,官方 RG 双通道 LUT)
//   SearchTex 66×33 PNG 灰度8 → r8 66×33×1(官方含 1px padding 行/列,值域 {0,1,2})
// 入库指纹(smaaLuts.ts 自钉,测试把守):DEEP_SMAA_AREA_SHA256 / DEEP_SMAA_SEARCH_SHA256。
// 版本随仓内 three 固定(MIT);体量门禁:数据文件 2000 字符/行长,保持 ≤300 行。
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SMAA_PASS_PATH = "../node_modules/three/examples/jsm/postprocessing/SMAAPass.js";
const OUTPUT_PATH = "../src/postprocess/smaaLutsData.ts";
const LINE_WIDTH = 2000;

const source = readFileSync(fileURLToPath(new URL(SMAA_PASS_PATH, import.meta.url)), "utf8");
const uris = [...source.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(match => match[1]!);
if (uris.length !== 2) throw new Error(`Expected 2 SMAA LUT data URIs in SMAAPass.js, found ${uris.length}.`);

/** 最小 PNG 解码:仅支持 8-bit 灰度/RGB/RGBA 非隔行(两张官方 LUT 即此形态)。 */
function decodePng(base64: string): { width: number; height: number; channels: number; pixels: Uint8Array } {
  const buffer = Buffer.from(base64, "base64");
  let offset = 8;
  const idat: Buffer[] = [];
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; colorType = data[9]!; interlace = data[12]!; }
    else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`Unsupported PNG depth ${depth}/interlace ${interlace} in SMAA LUT.`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : -1;
  if (channels < 0) throw new Error(`Unsupported PNG color type ${colorType} in SMAA LUT.`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, scanline = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels]! : 0, b = previous[x]!, c = x >= channels ? previous[x - channels]! : 0;
      let value = scanline[x]!;
      if (filter === 1) value = (value + a) & 255;
      else if (filter === 2) value = (value + b) & 255;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter} in SMAA LUT.`);
      current[x] = value;
    }
    previous = current;
  }
  return { width, height, channels, pixels };
}

const area = decodePng(uris[0]!), search = decodePng(uris[1]!);
if (area.width !== 160 || area.height !== 560 || area.channels !== 3) throw new Error(`Unexpected AreaTex ${area.width}x${area.height}x${area.channels}, expected 160x560 RGB.`);
if (search.width !== 66 || search.height !== 33 || search.channels !== 1) throw new Error(`Unexpected SearchTex ${search.width}x${search.height}x${search.channels}, expected 66x33 R.`);
for (let pixel = 0; pixel < 160 * 560; pixel++) if (area.pixels[pixel * 3 + 2] !== 0) throw new Error("AreaTex blue channel is nonzero; encoding assumption broken.");

/** RGB 解码产物 → rg8 交错(AreaTex)/裸 r8(SearchTex)。 */
const areaBin = Buffer.alloc(160 * 560 * 2);
for (let pixel = 0; pixel < 160 * 560; pixel++) {
  areaBin[pixel * 2] = area.pixels[pixel * 3]!;
  areaBin[pixel * 2 + 1] = area.pixels[pixel * 3 + 1]!;
}
const searchBin = Buffer.from(search.pixels);
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const hashes = { area: sha256(areaBin), search: sha256(searchBin) };

const payload = (bytes: Buffer): string => {
  const base64 = bytes.toString("base64");
  const lines: string[] = [];
  for (let offset = 0; offset < base64.length; offset += LINE_WIDTH) lines.push(`  "${base64.slice(offset, offset + LINE_WIDTH)}"`);
  return lines.join("\n+ ");
};

const header = `/**
 * SMAA LUT 纯数据载荷(AA-M2 L3 空间层):AreaTex(rg8 交错 160×560×2)与
 * SearchTex(r8 66×33×1)的 base64。本文件由 scripts/extractSmaaLuts.mts 生成,
 * 来源:仓内 three 0.185.1 examples/jsm/postprocessing/SMAAPass.js L216/L218 的
 * data:image/png;base64(iryoku/smaa v2.8 官方 LUT,MIT);重建命令见该脚本头注释。
 *
 * 解码实测规格(与部分旧文档的"单通道 R8/64×16"记载不同,以本解码为准):
 * AreaTex PNG 为 RGB8,B 通道实测恒 0(官方 RG 双通道 LUT:R=一侧越权面积、
 * G=另一侧),入库 rg8 交错;SearchTex PNG 为 66×33 灰度(官方规格含 1px padding
 * 行/列,值域 {0,1,2} = 搜索端点步长修正编码),入库裸 r8。
 *
 * 内容指纹在 ../smaaLuts.ts 自钉(DEEP_SMAA_AREA_SHA256 / DEEP_SMAA_SEARCH_SHA256):
 * 手改 base64 或换 three 版本导致内容漂移都会被 smaaLuts.test.ts 抓红。
 * 解码逻辑与导出面见 ../smaaLuts.ts;本文件不手改。
 */
export const DEEP_SMAA_AREA_BASE64 =
${payload(areaBin)};

export const DEEP_SMAA_SEARCH_BASE64 =
${payload(searchBin)};
`;

const outputPath = fileURLToPath(new URL(OUTPUT_PATH, import.meta.url));
if (process.argv[2] === "--check") {
  const existing = readFileSync(outputPath, "utf8");
  const ok = existing === header;
  console.log(`check: smaaLutsData.ts ${ok ? "matches" : "DIFFERS from"} regenerated payload`);
  console.log(`area sha256 ${hashes.area}`);
  console.log(`search sha256 ${hashes.search}`);
  if (!ok) process.exitCode = 1;
} else {
  writeFileSync(outputPath, header);
  console.log(`wrote ${outputPath}`);
  console.log(`area.bin rg8 sha256 ${hashes.area}`);
  console.log(`search.bin r8 sha256 ${hashes.search}`);
}
