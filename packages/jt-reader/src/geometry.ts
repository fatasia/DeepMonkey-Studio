import { BinaryReader, JtFormatError } from "./binaryReader.js";
import type { JtContainer } from "./container.js";
import { readSegmentPayload } from "./container.js";
import { applyPredictor, decodeInt32Packet } from "./int32Codec.js";
import { decodeInt32PacketV2 } from "./int32CodecV2.js";
import { jtHash16, jtHash32 } from "./hash.js";
import { decodeJtTopology } from "./topologyDecoder.js";
import type { JtMesh, JtReadLimits, JtSegmentEntry } from "./types.js";

const TRI_STRIP_SHAPE_LOD = "10dd10ab-2ac8-11d1-9b6b-0080c7bb5997";
const TOPO_MESH_COMPRESSED = "f830a5ad-be4c-4fbc-9b5f-b9269278d2e1";
const TOPOLOGY_PACKET_COUNT = 21;
const MAX_MESH_VERTICES = 10_000_000;
const MAX_MESH_TRIANGLES = 20_000_000;

interface PacketCursor {
  offset: number;
  values: number[];
}

interface Quantizer {
  minimum: number;
  maximum: number;
  bits: number;
}

/** 顶点记录的属性绑定掩码(voyager 参考实现 TopologicallyCompressedVertexRecordsRecord 同一语义)。 */
const NORMAL_BINDING_BIT = 1n << 3n;
const COLOR_BINDING_BITS = (1n << 4n) | (1n << 5n);
const FLAG_BINDING_BIT = 1n << 6n;
const AUX_BINDING_BIT = 1n << 7n;
const TEXCOORD_BINDING_MASK = 0xffffff00n; // bits 8..39,每 4 位一个纹理集

interface VertexAttributeBindings {
  normal: boolean;
  color: boolean;
  flag: boolean;
  aux: boolean;
  textureCoordinates: boolean;
}

function parseVertexAttributeBindings(bindings: bigint): VertexAttributeBindings {
  return {
    normal: (bindings & NORMAL_BINDING_BIT) !== 0n,
    color: (bindings & COLOR_BINDING_BITS) !== 0n,
    flag: (bindings & FLAG_BINDING_BIT) !== 0n,
    aux: (bindings & AUX_BINDING_BIT) !== 0n,
    textureCoordinates: (bindings & TEXCOORD_BINDING_MASK) !== 0n,
  };
}

function calculateTopologyHash(
  lanes: readonly (readonly number[])[],
  largeMasks: readonly number[],
  splitFaces: readonly number[],
  splitPositions: readonly number[],
  majorVersion: number,
): number {
  let hash = 0;
  for (let index = 0; index < 8; index += 1) hash = jtHash32(lanes[index]!, hash);
  hash = jtHash32(lanes[8]!, hash);
  hash = jtHash32(lanes[9]!, hash);
  hash = jtHash16(lanes[10]!, hash);
  for (let index = 11; index < 18; index += 1) hash = jtHash32(lanes[index]!, hash);
  const low30 = lanes[18]!;
  const next30 = lanes[19]!;
  const upper4 = lanes[20]!;
  if (next30.length !== low30.length || upper4.length !== low30.length) throw new JtFormatError("JT 第八组属性掩码长度不一致");
  if (majorVersion >= 10) {
    const lowWords = low30.map((value, index) => ((value >>> 0) | ((next30[index]! & 0x3) << 30)) >>> 0);
    const highWords = next30.map((value, index) => ((value >>> 2) | ((upper4[index]! & 0xf) << 28)) >>> 0);
    hash = jtHash32(lowWords, hash);
    hash = jtHash32(highWords, hash);
  } else {
    // JT 9.5 对三个物理存储向量分别散列；JT 10 才按逻辑 64 位掩码重组。
    hash = jtHash32(low30, hash);
    hash = jtHash32(next30, hash);
    hash = jtHash32(upper4, hash);
  }
  hash = jtHash32(largeMasks, hash);
  hash = jtHash32(splitFaces, hash);
  return jtHash32(splitPositions, hash);
}

function readPacket(
  bytes: Uint8Array,
  offset: number,
  predictor: "lag1" | "none" = "none",
  majorVersion = 10,
): PacketCursor {
  const packet = majorVersion >= 10
    ? decodeInt32Packet(bytes.subarray(offset))
    : decodeInt32PacketV2(bytes.subarray(offset));
  return {
    offset: offset + packet.byteLength,
    values: applyPredictor(packet.values, predictor),
  };
}

