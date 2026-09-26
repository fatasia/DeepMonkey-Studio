/**
 * 合成带 UV/Color attribute 的 JT 10.3 fixture(测试辅助,不随包发布)。
 *
 * 做法:对真实样本 voyager-example-block-jt10.3.jt 的 LOD0 几何段(type=7)做字节手术。
 * 该段的顶点记录已被字节级验证止于旗标 CDP(payload 内偏移 577,亦即 inner TopoMesh 元素终点),
 * 因此在其后直接追加两条属性记录、翻转 vertexBindings、同步各层长度字段即可:
 *  1. vertexBindings |= 颜色位(0x30)+ 纹理集 0 绑定位(bits 8..11 = 1)
 *  2. 追加 Compressed Vertex Texture Coordinate Array(量化 bits=8,u=i/7, v=1-i/7)
 *  3. 追加 Compressed Vertex Colour Array(量化 bits=8,RGBA 渐变,每顶点唯一)
 *  4. inner/outer 逻辑元素长度、段 declaredLength、TOC 段长度同步 +插入字节数
 */
import { jtHash32 } from "./hash.js";
import { parseJtContainer } from "./container.js";
import { BinaryReader } from "./binaryReader.js";
import { DEFAULT_JT_READ_LIMITS } from "./types.js";

/** LOD0 段(payload 内)顶点记录锚点;来自真实样本字节验证。
 * 属性物理顺序 = 坐标 → 法线(bit3) → 颜色(bit4/5) → 纹理坐标(bit8+) → 旗标(bit6)。
 * 真实样本的旗标记录起于 payload 内 560(法线哈希之后),新属性必须插在它前面。 */
const LOD0_INSERTION_POINT = 560;
const LOD0_BINDINGS_PAYLOAD_OFFSET = 247;
const SEGMENT_HEADER_BYTES = 24;
/** inner TopoMesh 元素长度 u32 位于 payload 内偏移 35(= outer 元素 4B 长度前缀 + 16B GUID + 15B 头)。 */
const INNER_LENGTH_PAYLOAD_OFFSET = 35;

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function u32le(value: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value >>> 0, true);
  return new Uint8Array(view.buffer, 0, 4);
}

function quantizer(minimum: number, maximum: number, bits: number): Uint8Array {
  const out = new Uint8Array(9);
  const view = new DataView(out.buffer);
  view.setFloat32(0, minimum, true);
  view.setFloat32(4, maximum, true);
  out[8] = bits;
  return out;
}

/** Null CODEC 的 Int32CDP:原始 I32 数组直排。 */
function nullCdp(values: number[]): Uint8Array {
  // 读取端对包值应用 lag1 预测器(前 4 个原样、之后累加前值),写入端必须做逆差分,
  // 否则全 255 之类的高幅值序列会被累加出越界码(实测踩坑)。
  const residuals = values.map((value, index) => (index < 4 || index === 0 ? value : value - values[index - 1]!));
  const body = new Uint8Array(values.length * 4);
  const view = new DataView(body.buffer);
  residuals.forEach((value, index) => view.setInt32(index * 4, value, true));
  return concat([u32le(values.length), Uint8Array.of(0), u32le(values.length * 4), body]);
}

/** decodeScalarAttributeArray 的哈希语义:逐分量以 f32 位型串链 jtHash32。 */
function attributeHash(components: number[][]): number {
  let hash = 0;
  for (const component of components) {
    hash = jtHash32(component.map((value) => {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, value, true);
      return view.getUint32(0, true);
    }), hash);
  }
  return hash;
}

