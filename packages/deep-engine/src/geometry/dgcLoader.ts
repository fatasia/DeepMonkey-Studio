import { unzlibSync } from "fflate";

/**
 * `.dgc`(Deep Geometry Clusters)v1 读取器 —— Rust 离线工具链
 * (`deep-engine-native/geometry_dag`,权威实现 `src/dgc.rs`)产物的 TS 解码端。
 * 字节级合同:`geometry_dag/docs/dgc-format-spec.md`;读取合同:`docs/ts-loader-contract.md`。
 * fail-closed:任何结构违规(魔数/截断/尺寸锁/保留字段/CRC/段序/counts 不变量/解压尺寸)
 * 都抛 {@link DgcFormatError},错误信息含具体偏移,与 Rust `DagError::DgcFormat` 语义对齐。
 */

/** 魔数 `DGC1`(0x44 0x47 0x43 0x31);当前版本 1,读端遇到未知版本拒绝(不猜)。 */
export const DGC_MAGIC = "DGC1" as const;
export const DGC_FORMAT_VERSION = 1;
/** 文件头 64 字节;段头 88 字节;段 payload 8 字节对齐。 */
export const DGC_FILE_HEADER_SIZE = 64, DGC_SECTION_HEADER_SIZE = 88, DGC_PAYLOAD_ALIGNMENT = 8;
/** 段类型:0 = LEVEL(层几何),1 = PARENTS(细层 k → 粗层 k+1 父索引)。 */
export const DGC_SECTION_KIND_LEVEL = 0, DGC_SECTION_KIND_PARENTS = 1;
/** flags bit0:段 payload 逐段 zlib(RFC 1950)压缩;其余位必须为 0。 */
export const DGC_FLAG_ZLIB = 1;
/** 无父哨兵(细簇三角形全被去重丢弃;Int32 视角即 -1,与 buildMeshletDag 同值)。 */
export const DGC_NO_PARENT = 0xffffffff;
/** 簇顶点/三角形上限(与 types.rs MESHLET_MAX_*_LIMIT 一致)。 */
export const DGC_MAX_VERTICES_LIMIT = 64, DGC_MAX_TRIANGLES_LIMIT = 126;

/** 与 Rust `DagError::DgcFormat` 对齐的格式错误;`code` 恒为 `"dgc-format"`。 */
export class DgcFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DgcFormatError";
  }
}

/** 输入载体:整个 ArrayBuffer 或其上的 Uint8Array 视图(拒绝 SharedArrayBuffer)。 */
export type DgcBytes = ArrayBuffer | Uint8Array;

/** 64B 文件头(解析期已通过全部 fail-closed 校验)。 */
export interface DgcFileHeader {
  readonly flags: number;
  /** flags&1:段 payload 是否 zlib 压缩。 */
  readonly compressed: boolean;
  readonly levelCount: number; readonly parentPairCount: number;
  /** level 0 尺寸(与 level 0 段实际数据锁定一致)。 */
  readonly sourceVertexCount: number; readonly sourceTriangleCount: number;
  /** 簇顶点/三角形上限(随文件持久化的构建参数)。 */
  readonly maxVertices: number; readonly maxTriangles: number;
  /** 边界锁定:必须等于实际文件字节数。 */
  readonly totalFileSize: number;
}

/** 88B 段头;`counts` 是 8 个数组槽的元素个数(payload 槽位固定顺序见格式规格)。 */
export interface DgcSectionHeader {
  /** 段序号(0 基)。 */
  readonly index: number;
  readonly kind: number;
  /** LEVEL:层号;PARENTS:细层号 k。 */
  readonly level: number;
  /** LEVEL 层误差(f64);PARENTS 恒 0。 */
  readonly error: number;
  readonly counts: readonly [number, number, number, number, number, number, number, number];
  readonly rawSize: number; readonly storedSize: number;
  readonly payloadOffset: number; readonly crc32c: number;
}

