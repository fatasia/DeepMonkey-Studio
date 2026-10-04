import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeDgc, goldenToEncoderDag, b64ToBytes, type DgcEncoderDag, type GoldenJson } from "./dgcEncoder.testUtils.js";
import { DGC_NO_PARENT, DgcFormatError, decodeDgc, type DgcDag } from "./dgcLoader.js";
import { dgcDagToMeshletDag } from "./dgcDagBridge.js";
import { buildMeshletDag, type MeshletDag } from "./meshletDag.js";
import type { IndexedTriangleGeometry } from "./types.js";
import { compileVirtualGeometryDagPages, compileVirtualGeometryDagPagesFromDgc, type VirtualGeometryDagPageTable } from "../virtualGeometryDagPages.js";

// 黄金 fixture 与 Rust 工件路径合同同 dgcLoader.test(shares 对拍数据,sha 钉版)。
const FIXTURES = new URL("../../../deep-engine-native/geometry_dag/tests/fixtures/", import.meta.url);
const loadGolden = (name: string): GoldenJson =>
  JSON.parse(readFileSync(new URL(`${name}.golden.json`, FIXTURES), "utf8")) as GoldenJson;
const ARTIFACT_SHA256 = "dd098ae43f4abb7032a14b2d2b018fe19f541c5b136afa96b8714b77b3bf1f86";
const ARTIFACT_URLS = [
  new URL("../../../deep-engine-native/geometry_dag/test-output/synthetic50k.dgc", import.meta.url),
  new URL("../../../deep-engine/test-output/synthetic50k.dgc", import.meta.url),
];

const bytesOf = (view: ArrayBufferView): Uint8Array => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
const goldenGeometry = (json: GoldenJson): IndexedTriangleGeometry => ({
  positions: new Float32Array(b64ToBytes(json.input.positionsB64).buffer),
  indices: new Uint32Array(b64ToBytes(json.input.indicesB64).buffer),
});

/** TS 构建 MeshletDag → 编码器 DAG(8 数组槽逐字节回填,用于 F2 孤儿哨兵构造式覆盖)。 */
function tsDagToEncoderDag(ts: MeshletDag, maxTriangles: number): DgcEncoderDag {
  return {
    sourceVertexCount: ts.levels[0]!.positions.length / 3,
    sourceTriangleCount: ts.levels[0]!.indices.length / 3,
    maxVertices: 64, maxTriangles,
    levels: ts.levels.map((level) => ({
      level: level.level, error: level.error,
      positions: bytesOf(level.positions), indices: bytesOf(level.indices),
      descriptors: bytesOf(level.descriptors), vertexRemap: bytesOf(level.vertexRemap),
      localTriangleIndices: bytesOf(level.localTriangleIndices), bounds: bytesOf(level.bounds),
      sourceTriangles: bytesOf(level.sourceTriangles), clusterSourceSpans: bytesOf(level.clusterSourceSpans),
    })),
    parentsByLevel: ts.parentsByLevel as unknown as readonly Uint32Array[],
  };
}

/** 两条编译路径页表逐值对拍:页序(level 升序、层内簇序)确定性,按下标一一对照。 */
function assertTablesEqual(actual: VirtualGeometryDagPageTable, expected: VirtualGeometryDagPageTable, label: string): void {
  expect(actual.pages.length, `${label} page count`).toBe(expected.pages.length);
  actual.pages.forEach((page, i) => {
    const other = expected.pages[i]!;
    expect(page.id, `${label} page ${i} id`).toBe(other.id);
    expect(page.level, `${label} ${page.id} level`).toBe(other.level);
    expect(page.cluster, `${label} ${page.id} cluster`).toBe(other.cluster);
    expect(page.error, `${label} ${page.id} error`).toBe(other.error);
    expect(page.triangleCount, `${label} ${page.id} triangleCount`).toBe(other.triangleCount);
    expect(page.byteLength, `${label} ${page.id} byteLength`).toBe(other.byteLength);
    expect([...page.sphere], `${label} ${page.id} sphere`).toEqual([...other.sphere]);
    expect(page.firstIndex, `${label} ${page.id} firstIndex`).toBe(other.firstIndex);
    expect(page.parentId, `${label} ${page.id} parentId`).toBe(other.parentId);
    expect([...page.childIds], `${label} ${page.id} childIds`).toEqual([...other.childIds]);
  });
  expect([...actual.rootIds], `${label} rootIds`).toEqual([...expected.rootIds]);
  expect(actual.levels, `${label} levels`).toBe(expected.levels);
  expect(actual.totalTriangles, `${label} totalTriangles`).toBe(expected.totalTriangles);
  expect(actual.totalBytes, `${label} totalBytes`).toBe(expected.totalBytes);
  expect(actual.byId.size, `${label} byId size`).toBe(expected.byId.size);
}

