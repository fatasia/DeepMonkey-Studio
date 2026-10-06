/**
 * `.dgc`(Deep Geometry Clusters)v1 **生产编码器** —— 场景包驻留摄入链的写端。
 *
 * 字节合同与权威实现 `deep-engine-native/geometry_dag/src/dgc.rs::write_dgc` 逐位一致:
 * 64B 文件头 + 88B 段头 ×N(LEVEL 层几何 + PARENTS 父表)+ 8 字节对齐段 payload +
 * 逐段 CRC32C(raw 字节)+ 可选 zlib level 6 压缩(flags bit0,整文件同档)。
 * 布局规格:`geometry_dag/docs/dgc-format-spec.md`;读取端:`dgcLoader.ts`(同一张
 * CRC32C 表,编码↔解码共用)。与 `dgcEncoder.testUtils.ts`(测试专用、收已序列化字节
 * 槽)的关系:本文件是生产入口,收 typed-array DAG;测试工具镜像同一布局——字节级
 * 一致性由 dgcEncoder.test.ts 用入库未压缩黄金字节(geometry_dag dgc_byte_golden 门,
 * 与 zlib 实现无关、永久锁定)对拍钉住,两写端漂移立即打红。
 *
 * == 输入 ==
 * {@link DgcEncodableDag} 是 buildMeshletDag / decodeDgc 产物的结构最小面(字段级同构,
 * 见 dgcDagBridge 头注);两个适配器从各自产物零拷贝取视图,不做任何数值换算。
 *
 * == fail-closed(与 Rust write_dgc 同一守卫集) ==
 * 空层、父表数量 ≠ 层数-1、源计数/簇数超 u32、父索引越界粗层簇数、u32 槽字节数非 4 的
 * 倍数 —— 一律抛 {@link DgcFormatError};完整结构校验(尺寸锁/CRC/不变量)仍由
 * decodeDgc 在读回时全量把关,摄入链上编码产物必须经解码回路签核后才可驻留。
 */
import { zlibSync } from "fflate";
import { crc32c, DgcFormatError, DGC_FILE_HEADER_SIZE, DGC_FLAG_ZLIB, DGC_FORMAT_VERSION,
  DGC_MAGIC, DGC_NO_PARENT, DGC_PAYLOAD_ALIGNMENT, DGC_SECTION_HEADER_SIZE,
  DGC_SECTION_KIND_LEVEL, DGC_SECTION_KIND_PARENTS } from "./dgcLoader.js";
import type { DgcDag, DgcDagLevel } from "./dgcLoader.js";
import type { MeshletDag } from "./meshletDag.js";

/** 可编码单层:8 个数组槽均为小端原始字节(与 .dgc 段 payload 槽序一致)。 */
export interface DgcEncodableLevel {
  readonly level: number;
  /** 层误差(f64,LE);level 0 恒 0。 */
  readonly error: number;
  readonly positions: Uint8Array;
  readonly indices: Uint8Array;
  readonly descriptors: Uint8Array;
  readonly vertexRemap: Uint8Array;
  readonly localTriangleIndices: Uint8Array;
  readonly bounds: Uint8Array;
  readonly sourceTriangles: Uint8Array;
  readonly clusterSourceSpans: Uint8Array;
}

/** 可编码 DAG:文件头随附的构建参数 + 层槽 + 逐层父表(NO_PARENT 哨兵原样保留)。 */
export interface DgcEncodableDag {
  readonly sourceVertexCount: number;
  readonly sourceTriangleCount: number;
  /** 簇顶点/三角形上限(随文件持久化的构建参数,读端校验上限 64/126)。 */
  readonly maxVertices: number;
  readonly maxTriangles: number;
  readonly levels: readonly DgcEncodableLevel[];
  /** parentsByLevel[k][c] = 层 k 簇 c 的父(层 k+1 索引);k ∈ [0, levels-2]。 */
  readonly parentsByLevel: readonly Uint32Array[];
}

export interface DgcEncodeOptions {
  /** 缺省 true(与 Rust DgcWriteOptions::default 一致)。false = 原始字节直写。 */
  readonly compress?: boolean;
}

