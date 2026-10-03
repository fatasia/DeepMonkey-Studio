/**
 * C3 LTC 表消费侧:解码逻辑与公共导出面(decodeLtcLut / DEEP_LTC_LUT_SHA256)。
 * base64 数据载荷见 ./ltcTablesData.ts(出处与指纹门注释在彼处)。
 */
import { DEEP_LTC_LUT_BASE64 } from "./ltcTablesData.js";

/** 解码后的 f32 表;调用方缓存实例,避免重复解码。 */
export function decodeLtcLut(): Float32Array {
  const table = new Float32Array(32768);
  decodeBase64Into(DEEP_LTC_LUT_BASE64, new Uint8Array(table.buffer));
  return table;
}

export const DEEP_LTC_LUT_SHA256 = "0fb2fb7b6da3ce34223307c10fe01a0d4ba9a8f6ba1079814fcffdfcc899d96e";

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
