/**
 * 测试专用 `.dgc` 编码器 —— 镜像 `geometry_dag/src/dgc.rs::write_dgc` 的写路径
 * (64B 头 + 88B 段头 ×N + 8 对齐 payload,逐段 CRC32C,可选 zlib level 6)。
 * 用途:把 golden fixture(TS buildMeshletDag 的逐位存档)编成 .dgc 字节流喂给
 * decodeDgc 做对拍,以及制造各类损坏变体覆盖 fail-closed 矩阵。
 * CRC32C 直接复用加载器实现(编码↔解码共用与 Rust 对拍过的同一张表)。
 */
import { zlibSync } from "fflate";
import { crc32c, DGC_FILE_HEADER_SIZE, DGC_FLAG_ZLIB, DGC_FORMAT_VERSION, DGC_PAYLOAD_ALIGNMENT, DGC_SECTION_HEADER_SIZE, DGC_SECTION_KIND_LEVEL, DGC_SECTION_KIND_PARENTS } from "./dgcLoader.js";

/** 编码器视角的单层:数组槽一律为 LE 原始字节(golden JSON 的 b64 解码产物)。 */
export interface DgcEncoderLevel {
  readonly level: number;
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

export interface DgcEncoderDag {
  readonly sourceVertexCount: number;
  readonly sourceTriangleCount: number;
  readonly maxVertices: number;
  readonly maxTriangles: number;
  readonly levels: readonly DgcEncoderLevel[];
  /** 每项为细层 k → 粗层 k+1 的父索引表(0xFFFFFFFF = 无父)。 */
  readonly parentsByLevel: readonly Uint32Array[];
}

/** golden fixture JSON 的最小类型面(数组槽均为 base64 LE 字节)。 */
export interface GoldenJson {
  readonly options: { readonly levels: number; readonly maxTriangles: number };
  readonly input: {
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly positionsB64: string;
    readonly indicesB64: string;
  };
  readonly levels: readonly {
    readonly level: number;
    readonly error: number;
    readonly positionsB64: string;
    readonly indicesB64: string;
    readonly descriptorsB64: string;
    readonly vertexRemapB64: string;
    readonly localTriangleIndicesB64: string;
    readonly boundsB64: string;
    readonly sourceTrianglesB64: string;
    readonly clusterSourceSpansB64: string;
  }[];
  readonly parentsByLevel: readonly number[][];
}

export const b64ToBytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/** golden JSON → 编码器 DAG(逐槽 b64 → LE 字节;parents 原样保留 0xFFFFFFFF 哨兵)。 */
export function goldenToEncoderDag(json: GoldenJson): DgcEncoderDag {
  return {
    sourceVertexCount: json.input.vertexCount,
    sourceTriangleCount: json.input.triangleCount,
    maxVertices: 64,
    maxTriangles: json.options.maxTriangles,
    levels: json.levels.map((level) => ({
      level: level.level,
      error: level.error,
      positions: b64ToBytes(level.positionsB64),
      indices: b64ToBytes(level.indicesB64),
      descriptors: b64ToBytes(level.descriptorsB64),
      vertexRemap: b64ToBytes(level.vertexRemapB64),
      localTriangleIndices: b64ToBytes(level.localTriangleIndicesB64),
      bounds: b64ToBytes(level.boundsB64),
      sourceTriangles: b64ToBytes(level.sourceTrianglesB64),
      clusterSourceSpans: b64ToBytes(level.clusterSourceSpansB64),
    })),
    parentsByLevel: json.parentsByLevel.map((parents) => new Uint32Array(parents)),
  };
}

const align8 = (value: number): number => Math.ceil(value / DGC_PAYLOAD_ALIGNMENT) * DGC_PAYLOAD_ALIGNMENT;
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) { out.set(part, cursor); cursor += part.length; }
  return out;
};

/** 序列化 DAG 为 .dgc 字节流(compress 缺省 true,与 Rust DgcWriteOptions::default 一致)。 */
export function encodeDgc(dag: DgcEncoderDag, options?: { compress?: boolean }): ArrayBuffer {
  const compress = options?.compress ?? true;
  interface Record { kind: number; level: number; error: number; counts: number[]; raw: Uint8Array; stored: Uint8Array; payloadOffset: number }
  const records: Record[] = [];
  for (const level of dag.levels) {
    const raw = concat([level.positions, level.indices, level.descriptors, level.vertexRemap, level.localTriangleIndices, level.bounds, level.sourceTriangles, level.clusterSourceSpans]);
    const counts = [level.positions, level.indices, level.descriptors, level.vertexRemap, level.localTriangleIndices, level.bounds, level.sourceTriangles, level.clusterSourceSpans].map((bytes) => bytes.length / 4);
    records.push({ kind: DGC_SECTION_KIND_LEVEL, level: level.level, error: level.error, counts, raw, stored: raw, payloadOffset: 0 });
  }
  for (let k = 0; k < dag.parentsByLevel.length; k++) {
    const parents = dag.parentsByLevel[k]!;
    const raw = new Uint8Array(parents.buffer, parents.byteOffset, parents.byteLength);
    records.push({ kind: DGC_SECTION_KIND_PARENTS, level: k, error: 0, counts: [parents.length, 0, 0, 0, 0, 0, 0, 0], raw, stored: raw, payloadOffset: 0 });
  }
  let offset = DGC_FILE_HEADER_SIZE + DGC_SECTION_HEADER_SIZE * records.length;
  for (const record of records) {
    offset = align8(offset);
    record.payloadOffset = offset;
    record.stored = compress ? zlibSync(record.raw, { level: 6 }) : record.raw;
    offset += record.stored.length;
  }
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  const u32 = (at: number, value: number) => view.setUint32(at, value, true);
  const u64 = (at: number, value: number) => view.setBigUint64(at, BigInt(value), true);
  for (let i = 0; i < 4; i++) out[i] = DGC_MAGIC_BYTES[i]!;
  u32(0x04, DGC_FORMAT_VERSION);
  u32(0x08, compress ? DGC_FLAG_ZLIB : 0);
  u32(0x0c, dag.levels.length);
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
  return out.buffer;
}

const DGC_MAGIC_BYTES = [0x44, 0x47, 0x43, 0x31] as const;