/** MeshletDag / DgcDag 单层的结构最小面(槽为 typed array,字段名与两者公共集一致)。 */
export interface DgcEncodableSourceLevel {
  readonly level: number;
  readonly error: number;
  readonly positions: Float32Array | Uint8Array;
  readonly indices: Uint32Array | Uint8Array;
  readonly descriptors: Uint32Array | Uint8Array;
  readonly vertexRemap: Uint32Array | Uint8Array;
  readonly localTriangleIndices: Uint32Array | Uint8Array;
  readonly bounds: Float32Array | Uint8Array;
  readonly sourceTriangles: Uint32Array | Uint8Array;
  readonly clusterSourceSpans: Uint32Array | Uint8Array;
}

/**
 * MeshletDag → 可编码 DAG(零拷贝:typed array 按 LE 字节视图透传)。
 * maxVertices/maxTriangles 必须与 buildMeshletDag 的构建选项同值——它们随文件头持久化,
 * 读端按此校验簇内计数;调用方传错会在 decodeDgc 回路签核时显式打红,不静默。
 */
export function meshletDagToEncodable(dag: MeshletDag,
  build: { readonly maxVertices: number; readonly maxTriangles: number },
  source?: { readonly sourceVertexCount: number; readonly sourceTriangleCount: number }): DgcEncodableDag {
  // MeshletDag.parentsByLevel 声明为单 Uint32Array、运行时为逐层数组(dgcDagBridge 头注
  // 同款收窄;漂移由 meshletDag.test 钉住)。
  const parents = dag.parentsByLevel as unknown as readonly Uint32Array[];
  const level0 = dag.levels[0]!;
  return {
    sourceVertexCount: source?.sourceVertexCount ?? level0.positions.length / 3,
    sourceTriangleCount: source?.sourceTriangleCount ?? level0.indices.length / 3,
    maxVertices: build.maxVertices, maxTriangles: build.maxTriangles,
    levels: dag.levels.map(toEncodableLevel), parentsByLevel: parents,
  };
}

/** DgcDag → 可编码 DAG(零拷贝;源计数取 level0,maxVertices/maxTriangles 取层档案字段)。 */
export function dgcDagToEncodable(dag: DgcDag): DgcEncodableDag {
  const level0 = dag.levels[0]!;
  return { sourceVertexCount: level0.positions.length / 3,
    sourceTriangleCount: level0.indices.length / 3,
    maxVertices: level0.maxVertices, maxTriangles: level0.maxTriangles,
    levels: dag.levels.map(toEncodableLevel), parentsByLevel: dag.parentsByLevel };
}

function toEncodableLevel(level: DgcEncodableSourceLevel | DgcDagLevel): DgcEncodableLevel {
  return { level: level.level, error: level.error,
    positions: littleEndianBytes(level.positions), indices: littleEndianBytes(level.indices),
    descriptors: littleEndianBytes(level.descriptors), vertexRemap: littleEndianBytes(level.vertexRemap),
    localTriangleIndices: littleEndianBytes(level.localTriangleIndices),
    bounds: littleEndianBytes(level.bounds), sourceTriangles: littleEndianBytes(level.sourceTriangles),
    clusterSourceSpans: littleEndianBytes(level.clusterSourceSpans) };
}

/** typed array → LE 原始字节视图(平台本就是 LE 之外的端序由 DataView 写出兜底;视图零拷贝)。 */
function littleEndianBytes(slot: Float32Array | Uint8Array | Uint32Array): Uint8Array {
  if (slot instanceof Uint8Array) return slot;
  return new Uint8Array(slot.buffer, slot.byteOffset, slot.byteLength);
}

interface SectionRecord {
  readonly kind: number;
  readonly level: number;
  readonly error: number;
  /** 8 槽元素计数(与 Rust counts = slot.len() 同口径)。 */
  readonly counts: readonly number[];
  readonly raw: Uint8Array;
  stored: Uint8Array;
  payloadOffset: number;
}

/**
 * DAG → `.dgc` 字节流(与 Rust write_dgc 逐位一致;压缩档依赖 zlib 实现确定性,
 * 未压缩档与 zlib 无关、永久锁定)。产物必须经 decodeDgc 回路签核后才可驻留。
 */