/** 单层 DAG,与 `MeshletDagLevel` 同构并额外携带构建参数(maxVertices/maxTriangles)。 */
export interface DgcDagLevel {
  /** 0 = 原始层;error 为顶点相对源位置的最大位移(世界单位,f64)。 */
  readonly level: number; readonly error: number;
  readonly positions: Float32Array<ArrayBuffer>; readonly indices: Uint32Array<ArrayBuffer>;
  readonly meshletCount: number;
  readonly maxVertices: number; readonly maxTriangles: number;
  /** [vertexOffset, vertexCount, triangleOffset, triangleCount] × n(元素偏移)。 */
  readonly descriptors: Uint32Array<ArrayBuffer>;
  readonly vertexRemap: Uint32Array<ArrayBuffer>;
  /** 低 24 位打包的局部三角形(a | b<<8 | c<<16);bounds 为 16 f32 × n(sphere/aabb/cone)。 */
  readonly localTriangleIndices: Uint32Array<ArrayBuffer>;
  readonly bounds: Float32Array<ArrayBuffer>;
  readonly sourceTriangles: Uint32Array<ArrayBuffer>;
  /** [start,end) × n:簇的源三角形段(前缀和链)。 */
  readonly clusterSourceSpans: Uint32Array<ArrayBuffer>;
}

/** 解码产物:levels 与 parentsByLevel 与 `buildMeshletDag` 返回值同构,消费面零换算。 */
export interface DgcDag {
  readonly levels: readonly DgcDagLevel[];
  /** parentsByLevel[k][c] = 层 k 簇 c 的父(层 k+1 索引);DGC_NO_PARENT = 无父。 */
  readonly parentsByLevel: readonly Uint32Array<ArrayBuffer>[];
}

interface Source { buffer: ArrayBuffer; base: number; bytes: Uint8Array; view: DataView }