function assertIntegerCount(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new JtFormatError(`${label} ${value} 无效或超过安全上限`);
  }
  return value;
}

function parseQuantizer(reader: BinaryReader, offset: number): Quantizer {
  const minimum = reader.f32(offset, "坐标量化下限");
  const maximum = reader.f32(offset + 4, "坐标量化上限");
  const bits = reader.u8(offset + 8, "坐标量化位数");
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum || bits > 24) {
    throw new JtFormatError("JT 坐标量化参数无效");
  }
  return { minimum, maximum, bits };
}

function decodeQuantizedComponent(codes: readonly number[], quantizer: Quantizer): number[] {
  const maximumCode = 2 ** quantizer.bits - 1;
  const range = quantizer.maximum - quantizer.minimum;
  return codes.map((code) => {
    if (code < 0 || code > maximumCode) throw new JtFormatError("JT 坐标量化码越界");
    return range === 0 ? quantizer.minimum : quantizer.minimum + (code / maximumCode) * range;
  });
}

/**
 * 无损(binary)标量分量:CDP 包中保存 IEEE-754 位型。
 * JT 9.5 分离指数/尾数两包;JT 10 直接保存单包(均已被真实样本字节验证)。
 */
function decodeBinaryScalarPackets(
  bytes: Uint8Array,
  offset: number,
  expectedCount: number,
  packetCount: number,
  majorVersion: number,
): { words: number[][]; offset: number } {
  const words: number[][] = [];
  let cursor = offset;
  for (let packet = 0; packet < packetCount; packet += 1) {
    const result = readPacket(bytes, cursor, "lag1", majorVersion);
    if (result.values.length !== expectedCount) {
      throw new JtFormatError("JT 无损属性压缩包长度与声明数量不一致");
    }
    words.push(result.values);
    cursor = result.offset;
  }
  return { words, offset: cursor };
}

interface ScalarArrayHeader {
  count: number;
  componentCount: number;
  quantizationBits: number;
}

function parseScalarArrayHeader(reader: BinaryReader, offset: number, label: string): ScalarArrayHeader {
  const count = assertIntegerCount(reader.i32(offset, `${label}数量`), MAX_MESH_VERTICES * 4, `${label}数量`);
  const componentCount = reader.u8(offset + 4, `${label}分量数`);
  const quantizationBits = reader.u8(offset + 5, `${label}量化位数`);
  if (componentCount < 1 || componentCount > 4) throw new JtFormatError(`JT ${label}分量数量 ${componentCount} 无效`);
  if (quantizationBits > 24) throw new JtFormatError(`JT ${label}量化位数 ${quantizationBits} 无效`);
  return { count, componentCount, quantizationBits };
}

/**
 * 通用标量属性数组读取器:数量/分量/量化头 + 各分量的 Int32CDP 包 + U32 哈希。
 * 支持三种已验证的存储形态:
 *  - 量化(bits>0):每分量 1 包 + 每分量 9 字节均匀量化器(颜色另有 HSV 变体,见下)
 *  - 无损(bits=0, JT10):每分量 1 包,IEEE-754 位型
 *  - 无损(bits=0, JT9):每分量 2 包(指数/尾数分离)
 * 返回的 values 以分量优先(component-major)平铺。
 */
