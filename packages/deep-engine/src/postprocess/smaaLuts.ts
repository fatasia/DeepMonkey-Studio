/**
 * SMAA LUT 消费侧(AA-M2 L3 空间层):解码逻辑、规格常量与内容指纹。
 * base64 数据载荷见 ./smaaLutsData.ts(出处与解码实测规格注释在彼处)。
 *
 * 来源:仓内 three 0.185.1 examples/jsm/postprocessing/SMAAPass.js L216/L218
 * (iryoku/smaa v2.8 官方 LUT,MIT);许可证与署名见 ./spatialAa.LICENSE.md。
 * 版本随仓内 three 固定,指纹自钉:换版本/手改载荷被 smaaLuts.test.ts 抓红。
 */
import { DEEP_SMAA_AREA_BASE64, DEEP_SMAA_SEARCH_BASE64 } from "./smaaLutsData.js";

/** AreaTex 规格:官方 RG 双通道 LUT(每 texel:R=一侧越权面积,G=另一侧),rg8 交错。 */
export const SMAA_AREA_TEXTURE_WIDTH = 160;
export const SMAA_AREA_TEXTURE_HEIGHT = 560;
/** SearchTex 规格:66×33(官方含 1px padding 行/列;值域 {0,1,2} 搜索端点步长修正)。 */
export const SMAA_SEARCH_TEXTURE_WIDTH = 66;
export const SMAA_SEARCH_TEXTURE_HEIGHT = 33;

/** 入库载荷指纹(extractSmaaLuts.mts 输出;载荷与指纹不同步即测试红)。 */
export const DEEP_SMAA_AREA_SHA256 = "8d13bff24657cd862bcee94188abbeada0b96f1d64f1a7ab329fe9cc159d0c7e";
export const DEEP_SMAA_SEARCH_SHA256 = "e5d85ae5a659337e6d6654b85d2741a0b08a2c7d2eda200151fb0b3bd41e6966";

/** 解码后的 AreaTex(rg8 交错,160×560×2 字节);调用方缓存实例,避免重复解码。 */
export function decodeSmaaAreaLut(): Uint8Array<ArrayBuffer> {
  const table = new Uint8Array(SMAA_AREA_TEXTURE_WIDTH * SMAA_AREA_TEXTURE_HEIGHT * 2);
  decodeBase64Into(DEEP_SMAA_AREA_BASE64, table);
  return table;
}

/** 解码后的 SearchTex(r8,66×33 字节);调用方缓存实例,避免重复解码。 */
export function decodeSmaaSearchLut(): Uint8Array<ArrayBuffer> {
  const table = new Uint8Array(SMAA_SEARCH_TEXTURE_WIDTH * SMAA_SEARCH_TEXTURE_HEIGHT);
  decodeBase64Into(DEEP_SMAA_SEARCH_BASE64, table);
  return table;
}

/** 纯 TS base64 解码(node/browser 通用,不依赖 Buffer/atob;与 ltcTables.ts 同实现)。 */
function decodeBase64Into(source: string, target: Uint8Array<ArrayBuffer>): void {
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
  if (output !== target.length) throw new Error("SMAA LUT base64 payload does not fill the table.");
}