const fail = (message: string): never => { throw new DgcFormatError(message); };
const hex = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, "0")}`;

function normalize(bytes: DgcBytes): Source {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer : bytes;
  if (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer) {
    fail("dgc: SharedArrayBuffer input is rejected (deterministic decode requires ArrayBuffer)");
  }
  const base = bytes instanceof Uint8Array ? bytes.byteOffset : 0;
  return { buffer: buffer as ArrayBuffer, base, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), view: new DataView(buffer as ArrayBuffer, base, bytes.byteLength) };
}

let table: Uint32Array | undefined;

/** CRC32C(Castagnoli,iSCSI 反射多项式 0x1EDC6F41,init/xorout 0xFFFFFFFF),表驱动;与 dgc.rs::crc32c 逐位一致。 */
export function crc32c(data: Uint8Array): number {
  const POLY = 0x82f63b78; // 0x1EDC6F41 的反射
  table ??= (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let crc = i; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ POLY : crc >>> 1; t[i] = crc; }
    return t;
  })();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ table[(crc ^ data[i]!) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

/** 保留字段护栏:任一非零字节立即抛错,报文含首个非零字节的绝对偏移。 */
function requireZeroReserved(view: DataView, base: number, size: number, where: string): void {
  for (let i = 0; i < size; i++) if (view.getUint8(base + i) !== 0) fail(`${where} reserved bytes must be zero (first nonzero at offset ${base + i})`);
}

/** 解析并校验 64B 文件头(magic/版本/flags 白名单/层级一致/尺寸锁/保留字段/上限)。 */
export function parseDgcHeader(bytes: DgcBytes): DgcFileHeader {
  const src = normalize(bytes);
  const view = src.view;
  if (view.byteLength < DGC_FILE_HEADER_SIZE) fail(`truncated: file is ${view.byteLength} bytes, need >= ${DGC_FILE_HEADER_SIZE} for header (offset 0)`);
  if (view.getUint32(0, true) !== 0x3143_4744) fail(`bad magic ${hex(view.getUint32(0, true))} at offset 0, expected "DGC1"`);
  const version = view.getUint32(0x04, true);
  if (version !== DGC_FORMAT_VERSION) fail(`unsupported version ${version} at offset 4, expected ${DGC_FORMAT_VERSION}`);
  const flags = view.getUint32(0x08, true);
  if (flags & ~DGC_FLAG_ZLIB) fail(`unknown flags ${hex(flags)} at offset 8 (only bit0 zlib is defined)`);
  const levelCount = view.getUint32(0x0c, true);
  if (levelCount === 0) fail("zero level count (offset 12)");
  const parentPairCount = view.getUint32(0x10, true);
  if (parentPairCount !== levelCount - 1) fail(`parent pairs ${parentPairCount} at offset 16 inconsistent with ${levelCount} levels`);
  const maxVertices = view.getUint32(0x1c, true);
  const maxTriangles = view.getUint32(0x20, true);
  if (maxVertices > DGC_MAX_VERTICES_LIMIT || maxTriangles > DGC_MAX_TRIANGLES_LIMIT) fail(`cluster limits exceed schema caps (file from a newer build?): maxVertices ${maxVertices}/${DGC_MAX_VERTICES_LIMIT}, maxTriangles ${maxTriangles}/${DGC_MAX_TRIANGLES_LIMIT} (offset 28)`);
  const totalFileSize = Number(view.getBigUint64(0x24, true));
  requireZeroReserved(view, 0x2c, 20, "header");
  if (totalFileSize !== view.byteLength) fail(`size lock mismatch: header says ${totalFileSize} (offset 36), file is ${view.byteLength}`);
  return {
    flags, compressed: (flags & DGC_FLAG_ZLIB) !== 0, levelCount, parentPairCount,
    sourceVertexCount: view.getUint32(0x14, true), sourceTriangleCount: view.getUint32(0x18, true),
    maxVertices, maxTriangles, totalFileSize,
  };
}

/** 解析全部 88B 段头并校验:段类型白名单、保留字段、payload 8 对齐与越界、头部区间完整。 */
export function parseDgcSections(bytes: DgcBytes, header: DgcFileHeader): DgcSectionHeader[] {
  const view = normalize(bytes).view;
  const len = view.byteLength;
  const sectionCount = header.levelCount + header.parentPairCount;
  const headerSpan = DGC_FILE_HEADER_SIZE + DGC_SECTION_HEADER_SIZE * sectionCount;
  if (len < headerSpan) fail(`truncated: ${len} bytes < header span ${headerSpan}`);
  const sections: DgcSectionHeader[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const base = DGC_FILE_HEADER_SIZE + DGC_SECTION_HEADER_SIZE * index;
    const kind = view.getUint32(base, true);
    if (kind !== DGC_SECTION_KIND_LEVEL && kind !== DGC_SECTION_KIND_PARENTS) fail(`unknown section kind ${kind} (section ${index} kind at offset ${base})`);
    requireZeroReserved(view, base + 0x4c, 12, `section ${index}`);
    const counts = Array.from({ length: 8 }, (_, slot) => view.getUint32(base + 0x10 + slot * 4, true)) as unknown as DgcSectionHeader["counts"];
    const rawSize = Number(view.getBigUint64(base + 0x30, true));
    const storedSize = Number(view.getBigUint64(base + 0x38, true));
    const payloadOffset = Number(view.getBigUint64(base + 0x40, true));
    if (payloadOffset % DGC_PAYLOAD_ALIGNMENT !== 0) fail(`section ${index} payload offset ${payloadOffset} is not ${DGC_PAYLOAD_ALIGNMENT}-byte aligned (offset ${base + 0x40})`);
    if (payloadOffset + storedSize > len) fail(`section ${index} payload [${payloadOffset}, ${payloadOffset + storedSize}) exceeds file size ${len} (offset ${base + 0x40})`);
    sections.push({
      index, kind, level: view.getUint32(base + 0x04, true), error: view.getFloat64(base + 0x08, true),
      counts, rawSize, storedSize, payloadOffset, crc32c: view.getUint32(base + 0x48, true),
    });
  }
  return sections;
}

/** 解压/取出段 payload,锁定尺寸:未压缩 stored==raw;zlib 输出必须精确等于 raw_size(防炸弹)。 */
function decodePayload(src: Source, section: DgcSectionHeader, compressed: boolean): Uint8Array {
  const { index, payloadOffset, storedSize, rawSize } = section;
  const stored = src.bytes.subarray(payloadOffset, payloadOffset + storedSize);
  if (!compressed) {
    if (storedSize !== rawSize) fail(`section ${index}: uncompressed stored size ${storedSize} != raw size ${rawSize}`);
    return stored;
  }
  let out: Uint8Array = new Uint8Array(0);
  try {
    out = unzlibSync(stored);
  } catch (error) {
    fail(`section ${index} zlib decode failed (offset ${payloadOffset}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (out.length !== rawSize) fail(`section ${index}: zlib payload size ${out.length} != header raw size ${rawSize}`);
  return out;
}