const compileTsPath = (json: GoldenJson, name: string): VirtualGeometryDagPageTable =>
  compileVirtualGeometryDagPages(buildMeshletDag(goldenGeometry(json), { levels: json.options.levels }), name);
const compileDgcPath = (bytes: Uint8Array, name: string, revision?: number): VirtualGeometryDagPageTable =>
  revision === undefined ? compileVirtualGeometryDagPagesFromDgc(bytes, name)
    : compileVirtualGeometryDagPagesFromDgc(bytes, name, revision);

describe("dgcDagBridge", () => {
  it("桥产物与 buildMeshletDag 结构完全一致(levels/parents 透传 + 空占位;附加 maxVertices/maxTriangles 为解码档案字段)", () => {
    const json = loadGolden("quick_sphere");
    const bridged = dgcDagToMeshletDag(decodeGolden(json));
    const ts = buildMeshletDag(goldenGeometry(json), { levels: json.options.levels });
    expect(bridged.levels.length).toBe(ts.levels.length);
    bridged.levels.forEach((level, k) => {
      const tsLevel = ts.levels[k]!;
      expect(level.level, `L${k} level`).toBe(tsLevel.level);
      expect(level.error, `L${k} error`).toBe(tsLevel.error);
      expect(level.meshletCount, `L${k} meshletCount`).toBe(tsLevel.meshletCount);
      expect(level.positions, `L${k} positions`).toEqual(tsLevel.positions);
      expect(level.indices, `L${k} indices`).toEqual(tsLevel.indices);
      expect(level.descriptors, `L${k} descriptors`).toEqual(tsLevel.descriptors);
      expect(level.vertexRemap, `L${k} vertexRemap`).toEqual(tsLevel.vertexRemap);
      expect(level.localTriangleIndices, `L${k} localTriangleIndices`).toEqual(tsLevel.localTriangleIndices);
      expect(level.bounds, `L${k} bounds`).toEqual(tsLevel.bounds);
      expect(level.sourceTriangles, `L${k} sourceTriangles`).toEqual(tsLevel.sourceTriangles);
      expect(level.clusterSourceSpans, `L${k} clusterSourceSpans`).toEqual(tsLevel.clusterSourceSpans);
    });
    expect(bridged.parentsByLevel).toEqual(ts.parentsByLevel);
    expect(bridged.childrenSpans).toEqual(new Uint32Array(0));
    expect(bridged.children).toEqual(new Uint32Array(0));
    expect(Object.isFrozen(bridged)).toBe(true);
  });

  it("桥 fail-closed:空层 / parents 层对数不符 / 条数与细层簇数不符 均抛 DgcFormatError", () => {
    const json = loadGolden("quick_sphere");
    const decoded = decodeGolden(json);
    expect(() => dgcDagToMeshletDag({ levels: [], parentsByLevel: [] })).toThrow(DgcFormatError);
    expect(() => dgcDagToMeshletDag({ levels: decoded.levels, parentsByLevel: [] })).toThrow(/parent tables for/);
    const truncated = { levels: decoded.levels, parentsByLevel: [decoded.parentsByLevel[0]!.slice(0, 2)] };
    expect(() => dgcDagToMeshletDag(truncated)).toThrow(/entries, fine level has/);
  });

  for (const name of ["quick_sphere", "synthetic50k"] as const) {
    for (const compress of [true, false]) {
      it(`端到端对拍 golden ${name}(zlib ${compress ? "开" : "关"}):.dgc→bridge→compile 与 TS build→compile 页逐值一致`, () => {
        const json = loadGolden(name);
        const bytes = new Uint8Array(encodeDgc(goldenToEncoderDag(json), { compress }));
        assertTablesEqual(compileDgcPath(bytes, name), compileTsPath(json, name), `${name} zlib=${compress}`);
      });
    }
  }

  it("端到端 revision 透传与页身份复原", () => {
    const json = loadGolden("quick_sphere");
    const bytes = new Uint8Array(encodeDgc(goldenToEncoderDag(json)));
    const table = compileDgcPath(bytes, "rev-fixture", 7);
    expect(table.revision).toBe(7);
    expect(table.pages[0]!.id).toBe(`rev-fixture|l0|c0`);
  });

  it("F2 孤儿根语义经 .dgc 路径零漂移:哨兵计数、孤儿页与 TS 路径一致且全部入根集", () => {
    for (const name of ["quick_sphere", "synthetic50k"] as const) {
      const json = loadGolden(name);
      const sentinels = json.parentsByLevel.reduce((sum, row) => sum + row.filter((v) => v === DGC_NO_PARENT).length, 0);
      const bytes = new Uint8Array(encodeDgc(goldenToEncoderDag(json)));
      const dgcTable = compileDgcPath(bytes, name);
      const orphans = dgcTable.pages.filter((page) => page.level + 1 < dgcTable.levels && page.parentId === null);
      expect(orphans.length, `${name} orphan count`).toBe(sentinels);
      const tsTable = compileTsPath(json, name);
      expect(compileTsPathOrphanCount(tsTable)).toBe(sentinels);
      for (const orphan of orphans) expect(dgcTable.rootIds, `${name} orphan ${orphan.id} in roots`).toContain(orphan.id);
    }
  });

  it("TS 构建(64×32 夹具含 M2 哨兵)→ .dgc 字节 → FromDgc:孤儿语义与页输出零漂移", () => {
    const ts = buildMeshletDag(sphereGeometry(64, 32), { levels: 3 });
    const sentinels = (ts.parentsByLevel as unknown as readonly Uint32Array[])
      .reduce((sum, row) => sum + Array.from(row).filter((v) => v === 4294967295).length, 0);
    expect(sentinels, "fixture 必须真实携带孤儿哨兵").toBeGreaterThan(0);
    const bytes = new Uint8Array(encodeDgc(tsDagToEncoderDag(ts, 64)));
    const dgcTable = compileDgcPath(bytes, "orphan-roundtrip");
    assertTablesEqual(dgcTable, compileVirtualGeometryDagPages(ts, "orphan-roundtrip"), "orphan-roundtrip");
    const orphans = dgcTable.pages.filter((page) => page.level + 1 < dgcTable.levels && page.parentId === null);
    expect(orphans.length).toBe(sentinels);
    for (const orphan of orphans) expect(dgcTable.rootIds).toContain(orphan.id);
  });

  it("Rust 工具链产物 synthetic50k.dgc(sha256 钉版)端到端对拍", (ctx) => {
    const artifact = ARTIFACT_URLS.find((url) => existsSync(fileURLToPath(url)));
    if (!artifact) {
      ctx.skip(true, "缺 synthetic50k.dgc 工件:cd packages/deep-engine-native/geometry_dag && cargo run --release --bin geometry_dag -- build tests/fixtures/synthetic50k.obj <out>.dgc");
      return;
    }
    const bytes = new Uint8Array(readFileSync(artifact));
    expect(createHash("sha256").update(bytes).digest("hex"), "sha256 钉版不符").toBe(ARTIFACT_SHA256);
    const json = loadGolden("synthetic50k");
    assertTablesEqual(compileDgcPath(bytes, "synthetic50k-artifact"), compileTsPath(json, "synthetic50k-artifact"), "artifact");
  });

  describe("损坏字节 fail-closed 传递(DgcFormatError 穿透 FromDgc 不被吞)", () => {
    const quick = () => new Uint8Array(encodeDgc(goldenToEncoderDag(loadGolden("quick_sphere"))));
    const raw = () => new Uint8Array(encodeDgc(goldenToEncoderDag(loadGolden("quick_sphere")), { compress: false }));
    const dv = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expectFormatError = (mutate: (bytes: Uint8Array) => void, fragment: string, source: () => Uint8Array = quick) => {
      const bytes = source();
      mutate(bytes);
      expect(() => compileDgcPath(bytes, "corrupt")).toThrow(DgcFormatError);
      expect(() => compileDgcPath(bytes, "corrupt")).toThrow(fragment);
    };
    it("坏魔数", () => expectFormatError((b) => { b[0] = 0x58; }, "bad magic"));
    it("头部截断", () => expectFormatError(() => undefined, "truncated: file is", () => quick().slice(0, 32)));
    it("payload 单字节翻转 + CRC 沿用旧值 → crc mismatch", () => expectFormatError((b) => {
      const at = Number(dv(b).getBigUint64(64 + 0x40, true));
      b[at] ^= 0xff;
    }, "crc mismatch", raw));
  });
});

/** 纯 TS 路径的孤儿计数(F2 语义对照基准)。 */
function compileTsPathOrphanCount(table: VirtualGeometryDagPageTable): number {
  return table.pages.filter((page) => page.level + 1 < table.levels && page.parentId === null).length;
}

/** golden JSON → DgcDag(复用测试编码器走真实字节路径)。 */
const decodeGolden = (json: GoldenJson): DgcDag => decodeDgc(encodeDgc(goldenToEncoderDag(json)));

/** 确定性球面网格(经纬细分,与 virtualGeometryDagPages.test 同构造)。 */
function sphereGeometry(segments = 48, rings = 24): IndexedTriangleGeometry {
  const positions: number[] = [], indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s, b = a + 1, c = a + row, d = c + 1;
      if (r > 0) indices.push(a, c, b);
      if (r < rings - 1) indices.push(b, c, d);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
