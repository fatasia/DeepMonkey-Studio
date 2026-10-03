// C3 LTC 表离线生成器:用 src/lighting/ltc.ts 的确定性拟合器构建 64×64 LUT 并入库
// src/lighting/ltcTablesData.ts(base64 纯数据载荷)+ src/lighting/ltcTables.ts(解码逻辑与
// sha256 自钉)。重新生成:
//   pnpm --dir packages/deep-engine exec tsx scripts/generateLtcTables.mts
// 生成是确定性的(固定 Fibonacci 格点 + 无 RNG Nelder-Mead),重跑应产出逐位相同内容;
// 拟合质量(对 MC 参考的相对误差)由 ltc.test.ts 把守,本脚本只负责生成与入库。
// 体量门禁:数据文件以 2000 字符/行长行入库,保持新文件 ≤300 行(sourceSizeGate)。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLtcLut, LTC_LUT_FLOATS_PER_TEXEL, LTC_LUT_SIZE } from "../src/lighting/ltc.js";
import { sha256Bytes } from "../src/shaderPackage/hash.js";

const started = Date.now();
const lut = buildLtcLut();
const bytes = new Uint8Array(lut.buffer, lut.byteOffset, lut.byteLength);
const sha256 = sha256Bytes(bytes);
const base64 = Buffer.from(bytes).toString("base64");

const dataUrl = fileURLToPath(new URL("../src/lighting/ltcTablesData.ts", import.meta.url));
const dataHeader = `/**
 * C3 LTC 高光矩阵表(64×64,行=感知粗糙度 [0.045,1],列=cosθ [0,1);每 texel 8 f32:
 * invM row0+pad+row1+amplitude,row2≡(0,0,1))。
 *
 * 出处:由 scripts/generateLtcTables.mts 用 src/lighting/ltc.ts 的确定性拟合器生成
 * (Heitz/Hanika/d'Eon/Dachsbacher 2016 公开领域算法,自实现);重建命令见该脚本头注释。
 * 内容指纹 DEEP_LTC_LUT_SHA256 自钉:手改 base64 或 fitter 漂移都会被 ltc.test.ts 抓红
 * (指纹 + 抽样 texel 对拍 fitLtcTexel 双重锁)。
 *
 * 本文件是纯数据载荷(从 ltcTables.ts 拆出);解码逻辑与导出面仍在 ltcTables.ts,
 * 重建由 scripts/generateLtcTables.mts 双文件输出生成。
 */
`;
const dataBody = `export const DEEP_LTC_LUT_BASE64 =
${(base64.match(/.{1,2000}/g) ?? [])
  .map((chunk, index) => (index === 0 ? "  " : "  + ") + `"${chunk}"`)
  .join("\n")};
`;

const moduleUrl = fileURLToPath(new URL("../src/lighting/ltcTables.ts", import.meta.url));
const moduleBody = `/**
 * C3 LTC 表消费侧:解码逻辑与公共导出面(decodeLtcLut / DEEP_LTC_LUT_SHA256)。
 * base64 数据载荷见 ./ltcTablesData.ts(出处与指纹门注释在彼处)。
 */
import { DEEP_LTC_LUT_BASE64 } from "./ltcTablesData.js";

/** 解码后的 f32 表;调用方缓存实例,避免重复解码。 */
export function decodeLtcLut(): Float32Array {
  const table = new Float32Array(${LTC_LUT_SIZE * LTC_LUT_SIZE * LTC_LUT_FLOATS_PER_TEXEL});
  decodeBase64Into(DEEP_LTC_LUT_BASE64, new Uint8Array(table.buffer));
  return table;
}

export const DEEP_LTC_LUT_SHA256 = "${sha256}";

/** 纯 TS base64 解码(node/browser 通用,不依赖 Buffer/atob)。 */
function decodeBase64Into(source: string, target: Uint8Array): void {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const inverse = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index++) inverse[alphabet.charCodeAt(index)] = index;
  let output = 0, accumulator = 0, bits = 0;
  for (let index = 0; index < source.length; index++) {
    const value = inverse[source.charCodeAt(index)] ?? -1;
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      target[output++] = (accumulator >> bits) & 0xff;
    }
  }
  if (output !== target.length) throw new Error("LTC LUT base64 payload does not fill the table.");
}
`;

writeFileSync(dataUrl, `${dataHeader}${dataBody}`);
writeFileSync(moduleUrl, moduleBody);
// 自验:独立解码回读 + 与 fitter 抽样 texel 对拍,失败即脚本退出码非零。
if (sha256Bytes(new Uint8Array(decodeBase64(base64).buffer)) !== sha256) throw new Error("round-trip sha mismatch");
// 确定性自验:重建一遍逐位一致(顺序拟合无 RNG;比抽样重拟拟合更严)。
const rebuilt = buildLtcLut();
for (let index = 0; index < lut.length; index++) {
  if (lut[index] !== rebuilt[index]) throw new Error(`determinism drift at ${index}`);
}

console.log(`LTC LUT generated: ${LTC_LUT_SIZE}x${LTC_LUT_SIZE}, sha256=${sha256}, ${Date.now() - started}ms`);

function decodeBase64(source: string): Float32Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const inverse = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index++) inverse[alphabet.charCodeAt(index)] = index;
  const target = new Uint8Array(LTC_LUT_SIZE * LTC_LUT_SIZE * LTC_LUT_FLOATS_PER_TEXEL * 4);
  let output = 0, accumulator = 0, bits = 0;
  for (let index = 0; index < source.length; index++) {
    const value = inverse[source.charCodeAt(index)] ?? -1;
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) { bits -= 8; target[output++] = (accumulator >> bits) & 0xff; }
  }
  if (output !== target.length) throw new Error("base64 payload does not fill the table.");
  return new Float32Array(target.buffer);
}