/** 在 payload 的元素偏移处建 typed array 视图;绝对字节偏移非 4 对齐时回退拷贝(保零拷贝主路径)。 */
function arrayView<T>(ctor: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => T, payload: Uint8Array, elementOffset: number, count: number): T {
  const byteOffset = payload.byteOffset + elementOffset * 4;
  if (byteOffset % 4 === 0) return new ctor(payload.buffer, byteOffset, count);
  return new ctor(payload.buffer.slice(byteOffset, byteOffset + count * 4), 0, count);
}

const f32View = (payload: Uint8Array, elementOffset: number, count: number): Float32Array<ArrayBuffer> => arrayView(Float32Array, payload, elementOffset, count) as Float32Array<ArrayBuffer>;
const u32View = (payload: Uint8Array, elementOffset: number, count: number): Uint32Array<ArrayBuffer> => arrayView(Uint32Array, payload, elementOffset, count) as Uint32Array<ArrayBuffer>;

function decodeLevelSection(section: DgcSectionHeader, raw: Uint8Array, maxVertices: number, maxTriangles: number): DgcDagLevel {
  const label = `level section ${section.level}`;
  const [positions, indices, descriptors, remap, localTri, bounds, sourceTri, spans] = section.counts;
  if (positions! % 3 !== 0 || indices! % 3 !== 0) fail(`${label}: position/index counts must be triples (section ${section.index})`);
  const meshletCount = descriptors! / 4;
  if (descriptors! % 4 !== 0 || spans! % 2 !== 0 || meshletCount !== spans! / 2) {
    fail(`${label}: ${spans! / 2} span pairs inconsistent with ${meshletCount} meshlets (section ${section.index})`);
  }
  if (bounds! !== 16 * meshletCount) fail(`${label}: bounds count ${bounds} != 16 × meshlet count ${meshletCount} (section ${section.index})`);
  if (localTri! !== indices! / 3) fail(`${label}: local triangle count ${localTri} != triangle count ${indices! / 3} (section ${section.index})`);
  const where = `(section ${section.index})`;
  const payloadPositions = f32View(raw, 0, positions!);
  const payloadIndices = u32View(raw, positions!, indices!);
  let cursor = positions! + indices!;
  const descriptorsView = u32View(raw, cursor, descriptors!);
  const remapView = u32View(raw, cursor += descriptors!, remap!);
  const localTriView = u32View(raw, cursor += remap!, localTri!);
  const boundsView = f32View(raw, cursor += localTri!, bounds!);
  const sourceTriView = u32View(raw, cursor += bounds!, sourceTri!);
  const spansView = u32View(raw, cursor += sourceTri!, spans!);
  let remapSum = 0;
  for (let c = 0; c < meshletCount; c++) remapSum += descriptorsView[c * 4 + 1]!;
  if (remap! !== remapSum) fail(`${label}: vertex remap count ${remap} != sum of descriptor vertex counts ${remapSum} ${where}`);
  const vertexCount = positions! / 3;
  for (let i = 0; i < indices!; i++) {
    if (payloadIndices[i]! >= vertexCount) fail(`${label}: index ${payloadIndices[i]} out of vertex range ${vertexCount} ${where}`);
  }
  let expectedStart = 0;
  for (let c = 0; c < meshletCount; c++) {
    const [start, end] = [spansView[c * 2]!, spansView[c * 2 + 1]!];
    if (start !== expectedStart || end < start) fail(`${label}: cluster source spans not a prefix-sum chain ${where}`);
    expectedStart = end;
  }
  if (expectedStart !== indices! / 3) fail(`${label}: spans cover ${expectedStart} triangles, indices have ${indices! / 3} ${where}`);
  return {
    level: section.level, error: section.error, positions: payloadPositions, indices: payloadIndices, meshletCount, maxVertices, maxTriangles,
    descriptors: descriptorsView, vertexRemap: remapView, localTriangleIndices: localTriView,
    bounds: boundsView, sourceTriangles: sourceTriView, clusterSourceSpans: spansView,
  };
}