export function synthesizeUvColorJt(source: Uint8Array): Uint8Array {
  const container = parseJtContainer(source, DEFAULT_JT_READ_LIMITS);
  const segment = container.segments.find((candidate) => candidate.type === 7);
  if (!segment) throw new Error("合成 fixture 需要样本包含 LOD0 几何段");
  const payloadStart = segment.offset + SEGMENT_HEADER_BYTES;
  // 顶点记录终点与 inner 元素终点在真实样本中重合(577),这是插入点选择的依据;
  // 若换样本导致不再重合,游标常量必须重新验证,禁止盲插。
  const insertOffset = payloadStart + LOD0_INSERTION_POINT;

  // ---- 属性记录 ----
  const uvCodesU = Array.from({ length: 8 }, (_, index) => Math.round((index / 7) * 255));
  const uvCodesV = Array.from({ length: 8 }, (_, index) => 255 - Math.round((index / 7) * 255));
  const uvRecord = concat([
    u32le(8), Uint8Array.of(2, 8), quantizer(0, 1, 8), quantizer(0, 1, 8),
    nullCdp(uvCodesU), nullCdp(uvCodesV),
    u32le(attributeHash([uvCodesU.map((code) => code / 255), uvCodesV.map((code) => code / 255)])),
  ]);
  const colorR = [0, 32, 64, 96, 128, 160, 192, 255];
  const colorG = colorR.map((value) => 255 - value);
  const colorB = colorR.map((value) => (value / 2) | 0);
  const colorA = colorR.map(() => 255);
  const colorRecord = concat([
    u32le(8), Uint8Array.of(4, 8),
    quantizer(0, 1, 8), quantizer(0, 1, 8), quantizer(0, 1, 8), quantizer(0, 1, 8),
    nullCdp(colorR), nullCdp(colorG), nullCdp(colorB), nullCdp(colorA),
    u32le(attributeHash([colorR, colorG, colorB, colorA].map((component) => component.map((value) => value / 255)))),
  ]);
  // 物理顺序必须与绑定掩码位序一致:颜色(bit4/5)在纹理坐标(bit8+)之前。
  const insert = concat([colorRecord, uvRecord]);

  // ---- 字节手术 ----
  const result = new Uint8Array(source.byteLength + insert.byteLength);
  result.set(source.subarray(0, insertOffset), 0);
  // 翻转 vertexBindings:外层 Shape(u64@payload+27)与顶点记录(u64@payload+247)必须一致。
  const bindingsOffset = segment.offset + 24 + LOD0_BINDINGS_PAYLOAD_OFFSET;
  const outerBindingsOffset = segment.offset + 24 + 27;
  const bindingsView = new DataView(source.buffer, source.byteOffset);
  const bindings = bindingsView.getBigUint64(bindingsOffset, true);
  const newBindings = bindings | 0x30n | (0x1n << 8n);
  new DataView(result.buffer).setBigUint64(bindingsOffset, newBindings, true);
  new DataView(result.buffer).setBigUint64(outerBindingsOffset, newBindings, true);
  result.set(insert, insertOffset);
  result.set(source.subarray(insertOffset), insertOffset + insert.byteLength);
  // 同步长度:outer u32、inner u32、段 declaredLength u32,以及 TOC 内受影响段的长度与偏移。
  // 受影响段之后的段在文件里整体平移,TOC 的段偏移字段必须同步 +delta,否则后续段标识校验全部漂移。
  const patch = (offset: number, delta: number) => {
    const view = new DataView(result.buffer);
    view.setUint32(offset, view.getUint32(offset, true) + delta, true);
  };
  const shift = (offset: number, delta: number) => {
    const view = new DataView(result.buffer);
    view.setBigUint64(offset, view.getBigUint64(offset, true) + BigInt(delta), true);
  };
  patch(segment.offset + SEGMENT_HEADER_BYTES, insert.byteLength); // outer 元素长度(payload 内 u32@0)
  patch(segment.offset + SEGMENT_HEADER_BYTES + INNER_LENGTH_PAYLOAD_OFFSET, insert.byteLength); // inner 元素长度
  patch(segment.offset + 20, insert.byteLength); // 段 declaredLength
  // TOC:遍历找到匹配段 id 的项,更新其段长度
  const tocOffset = Number(new DataView(result.buffer, result.byteOffset).getBigUint64(85, true));
  const entryCount = new DataView(result.buffer, result.byteOffset).getUint32(tocOffset, true);
  // TOC 项的 16 字节 id 必须按 BinaryReader.guid 的 GUID 混排读取后与段 id 字符串比较,
  // 直接字节串接会因小端字节序不一致而匹配失败(实测踩坑)。
  const reader = new BinaryReader(result, "little-endian");
  for (let index = 0; index < entryCount; index += 1) {
    const entry = tocOffset + 4 + index * 32;
    const entryOffset = Number(new DataView(result.buffer, result.byteOffset).getBigUint64(entry + 16, true));
    if (reader.guid(entry) === segment.id) {
      patch(entry + 24, insert.byteLength); // 段长度
    } else if (entryOffset > segment.offset) {
      shift(entry + 16, insert.byteLength); // 目标段之后的段整体平移,同步偏移
    }
  }
  return result;
}