function decodeScalarAttributeArray(
  bytes: Uint8Array,
  reader: BinaryReader,
  offset: number,
  label: string,
  majorVersion: number,
  quantizerCountOverride?: number,
): { components: number[][]; offset: number } {
  const header = parseScalarArrayHeader(reader, offset, label);
  let cursor = offset + 6;
  const components: number[][] = [];
  if (header.quantizationBits === 0) {
    const packetsPerComponent = majorVersion >= 10 ? 1 : 2;
    for (let component = 0; component < header.componentCount; component += 1) {
      const binary = decodeBinaryScalarPackets(bytes, cursor, header.count, packetsPerComponent, majorVersion);
      cursor = binary.offset;
      const values = header.count === 0 ? [] : binary.words[0]!.map((firstWord, index) => {
        // JT 9.5 分离指数与尾数;JT 10 直接是 IEEE-754 位型(与坐标无损路径同一语义)。
        const bits = majorVersion >= 10
          ? firstWord >>> 0
          : ((firstWord << 23) | binary.words[1]![index]!) >>> 0;
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, bits, true);
        const value = view.getFloat32(0, true);
        if (!Number.isFinite(value)) throw new JtFormatError(`JT ${label}包含非有限数值`);
        return value;
      });
      components.push(values);
    }
  } else {
    const quantizerCount = quantizerCountOverride ?? header.componentCount;
    const quantizers: Quantizer[] = [];
    for (let index = 0; index < quantizerCount; index += 1) {
      quantizers.push(parseQuantizer(reader, cursor + index * 9));
    }
    cursor += quantizerCount * 9;
    for (let component = 0; component < header.componentCount; component += 1) {
      const packet = readPacket(bytes, cursor, "lag1", majorVersion);
      if (packet.values.length !== header.count) {
        throw new JtFormatError(`JT ${label}量化包长度与声明数量不一致`);
      }
      components.push(decodeQuantizedComponent(packet.values, quantizers[component]!));
      cursor = packet.offset;
    }
  }
  const storedHash = reader.u32(cursor, `${label}哈希`);
  const calculatedHash = components.reduce(
    (hash, component) => jtHash32(component.map((value) => {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, value, true);
      return view.getUint32(0, true);
    }), hash),
    0,
  );
  if (calculatedHash !== storedHash) throw new JtFormatError(`JT ${label}哈希校验失败`);
  return { components, offset: cursor + 4 };
}

/** HSV 量化颜色:Hue/Sat/Value/Alpha 各自独立位宽,值域固定,这里仅推进游标并显式声明不支持。 */
function assertNotHsvColorQuantizer(reader: BinaryReader, offset: number): void {
  const hsvFlag = reader.u8(offset, "颜色量化 HSV 标记");
  if (hsvFlag === 1) {
    throw new JtFormatError("暂不支持 HSV 量化顶点色,仅支持 RGBA 均匀量化");
  }
}

function decodeCoordinates(
  bytes: Uint8Array,
  reader: BinaryReader,
  offset: number,
  expectedCount: number,
  majorVersion: number,
): { positions: number[]; offset: number } {
  const coordinateCount = assertIntegerCount(reader.i32(offset, "唯一坐标数量"), MAX_MESH_VERTICES, "唯一坐标数量");
  if (coordinateCount !== expectedCount) {
    throw new JtFormatError(`JT 拓扑顶点数 ${expectedCount} 与唯一坐标数 ${coordinateCount} 不一致`);
  }
  const componentCount = reader.u8(offset + 4, "坐标分量数量");
  if (componentCount !== 3) throw new JtFormatError(`JT 坐标分量数量必须为 3，实际为 ${componentCount}`);
  const quantizers = Array.from({ length: 3 }, (_, index) => parseQuantizer(reader, offset + 5 + index * 9));
  if (!quantizers.every((quantizer) => quantizer.bits === quantizers[0]!.bits)) {
    throw new JtFormatError("JT 三个坐标分量的量化位数不一致");
  }

  let cursor = offset + 32;
  const components: number[][] = [];
  const hashWords: number[][] = [];
  for (const quantizer of quantizers) {
    if (quantizer.bits === 0) {
      const first = readPacket(bytes, cursor, "lag1", majorVersion);
      const second = majorVersion >= 10 ? undefined : readPacket(bytes, first.offset, "lag1", majorVersion);
      if (first.values.length !== coordinateCount || (second && second.values.length !== coordinateCount)) {
        throw new JtFormatError("JT 无损坐标压缩包长度与顶点数不一致");
      }
      const values = first.values.map((firstValue, index) => {
        // JT 9.5 分离指数与尾数；JT 10 起直接保存 IEEE-754 二进制值。
        const bits = second ? ((firstValue << 23) | second.values[index]!) >>> 0 : firstValue >>> 0;
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setUint32(0, bits, true);
        const value = view.getFloat32(0, true);
        if (!Number.isFinite(value)) throw new JtFormatError("JT 无损坐标包含非有限数值");
        return value;
      });
      components.push(values);
      hashWords.push(values.map((_, index) => second
        ? ((first.values[index]! << 23) | second.values[index]!) >>> 0
        : first.values[index]! >>> 0));
      cursor = second?.offset ?? first.offset;
    } else {
      const packet = readPacket(bytes, cursor, "lag1", majorVersion);
      if (packet.values.length !== coordinateCount) throw new JtFormatError("JT 坐标压缩包长度与顶点数不一致");
      components.push(decodeQuantizedComponent(packet.values, quantizer));
      hashWords.push(packet.values.map((value) => value >>> 0));
      cursor = packet.offset;
    }
  }
  const storedHash = reader.u32(cursor, "顶点坐标哈希");
  let calculatedHash = 0;
  if (quantizers[0]!.bits === 0 && majorVersion < 10) {
    for (const component of hashWords) {
      for (const word of component) calculatedHash = jtHash32([word], calculatedHash);
    }
  } else {
    for (const component of hashWords) calculatedHash = jtHash32(component, calculatedHash);
  }
  if (calculatedHash !== storedHash) throw new JtFormatError("JT 顶点坐标哈希校验失败");
  cursor += 4;

  const positions = Array.from({ length: coordinateCount }, (_, vertex) => [
    components[0]![vertex]!,
    components[1]![vertex]!,
    components[2]![vertex]!,
  ]).flat();
  return { positions, offset: cursor };
}