function decodeParentsSection(section: DgcSectionHeader, raw: Uint8Array, levels: DgcDagLevel[], levelCount: number): Uint32Array<ArrayBuffer> {
  const label = `parents section for level ${section.level}`;
  if (section.level >= levelCount - 1) fail(`${label}: references level ${section.level} as fine side, but last level is ${levelCount - 1}`);
  const fine = levels[section.level]!;
  if (section.counts[0] !== fine.meshletCount) fail(`${label}: ${section.counts[0]} entries, fine level has ${fine.meshletCount} clusters`);
  const coarseCount = levels[section.level + 1]!.meshletCount;
  const parents = u32View(raw, 0, section.counts[0]);
  for (let c = 0; c < parents.length; c++) {
    const parent = parents[c]!;
    if (parent !== DGC_NO_PARENT && parent >= coarseCount) fail(`${label}: cluster ${c} parent ${parent} out of range (coarse has ${coarseCount} clusters)`);
  }
  return parents;
}

/**
 * 解析并完整校验 `.dgc` 字节流(校验链全集,见 dgc-format-spec.md §校验链):
 * magic/版本/flags 白名单、total_file_size 锁定、保留字段全 0、段顺序合同、
 * payload 对齐与越界、stored↔raw 尺寸关系、逐段 CRC32C、counts 不变量、
 * spans 前缀和链、indices 越界、parents 条数与范围、level 0 尺寸与文件头一致。
 * 常见路径零拷贝:views 直接建立在输入 buffer / 解压输出之上。
 */
export function decodeDgc(bytes: DgcBytes): DgcDag {
  const src = normalize(bytes);
  const header = parseDgcHeader(bytes);
  const sections = parseDgcSections(bytes, header);
  const levels: DgcDagLevel[] = [];
  const parentsByLevel: Uint32Array<ArrayBuffer>[] = [];
  for (const section of sections) {
    if (section.kind === DGC_SECTION_KIND_LEVEL) {
      if (section.level !== levels.length) fail(`level sections must appear in order: section ${section.index} has level ${section.level}, expected ${levels.length}`);
      const total = section.counts.reduce((sum, count) => sum + count, 0);
      if (section.rawSize !== total * 4) fail(`level section ${section.level}: counts imply ${total * 4} bytes, header says ${section.rawSize} (section ${section.index})`);
    } else {
      if (levels.length !== header.levelCount) fail(`parents section encountered before all level sections (order contract violated, section ${section.index})`);
      if (section.level !== parentsByLevel.length) fail(`parents sections must appear in fine-level order, expected ${parentsByLevel.length} (section ${section.index})`);
      if (section.counts[0] * 4 !== section.rawSize) fail(`parents section for level ${section.level}: counts imply ${section.counts[0] * 4} bytes, header says ${section.rawSize} (section ${section.index})`);
    }
    const raw = decodePayload(src, section, header.compressed);
    const actualCrc = crc32c(raw);
    if (actualCrc !== section.crc32c) fail(`section ${section.index} crc mismatch: file ${hex(section.crc32c)}, computed ${hex(actualCrc)}`);
    if (section.kind === DGC_SECTION_KIND_LEVEL) {
      levels.push(decodeLevelSection(section, raw, header.maxVertices, header.maxTriangles));
    } else {
      parentsByLevel.push(decodeParentsSection(section, raw, levels, header.levelCount));
    }
  }
  if (levels.length !== header.levelCount || parentsByLevel.length !== header.parentPairCount) {
    fail(`section count mismatch after parse: ${levels.length} levels / ${parentsByLevel.length} parent pairs, expected ${header.levelCount}/${header.parentPairCount}`);
  }
  const level0 = levels[0]!;
  if (level0.positions.length / 3 !== header.sourceVertexCount || level0.indices.length / 3 !== header.sourceTriangleCount) {
    fail(`level 0 geometry size disagrees with file header: positions ${level0.positions.length / 3} vs ${header.sourceVertexCount}, triangles ${level0.indices.length / 3} vs ${header.sourceTriangleCount}`);
  }
  return { levels, parentsByLevel };
}
