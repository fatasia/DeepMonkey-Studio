/**
 * Radiance HDR（`.hdr`，RGBE）编码器——I-C16 导出管线的 CPU 侧。
 *
 * 与 `radianceHdr.ts` 的 `decodeRadianceHdr` 同族互逆：modern RLE 布局
 * （`2,2` 魔数 + 每扫描行 4 通道独立 RLE），RGBE 量化与解码 `writePixel` 的
 * `value = mantissa · 2^(exp−136)` 严格互逆（`exp−136 = (exp−128)−8`）。
 *
 * == 量化 ==
 * 取 `E = floor(log2(max)) + 1`，`scale = 2^(8−E)`，各分量 `round(分量·scale)` 钳 255：
 * mantissa 落在 [128,255]，无需 ceil 进位补偿分支（floor+1 保证区间，浮点边缘的钳位
 * 误差 ≤ 半格的两倍 = 相对 1/128）。零/欠载（max ≤ 0 或指数下溢 ≈2^-126）输出全零 RGBE；
 * 超出表示域（≈2^127）fail-closed 抛出（钳白会伪装高光正确）。
 *
 * == 行序 ==
 * 输出 `-Y +X`（Radiance 标准）：仓内解码器 `coordinate(Y, "-")` 是**恒等映射**
 * （`y = scanline`，top-left 行主序；`+Y` 才翻转——radianceHdr.test.ts 的取向矩阵锁定），
 * 因此文件第 s 行直接携带 data 第 y = s 行，roundtrip 逐像素对位不翻转。
 *
 * == modern / flat 选择 ==
 * 与仓内解码器 `decodeRadianceHdr` 的判定合同互逆：`second.length >= 8` 才进入
 * modern-RLE 分支，因此 **width < 8 输出 flat 像素**（每像素 4 字节，无扫描行头）——
 * 这也是标准 Radiance `RGBE_WritePixels_RLE` 的行为。width ∈ [8, 0x7FFF] 走 modern RLE。
 *
 * == fail-closed ==
 * 负值与非有限输入拒绝（Radiance RGBE 无负值表示；物理辐射非负）。
 */

import type { RadianceHdrImage } from "./radianceHdr.js";

const HEADER_LINES = Object.freeze([
  "#?RADIANCE\n",
  "FORMAT=32-bit_rle_rgbe\n",
  "\n",
] as const);

const RLE_RUN_MAX = 127;
const RLE_RUN_THRESHOLD = 3;

/** RGBE 量化：mantissa∈[128,255]；max ≤ 0 或指数下溢返回全零（exp=0 是解码器的零语义）。 */
export function quantizeRgbe(red: number, green: number, blue: number):
  readonly [number, number, number, number] {
  const max = Math.max(red, green, blue);
  if (max <= 0) return Object.freeze([0, 0, 0, 0]);
  const exponent = Math.floor(Math.log2(max)) + 1;
  const code = exponent + 128;
  if (code < 0) return Object.freeze([0, 0, 0, 0]); // 低于 RGBE 表示域（≈2^-126）：钳零。
  if (code > 255) {
    throw new RangeError(`Radiance HDR value ${max} exceeds the RGBE representable range`
      + " (≈2^127); clamp exposure before export.");
  }
  const scale = 2 ** (8 - exponent);
  return Object.freeze([
    Math.min(255, Math.round(red * scale)),
    Math.min(255, Math.round(green * scale)),
    Math.min(255, Math.round(blue * scale)),
    code,
  ]);
}

function encodeRleChannel(target: number[], channel: Uint8Array, length: number): void {
  let index = 0;
  while (index < length) {
    let run = 1;
    while (run < RLE_RUN_MAX && index + run < length && channel[index + run] === channel[index]) run++;
    if (run >= RLE_RUN_THRESHOLD) {
      target.push(128 + run, channel[index]!);
      index += run;
      continue;
    }
    // 短游程并入字面量包（≤127 个；在下一个 ≥3 游程起点截断）。
    let literalEnd = index;
    while (literalEnd < length && literalEnd - index < RLE_RUN_MAX) {
      let forwardRun = 1;
      while (forwardRun < RLE_RUN_THRESHOLD && literalEnd + forwardRun < length
        && channel[literalEnd + forwardRun] === channel[literalEnd]) forwardRun++;
      if (forwardRun >= RLE_RUN_THRESHOLD) break;
      literalEnd += forwardRun;
    }
    target.push(literalEnd - index);
    for (let offset = index; offset < literalEnd; offset++) target.push(channel[offset]!);
    index = literalEnd;
  }
}

/** 将线性 RGB 图像编码为 Radiance HDR modern-RLE 字节流（`-Y +X`，与解码恒等映射互逆）。 */
export function encodeRadianceHdr(image: RadianceHdrImage): Uint8Array {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    throw new TypeError("Radiance HDR image is required.");
  }
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("Radiance HDR dimensions must be safe integers ≥ 1.");
  }
  if (width >= 0x8000) {
    // modern-RLE 行头宽度高位不得落进解码器的 flat-scanline 探测位（header[2] & 0x80）。
    throw new RangeError("Radiance HDR width must be below 32768 for modern RLE.");
  }
  if (!(data instanceof Float32Array) || data.length !== width * height * 3) {
    throw new RangeError("Radiance HDR data must be Float32Array of width*height*3 texels.");
  }
  for (let index = 0; index < data.length; index++) {
    const value = data[index]!;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Radiance HDR texel ${index} must be finite and non-negative (RGBE has`
        + ` no negative representation); got ${value}.`);
    }
  }
  const bytes: number[] = [];
  for (const line of HEADER_LINES) {
    for (let index = 0; index < line.length; index++) bytes.push(line.charCodeAt(index));
  }
  for (const character of `-Y ${height} +X ${width}\n`) bytes.push(character.charCodeAt(0));
  const quantized = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const texel = (y * width + x) * 3;
      const [r, g, b, e] = quantizeRgbe(data[texel]!, data[texel + 1]!, data[texel + 2]!);
      quantized[x] = r; quantized[width + x] = g; quantized[width * 2 + x] = b;
      quantized[width * 3 + x] = e;
    }
    if (width < 8) {
      // 解码器仅对 second.length ≥ 8 试探 modern 魔数；更小的宽度按 flat 像素写出。
      for (let x = 0; x < width; x++) {
        bytes.push(quantized[x]!, quantized[width + x]!, quantized[width * 2 + x]!,
          quantized[width * 3 + x]!);
      }
      continue;
    }
    bytes.push(2, 2, (width >> 8) & 0xFF, width & 0xFF);
    for (let channel = 0; channel < 4; channel++) {
      const scratch: number[] = [];
      encodeRleChannel(scratch,
        channel === 0 ? quantized
        : channel === 1 ? quantized.subarray(width, width * 2)
        : channel === 2 ? quantized.subarray(width * 2, width * 3)
        : quantized.subarray(width * 3, width * 4), width);
      bytes.push(...scratch);
    }
  }
  return Uint8Array.from(bytes);
}