/** 法线记录:仅推进游标并校验哈希,法线值本身由转换器按三角重新计算,不在此消费。 */
function skipNormalArray(
  bytes: Uint8Array,
  reader: BinaryReader,
  offset: number,
  majorVersion: number,
): number {
  const header = parseScalarArrayHeader(reader, offset, "法线数量");
  let cursor = offset + 6;
  if (header.quantizationBits === 0) {
    const packetsPerComponent = majorVersion >= 10 ? 1 : 2;
    for (let component = 0; component < header.componentCount; component += 1) {
      cursor = decodeBinaryScalarPackets(bytes, cursor, header.count, packetsPerComponent, majorVersion).offset;
    }
  } else {
    // JT10 的 Deering 球面量化把三个法线分量打包在一个 CDP 里(真实样本 type=8/9 验证)。
    const packetCount = majorVersion >= 10 ? 1 : header.componentCount * 2;
    for (let packet = 0; packet < packetCount; packet += 1) {
      const result = readPacket(bytes, cursor, "lag1", majorVersion);
      if (result.values.length !== header.count) {
        throw new JtFormatError("JT 法线压缩包长度与声明数量不一致");
      }
      cursor = result.offset;
    }
  }
  reader.u32(cursor, "法线哈希");
  return cursor + 4;
}

/** RGBA 顶点色:量化(4×9B 均匀量化器)或无损两种形态,线性化到 0..1 并展开为 RGBA 平铺。 */
function decodeColorArray(
  bytes: Uint8Array,
  reader: BinaryReader,
  offset: number,
  majorVersion: number,
  vertexCount: number,
): { colors: Float32Array; offset: number } {
  // HSV 量化形态的标记在数组头之后、量化器区之前;先于解码显式拒绝,避免把 HSV 字节当 RGBA 读。
  const headerBits = reader.u8(offset + 5, "颜色量化位数");
  if (headerBits > 0) assertNotHsvColorQuantizer(reader, offset + 6);
  const decoded = decodeScalarAttributeArray(bytes, reader, offset, "顶点色", majorVersion);
  const { components, offset: cursor } = decoded;
  if (components.length !== 4) throw new JtFormatError(`JT 顶点色分量数量必须为 4,实际为 ${components.length}`);
  for (const component of components) {
    if (component.length !== vertexCount) {
      throw new JtFormatError(`JT 顶点色条数 ${component.length} 与顶点数 ${vertexCount} 不一致`);
    }
  }
  const colors = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let component = 0; component < 4; component += 1) {
      colors[vertex * 4 + component] = clampUnit(components[component]![vertex]!);
    }
  }
  return { colors, offset: cursor };
}

/** 纹理坐标:量化(comps×9B 均匀量化器)或无损,反解后截入 0..1 并展开为 UV 平铺。 */
function decodeTextureCoordinateArray(
  bytes: Uint8Array,
  reader: BinaryReader,
  offset: number,
  majorVersion: number,
  vertexCount: number,
): { uvs: Float32Array; offset: number } {
  const decoded = decodeScalarAttributeArray(bytes, reader, offset, "纹理坐标", majorVersion);
  const { components, offset: cursor } = decoded;
  if (components.length !== 2) throw new JtFormatError(`JT 纹理坐标分量数量必须为 2,实际为 ${components.length}`);
  for (const component of components) {
    if (component.length !== vertexCount) {
      throw new JtFormatError(`JT 纹理坐标条数 ${component.length} 与顶点数 ${vertexCount} 不一致`);
    }
  }
  const uvs = new Float32Array(vertexCount * 2);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let component = 0; component < 2; component += 1) {
      uvs[vertex * 2 + component] = clampUnit(components[component]![vertex]!);
    }
  }
  return { uvs, offset: cursor };
}