export function encodeDgc(dag: DgcEncodableDag, options: DgcEncodeOptions = {}): Uint8Array {
  const compress = options.compress ?? true;
  const levelCount = dag.levels.length;
  if (levelCount === 0) throw new DgcFormatError("dgc encoder: cannot serialize an empty DAG.");
  if (dag.parentsByLevel.length !== levelCount - 1) {
    throw new DgcFormatError(`dgc encoder: ${dag.parentsByLevel.length} parent tables for `
      + `${levelCount} levels, expected ${levelCount - 1}.`);
  }
  if (!Number.isSafeInteger(dag.sourceVertexCount) || dag.sourceVertexCount < 0
    || dag.sourceVertexCount > 0xffffffff || !Number.isSafeInteger(dag.sourceTriangleCount)
    || dag.sourceTriangleCount < 0 || dag.sourceTriangleCount > 0xffffffff) {
    throw new DgcFormatError("dgc encoder: source counts must be non-negative u32.");
  }
  const records: SectionRecord[] = [];
  for (const level of dag.levels) {
    const slots = [level.positions, level.indices, level.descriptors, level.vertexRemap,
      level.localTriangleIndices, level.bounds, level.sourceTriangles, level.clusterSourceSpans];
    for (const slot of slots) {
      if (slot.length % 4 !== 0 || slot.byteLength % 4 !== 0) {
        throw new DgcFormatError(`dgc encoder: level ${level.level} has a non-word-aligned slot `
          + `(${slot.byteLength} bytes).`);
      }
    }
    records.push({ kind: DGC_SECTION_KIND_LEVEL, level: level.level, error: level.error,
      counts: slots.map(slot => slot.length / 4), raw: concat(slots),
      stored: new Uint8Array(0), payloadOffset: 0 });
  }
  for (let k = 0; k < dag.parentsByLevel.length; k++) {
    const parents = dag.parentsByLevel[k]!;
    // 粗层簇数:descriptors 槽 16 字节/簇(4×u32),与 Rust coarse_count 同口径。
    const coarseCount = dag.levels[k + 1]!.descriptors.length / 16;
    for (const parent of parents) {
      if (parent !== DGC_NO_PARENT && parent >= coarseCount) {
        throw new DgcFormatError(`dgc encoder: parent ${parent} out of range for coarse level `
          + `${k + 1} (${coarseCount} clusters).`);
      }
    }
    records.push({ kind: DGC_SECTION_KIND_PARENTS, level: k, error: 0,
      counts: [parents.length, 0, 0, 0, 0, 0, 0, 0],
      raw: new Uint8Array(parents.buffer, parents.byteOffset, parents.byteLength),
      stored: new Uint8Array(0), payloadOffset: 0 });
  }
  let offset = DGC_FILE_HEADER_SIZE + DGC_SECTION_HEADER_SIZE * records.length;
  for (const record of records) {
    offset = Math.ceil(offset / DGC_PAYLOAD_ALIGNMENT) * DGC_PAYLOAD_ALIGNMENT;
    record.payloadOffset = offset;
    record.stored = compress ? zlibSync(record.raw, { level: 6 }) : record.raw;
    offset += record.stored.length;
  }
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  const u32 = (at: number, value: number): void => view.setUint32(at, value, true);
  const u64 = (at: number, value: number): void => view.setBigUint64(at, BigInt(value), true);
  for (let i = 0; i < 4; i++) out[i] = DGC_MAGIC.charCodeAt(i);
  u32(0x04, DGC_FORMAT_VERSION);
  u32(0x08, compress ? DGC_FLAG_ZLIB : 0);
  u32(0x0c, levelCount);
  u32(0x10, dag.parentsByLevel.length);
  u32(0x14, dag.sourceVertexCount);
  u32(0x18, dag.sourceTriangleCount);
  u32(0x1c, dag.maxVertices);
  u32(0x20, dag.maxTriangles);
  u64(0x24, offset);
  let base = DGC_FILE_HEADER_SIZE;
  for (const record of records) {
    u32(base, record.kind);
    u32(base + 0x04, record.level);
    view.setFloat64(base + 0x08, record.error, true);
    record.counts.forEach((count, slot) => u32(base + 0x10 + slot * 4, count));
    u64(base + 0x30, record.raw.length);
    u64(base + 0x38, record.stored.length);
    u64(base + 0x40, record.payloadOffset);
    u32(base + 0x48, crc32c(record.raw));
    base += DGC_SECTION_HEADER_SIZE;
  }
  for (const record of records) out.set(record.stored, record.payloadOffset);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) { out.set(part, cursor); cursor += part.length; }
  return out;
}
