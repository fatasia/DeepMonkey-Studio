/**
 * 生产 `.dgc` 编码器(dgcEncoder.ts)门:
 * 1. 写端字节对拍 —— 编码器重编解码产物 == geometry_dag 入库未压缩黄金字节
 *    (dgc_byte_golden 门常开字节,与 zlib 实现无关、永久锁定容器布局);
 * 2. 跨档同构 —— 压缩档解码后按未压缩重编 == 未压缩档字节(同一 DAG 两档互证);
 * 3. 全链字节对拍 —— TS buildMeshletDag(黄金输入)→ meshletDagToEncodable →
 *    encodeDgc(未压缩)逐位 == Rust 权威写端产物(buildMeshletDag 逐位对拍由
 *    golden_parity 门钉住,此处把"TS 场景→.dgc"整条生产链钉进同一字节合同);
 * 4. 回路签核 + 确定性 + fail-closed 反例(与 Rust write_dgc 同一守卫集)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { b64ToBytes, type GoldenJson } from "./dgcEncoder.testUtils.js";
import { dgcDagToEncodable, encodeDgc, meshletDagToEncodable,
  type DgcEncodableDag } from "./dgcEncoder.js";
import { DGC_MAGIC, DgcFormatError, decodeDgc } from "./dgcLoader.js";
import { buildMeshletDag } from "./meshletDag.js";
import type { IndexedTriangleGeometry } from "./types.js";

const FIXTURES = new URL("../../../deep-engine-native/geometry_dag/tests/fixtures/", import.meta.url);
const loadGolden = (name: string): GoldenJson =>
  JSON.parse(readFileSync(new URL(`${name}.golden.json`, FIXTURES), "utf8")) as GoldenJson;

interface ByteVariantJson { readonly sha256: string; readonly byteCount: number; readonly bytesB64: string }
const byteVariant = (name: "compressed" | "uncompressed"): Uint8Array => {
  const json = JSON.parse(readFileSync(new URL("quick_sphere.dgc.golden.json", FIXTURES), "utf8")) as
    { readonly variants: Record<string, ByteVariantJson> };
  const variant = json.variants[name]!;
  const bytes = b64ToBytes(variant.bytesB64);
  expect(bytes.length, `${name} byteCount 与入库声明一致`).toBe(variant.byteCount);
  return bytes;
};

const bytesOf = (view: ArrayBufferView): Uint8Array =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
const goldenGeometry = (json: GoldenJson): IndexedTriangleGeometry => ({
  positions: new Float32Array(b64ToBytes(json.input.positionsB64).buffer),
  indices: new Uint32Array(b64ToBytes(json.input.indicesB64).buffer),
});

describe("dgcEncoder(生产写端)", () => {
  const uncompressed = byteVariant("uncompressed");
  const compressed = byteVariant("compressed");

  it("重编解码产物逐位 == 入库未压缩黄金字节(写端字节合同,门常开)", () => {
    const decoded = decodeDgc(uncompressed);
    const encoded = encodeDgc(dgcDagToEncodable(decoded), { compress: false });
    expect(encoded.byteLength).toBe(uncompressed.byteLength);
    expect(Buffer.from(encoded).equals(Buffer.from(uncompressed))).toBe(true);
  });

  it("跨档同构:压缩档解码 → 未压缩重编 == 未压缩档字节(同一 DAG 两档互证)", () => {
    const decoded = decodeDgc(compressed);
    const encoded = encodeDgc(dgcDagToEncodable(decoded), { compress: false });
    expect(Buffer.from(encoded).equals(Buffer.from(uncompressed))).toBe(true);
  });

  it("全链:TS buildMeshletDag(黄金输入)→ 编码(未压缩)逐位 == Rust 权威写端产物", () => {
    const json = loadGolden("quick_sphere");
    const dag = buildMeshletDag(goldenGeometry(json),
      { levels: json.options.levels, maxTriangles: json.options.maxTriangles });
    const encodable = meshletDagToEncodable(dag,
      { maxVertices: 64, maxTriangles: json.options.maxTriangles });
    const encoded = encodeDgc(encodable, { compress: false });
    expect(Buffer.from(encoded).equals(Buffer.from(uncompressed))).toBe(true);
  });

  it("回路签核:编码 → decodeDgc 字段级还原(头部/层槽字节/父表含 NO_PARENT)", () => {
    const decoded = decodeDgc(uncompressed);
    const encoded = encodeDgc(dgcDagToEncodable(decoded), { compress: true });
    const round = decodeDgc(encoded);
    expect(round.sourceVertexCount).toBe(decoded.sourceVertexCount);
    expect(round.sourceTriangleCount).toBe(decoded.sourceTriangleCount);
    expect(round.maxVertices).toBe(decoded.maxVertices);
    expect(round.maxTriangles).toBe(decoded.maxTriangles);
    expect(round.levels.length).toBe(decoded.levels.length);
    expect(round.parentsByLevel.length).toBe(decoded.parentsByLevel.length);
    round.levels.forEach((level, index) => {
      const source = decoded.levels[index]!;
      expect(level.level).toBe(source.level);
      expect(level.error).toBe(source.error);
      expect(level.meshletCount).toBe(source.meshletCount);
      for (const slot of ["positions", "indices", "descriptors", "vertexRemap", "localTriangleIndices",
        "bounds", "sourceTriangles", "clusterSourceSpans"] as const) {
        expect(Buffer.from(bytesOf(level[slot])).equals(Buffer.from(bytesOf(source[slot]))),
          `level ${index} slot ${slot}`).toBe(true);
      }
    });
    round.parentsByLevel.forEach((parents, index) =>
      expect([...parents]).toEqual([...decoded.parentsByLevel[index]!]));
    expect(encoded[0]).toBe(DGC_MAGIC.charCodeAt(0));
    expect(encoded[1]).toBe(DGC_MAGIC.charCodeAt(1));
    expect(encoded[2]).toBe(DGC_MAGIC.charCodeAt(2));
    expect(encoded[3]).toBe(DGC_MAGIC.charCodeAt(3));
  });

  it("确定性:同输入两次编码逐位同输出(压缩/未压缩双档)", () => {
    const decoded = decodeDgc(uncompressed);
    for (const compress of [false, true]) {
      const first = encodeDgc(dgcDagToEncodable(decoded), { compress });
      const second = encodeDgc(dgcDagToEncodable(decoded), { compress });
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    }
  });

  it("fail-closed:空层 / 父表数量不符 / 父索引越界 / 槽非字对齐,逐反例打红", () => {
    const decoded = decodeDgc(uncompressed);
    const valid = dgcDagToEncodable(decoded);
    expect(() => encodeDgc({ ...valid, levels: [] })).toThrow(DgcFormatError);
    expect(() => encodeDgc({ ...valid, parentsByLevel: [] })).toThrow(DgcFormatError);
    expect(() => encodeDgc({ ...valid,
      parentsByLevel: [new Uint32Array([0xfffffffe])] })).toThrow(/out of range/);
    expect(() => encodeDgc({ ...valid, levels: valid.levels.map((level, index) =>
      index === 0 ? { ...level, descriptors: new Uint8Array(2) } : level) }))
      .toThrow(/non-word-aligned/);
  });

  it("meshletDagToEncodable:显式 source 计数覆盖 level0 推导(供多实例合并分节传精确值)", () => {
    const json = loadGolden("quick_sphere");
    const dag = buildMeshletDag(goldenGeometry(json),
      { levels: json.options.levels, maxTriangles: json.options.maxTriangles });
    const encodable = meshletDagToEncodable(dag, { maxVertices: 64, maxTriangles: 64 },
      { sourceVertexCount: 7, sourceTriangleCount: 9 });
    expect(encodable.sourceVertexCount).toBe(7);
    expect(encodable.sourceTriangleCount).toBe(9);
    expect(encodable.levels.length).toBe(dag.levels.length);
    expect(encodable.parentsByLevel.length).toBe(dag.levels.length - 1);
  });

  it("合成 DAG(两层三簇)端到端:编码 → 解码 → 簇计数与父表一致", () => {
    const synthetic: DgcEncodableDag = {
      sourceVertexCount: 3, sourceTriangleCount: 1, maxVertices: 64, maxTriangles: 126,
      levels: [
        { level: 0, error: 0, positions: new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
          indices: new Uint8Array(new Uint32Array([0, 1, 2]).buffer),
          descriptors: new Uint8Array(new Uint32Array([0, 3, 0, 1]).buffer),
          vertexRemap: new Uint8Array(new Uint32Array([0, 1, 2]).buffer),
          localTriangleIndices: new Uint8Array(new Uint32Array([0 | 1 << 8 | 2 << 16]).buffer),
          bounds: new Uint8Array(new Float32Array(16).buffer),
          sourceTriangles: new Uint8Array(new Uint32Array([0]).buffer),
          clusterSourceSpans: new Uint8Array(new Uint32Array([0, 1]).buffer) },
        { level: 1, error: 0.5, positions: new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer),
          indices: new Uint8Array(new Uint32Array([0, 1, 2]).buffer),
          descriptors: new Uint8Array(new Uint32Array([0, 3, 0, 1]).buffer),
          vertexRemap: new Uint8Array(new Uint32Array([0, 1, 2]).buffer),
          localTriangleIndices: new Uint8Array(new Uint32Array([0 | 1 << 8 | 2 << 16]).buffer),
          bounds: new Uint8Array(new Float32Array(16).buffer),
          sourceTriangles: new Uint8Array(new Uint32Array([0]).buffer),
          clusterSourceSpans: new Uint8Array(new Uint32Array([0, 1]).buffer) },
      ],
      parentsByLevel: [new Uint32Array([0])],
    };
    const encoded = encodeDgc(synthetic, { compress: false });
    const decoded = decodeDgc(encoded);
    expect(decoded.levels.length).toBe(2);
    expect(decoded.levels[0]!.meshletCount).toBe(1);
    expect(decoded.levels[1]!.meshletCount).toBe(1);
    expect(decoded.levels[1]!.error).toBe(0.5);
    expect([...decoded.parentsByLevel[0]!]).toEqual([0]);
  });
});