/** 顶点旗标(JT10:前导 I32 数量 + 单个 CDP;真实样本 type=7/8/9 验证)。仅推进游标。 */
function skipFlagArray(
  bytes: Uint8Array,
  reader: BinaryReader,
  offset: number,
  majorVersion: number,
): number {
  if (majorVersion >= 10) {
    const count = assertIntegerCount(reader.i32(offset, "顶点旗标数量"), MAX_MESH_VERTICES, "顶点旗标数量");
    const packet = readPacket(bytes, offset + 4, "none", majorVersion);
    if (packet.values.length !== count) {
      throw new JtFormatError("JT 顶点旗标包长度与声明数量不一致");
    }
    return packet.offset;
  }
  const packet = readPacket(bytes, offset, "none", majorVersion);
  assertIntegerCount(packet.values.length, MAX_MESH_VERTICES, "顶点旗标数量");
  return packet.offset;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) throw new JtFormatError("JT 属性数值非有限");
  return Math.min(1, Math.max(0, value));
}

function parseTopology(
  bytes: Uint8Array,
  reader: BinaryReader,
  offset: number,
  expectedBindings: number,
  majorVersion: number,
  vertexRecordObjectId: number,
): {
  indices: number[];
  groups: number[];
  positions: number[];
  vertexRecordObjectId: number;
  uvs?: Float32Array | undefined;
  colors?: Float32Array | undefined;
  unsupportedAttributeBindings: string[];
} {
  let cursor = offset;
  const lanes: number[][] = [];
  for (let index = 0; index < TOPOLOGY_PACKET_COUNT; index += 1) {
    const packet = readPacket(bytes, cursor, index === 10 ? "lag1" : "none", majorVersion);
    lanes.push(packet.values);
    cursor = packet.offset;
  }
  let largeMaskValues: number[];
  if (majorVersion >= 10) {
    const largeMasks = readPacket(bytes, cursor, "none", majorVersion);
    largeMaskValues = largeMasks.values;
    cursor = largeMasks.offset;
  } else {
    const count = assertIntegerCount(reader.i32(cursor, "高度数面掩码数量"), MAX_MESH_VERTICES, "高度数面掩码数量");
    reader.ensure(cursor + 4, count * 4, "高度数面掩码");
    largeMaskValues = Array.from({ length: count }, (_, index) => reader.i32(cursor + 4 + index * 4, "高度数面掩码"));
    cursor += 4 + count * 4;
  }
  const splitFaces = readPacket(bytes, cursor, "lag1", majorVersion);
  cursor = splitFaces.offset;
  const splitPositions = majorVersion < 10 || splitFaces.values.length > 0
    ? readPacket(bytes, cursor, "none", majorVersion)
    : { values: [], offset: cursor };
  cursor = splitPositions.offset;

  const storedTopologyHash = reader.u32(cursor, "拓扑复合哈希");
  const calculatedTopologyHash = calculateTopologyHash(
    lanes,
    largeMaskValues,
    splitFaces.values,
    splitPositions.values,
    majorVersion,
  );
  if (calculatedTopologyHash !== storedTopologyHash) throw new JtFormatError("JT 拓扑复合哈希校验失败");
  const bindingsMask = reader.u64Number(cursor + 4, "顶点绑定");
  if (bindingsMask !== expectedBindings) throw new JtFormatError("JT 外层与顶点记录的绑定标记不一致");
  const quantization = Array.from({ length: 4 }, (_, index) => reader.u8(cursor + 12 + index, "量化参数"));
  if (quantization[0]! > 24 || quantization[1]! > 13 || quantization[2]! > 24 || quantization[3]! > 24) {
    throw new JtFormatError("JT 顶点量化参数越界");
  }
  const topologyVertexCount = assertIntegerCount(reader.i32(cursor + 16, "拓扑顶点数"), MAX_MESH_VERTICES, "拓扑顶点数");
  const attributeCount = topologyVertexCount > 0
    ? assertIntegerCount(reader.i32(cursor + 20, "拓扑属性数"), MAX_MESH_VERTICES * 16, "拓扑属性数")
    : 0;
  cursor += topologyVertexCount > 0 ? 24 : 20;

  const polygons = decodeJtTopology({
    degrees: lanes.slice(0, 8),
    valences: lanes[8]!,
    groups: lanes[9]!,
    flags: lanes[10]!,
    attributeMasks: {
      small: lanes.slice(11, 19),
      context7Next30: lanes[19]!,
      context7Upper4: lanes[20]!,
      largeWords: largeMaskValues,
    },
    splitFaces: splitFaces.values,
    splitPositions: splitPositions.values,
  });
  if (polygons.length > MAX_MESH_TRIANGLES) throw new JtFormatError("JT 面数量超过安全上限");
  const observedAttributeCount = polygons.reduce(
    (maximum, polygon) => Math.max(maximum, ...polygon.attributeIndices.map((value) => value ?? -1)),
    -1,
  ) + 1;
  if (observedAttributeCount !== attributeCount) throw new JtFormatError("JT 拓扑属性数量与顶点记录头不一致");

  const coordinates = decodeCoordinates(bytes, reader, cursor, topologyVertexCount, majorVersion);
  cursor = coordinates.offset;

  // 顶点记录按绑定掩码推进属性数组(顺序:法线 → 颜色 → 纹理坐标 → 旗标 → 附属字段;
  // 与真实样本字节布局及 voyager 参考实现一致)。不支持/未声明的形态如实进入 unsupported 列表。
  const bindings = parseVertexAttributeBindings(BigInt(bindingsMask));
  const uvs: Float32Array | undefined = undefined;
  let colors: Float32Array | undefined;
  let textureCoordinates: Float32Array | undefined;
  const unsupportedAttributeBindings: string[] = [];
  if (bindings.normal) {
    cursor = skipNormalArray(bytes, reader, cursor, majorVersion);
  }
  if (bindings.color) {
    const decoded = decodeColorArray(bytes, reader, cursor, majorVersion, topologyVertexCount);
    colors = decoded.colors;
    cursor = decoded.offset;
  }
  if (bindings.textureCoordinates) {
    const decoded = decodeTextureCoordinateArray(bytes, reader, cursor, majorVersion, topologyVertexCount);
    textureCoordinates = decoded.uvs;
    cursor = decoded.offset;
  }
  if (bindings.flag) {
    cursor = skipFlagArray(bytes, reader, cursor, majorVersion);
  }
  if (bindings.aux) {
    // 附属字段(每字段 GUID/类型/量化/64 位 LSW-MSW 结构)尚未实现;此处无游标推进依据,
    // 真实遇到时顶点记录长度将失配,故显式报错并转上层 loss,而不是静默猜测。
    unsupportedAttributeBindings.push("vertex.auxiliary-fields");
    throw new JtFormatError("暂不支持 JT 附属字段(auxiliary fields)顶点属性,已转为保真损失上报");
  }

  const indices = polygons.flatMap((polygon) => {
    if (polygon.vertexIndices.length < 3) throw new JtFormatError("JT 多边形少于三个顶点");
    const triangles: number[] = [];
    for (let index = 1; index + 1 < polygon.vertexIndices.length; index += 1) {
      triangles.push(polygon.vertexIndices[0]!, polygon.vertexIndices[index]!, polygon.vertexIndices[index + 1]!);
    }
    return triangles;
  });
  if (indices.some((index) => index < 0 || index >= topologyVertexCount)) throw new JtFormatError("JT 网格索引越界");
  return {
    indices,
    groups: polygons.map((polygon) => polygon.group),
    positions: coordinates.positions,
    vertexRecordObjectId,
    uvs: textureCoordinates,
    colors,
    unsupportedAttributeBindings,
  };
}

export function decodeTriStripShapeLod(
  payload: Uint8Array,
  segment: JtSegmentEntry,
  byteOrder: "little-endian" | "big-endian",
  majorVersion = 10,
): JtMesh | undefined {
  if (byteOrder !== "little-endian") throw new JtFormatError("当前 JT TopoMesh 译码仅支持小端文件");
  const reader = new BinaryReader(payload, byteOrder);
  reader.ensure(0, 35, "TriStrip LOD 逻辑元素");
  const outerLength = reader.u32(0, "TriStrip 逻辑元素长度");
  reader.ensure(0, outerLength + 4, "TriStrip 逻辑元素");
  if (reader.guid(4, "TriStrip 元素类型") !== TRI_STRIP_SHAPE_LOD) return undefined;
  let bindings: number;
  let topology: ReturnType<typeof parseTopology>;
  if (majorVersion >= 10) {
    const shapeVersion = reader.u8(25, "TriStrip 版本");
    const baseShapeVersion = reader.u8(26, "基础 Shape 版本");
    if (shapeVersion !== 1 || baseShapeVersion !== 1) {
      throw new JtFormatError(`尚不支持 TriStrip ${shapeVersion}/${baseShapeVersion} 版本`);
    }
    bindings = reader.u64Number(27, "Shape 顶点绑定");
    const innerOffset = 35;
    const innerLength = reader.u32(innerOffset, "TopoMesh 逻辑元素长度");
    reader.ensure(innerOffset, innerLength + 4, "TopoMesh 逻辑元素");
    if (reader.guid(innerOffset + 4, "TopoMesh 元素类型") !== TOPO_MESH_COMPRESSED) {
      throw new JtFormatError("TriStrip LOD 未包含标准 TopoMesh 压缩元素");
    }
    const topologyVersion = reader.u8(innerOffset + 25, "TopoMesh 版本");
    const vertexRecordObjectId = reader.u32(innerOffset + 26, "顶点记录对象 ID");
    const compressedVersion = reader.u8(innerOffset + 30, "拓扑压缩版本");
    if (topologyVersion !== 1 || compressedVersion !== 1) {
      throw new JtFormatError(`尚不支持 TopoMesh ${topologyVersion}/${compressedVersion} 版本`);
    }
    topology = parseTopology(payload, reader, innerOffset + 31, bindings, majorVersion, vertexRecordObjectId);
  } else {
    const baseShapeVersion = reader.u16(25, "基础 Shape 版本");
    const vertexShapeVersion = reader.u16(27, "Vertex Shape 版本");
    bindings = reader.u64Number(29, "Shape 顶点绑定");
    const topologyVersion = reader.u16(37, "TopoMesh 版本");
    const vertexRecordObjectId = reader.u32(39, "顶点记录对象 ID");
    const compressedVersion = reader.u16(43, "拓扑压缩版本");
    if (baseShapeVersion !== 1 || vertexShapeVersion !== 1 || ![1, 2].includes(topologyVersion) || ![1, 2].includes(compressedVersion)) {
      throw new JtFormatError(`尚不支持 JT 9 TriStrip ${baseShapeVersion}/${vertexShapeVersion}/${topologyVersion}/${compressedVersion} 版本`);
    }
    topology = parseTopology(payload, reader, 45, bindings, majorVersion, vertexRecordObjectId);
  }
  return {
    id: `${segment.id}:lod-${Math.max(0, segment.type - 7)}`,
    segmentId: segment.id,
    lod: majorVersion >= 10 ? Math.max(0, segment.type - 7) : 0,
    vertexRecordObjectId: topology.vertexRecordObjectId,
    positions: topology.positions,
    indices: topology.indices,
    polygonGroups: topology.groups,
    sceneNodeObjectIds: [],
    vertexCount: topology.positions.length / 3,
    triangleCount: topology.indices.length / 3,
    ...(topology.uvs ? { uvs: topology.uvs } : {}),
    ...(topology.colors ? { colors: topology.colors } : {}),
    unsupportedAttributeBindings: topology.unsupportedAttributeBindings,
  };
}

export async function readJtMeshes(
  container: JtContainer,
  limits: JtReadLimits,
): Promise<{ meshes: JtMesh[]; warnings: string[] }> {
  const meshes: JtMesh[] = [];
  const warnings: string[] = [];
  const candidates = container.segments.filter((segment) => container.header.majorVersion >= 10
    ? segment.type >= 7 && segment.type <= 16
    : segment.type === 6);
  for (const segment of candidates) {
    try {
      const payload = await readSegmentPayload(container, segment, limits);
      const mesh = decodeTriStripShapeLod(payload, segment, container.header.byteOrder, container.header.majorVersion);
      if (mesh) meshes.push(mesh);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`LOD 数据段 ${segment.id} 未生成网格：${reason}`);
    }
  }
  return { meshes: meshes.sort((left, right) => left.lod - right.lod), warnings };
}
