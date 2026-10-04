import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeDgc, goldenToEncoderDag, b64ToBytes, type GoldenJson } from "./dgcEncoder.testUtils.js";
import { crc32c, decodeDgc, DGC_NO_PARENT, DgcFormatError, parseDgcHeader, type DgcDag } from "./dgcLoader.js";
import { buildMeshletDag, type MeshletDag } from "./meshletDag.js";
import type { IndexedTriangleGeometry } from "./types.js";

// 黄金 fixture(Rust 工具链与 TS 权威实现的共享对拍数据,sha 由仓库钉版):
// packages/deep-engine/src/geometry → packages/deep-engine-native/geometry_dag/tests/fixtures。
const FIXTURES = new URL("../../../deep-engine-native/geometry_dag/tests/fixtures/", import.meta.url);
const loadGolden = (name: string): GoldenJson =>
  JSON.parse(readFileSync(new URL(`${name}.golden.json`, FIXTURES), "utf8")) as GoldenJson;

// Rust CLI 产物(离线工具链端到端工件;test-output 不入库,按 sha256 钉版防漂移):
// 重生成:cargo run --release --bin geometry_dag -- build tests/fixtures/synthetic50k.obj out.dgc
const ARTIFACT_SHA256 = "dd098ae43f4abb7032a14b2d2b018fe19f541c5b136afa96b8714b77b3bf1f86";
const ARTIFACT_URLS = [
  new URL("../../../deep-engine-native/geometry_dag/test-output/synthetic50k.dgc", import.meta.url),
  new URL("../../../deep-engine/test-output/synthetic50k.dgc", import.meta.url),
];

const bytesOf = (view: ArrayBufferView): Uint8Array => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/** 逐位相等(长度不等或首差异字节即失败),typed array 与 golden LE 字节直接对拍。 */
function expectBytesEqual(actual: ArrayBufferView, expected: Uint8Array, label: string): void {
  const a = bytesOf(actual);
  if (a.length !== expected.length) expect.fail(`${label}: byte length ${a.length} != ${expected.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== expected[i]) expect.fail(`${label}: first difference at byte ${i} (${a[i]} != ${expected[i]})`);
  }
}

/**
 * f32 槽逐值对拍(±0 宽容,`===` 语义已把 0 与 -0 视为相等):
 * 仅用于 Rust 工件路径 —— gen_fixture 写 OBJ 时 `(-0).toPrecision(9)` 丢失负号,
 * Rust 解析回 +0(数值恒等,位型差一个符号位);任何非零值差异即失败。
 */
function expectF32BitsEqual(actual: Float32Array<ArrayBuffer>, expected: Uint8Array | Float32Array<ArrayBuffer>, label: string): void {
  if (actual.length * 4 !== expected.byteLength) expect.fail(`${label}: byte length ${actual.length * 4} != ${expected.byteLength}`);
  const g = expected instanceof Float32Array ? expected : new Float32Array(expected.buffer, expected.byteOffset, expected.length / 4);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === g[i]) continue;
    expect.fail(`${label}: first value difference at element ${i} (${actual[i]} != ${g[i]}, bits ${hex32(actual[i]!)}/${hex32(g[i]!)})`);
  }
}
const hex32 = (value: number): string => `0x${(new Uint32Array(new Float32Array([value]).buffer)[0]!).toString(16).padStart(8, "0")}`;

/** 解码产物单层 vs golden 单层:level/error 逐值 + u32 槽逐位 + f32 槽逐值(±0 等价,见 expectF32BitsEqual)。 */
function assertLevelMatchesGolden(decoded: DgcDag["levels"][number], golden: GoldenJson["levels"][number], label: string): void {
  expect(decoded.level, `${label} level`).toBe(golden.level);
  expect(decoded.error, `${label} error`).toBe(golden.error);
  expect(decoded.meshletCount, `${label} meshletCount`).toBe(b64ToBytes(golden.clusterSourceSpansB64).length / 8);
  const bytesOf = (key: keyof GoldenJson["levels"][number]) => b64ToBytes(golden[key] as string);
  expectF32BitsEqual(decoded.positions, bytesOf("positionsB64"), `${label} positions`);
  expectBytesEqual(decoded.indices, bytesOf("indicesB64"), `${label} indices`);
  expectBytesEqual(decoded.descriptors, bytesOf("descriptorsB64"), `${label} descriptors`);
  expectBytesEqual(decoded.vertexRemap, bytesOf("vertexRemapB64"), `${label} vertexRemap`);
  expectBytesEqual(decoded.localTriangleIndices, bytesOf("localTriangleIndicesB64"), `${label} localTriangleIndices`);
  expectF32BitsEqual(decoded.bounds, bytesOf("boundsB64"), `${label} bounds(16 f32)`);
  expectBytesEqual(decoded.sourceTriangles, bytesOf("sourceTrianglesB64"), `${label} sourceTriangles`);
  expectBytesEqual(decoded.clusterSourceSpans, bytesOf("clusterSourceSpansB64"), `${label} clusterSourceSpans`);
}

/** 解码产物 parentsByLevel vs golden(0xFFFFFFFF 哨兵两侧同值,逐元素对拍)。 */
function assertParentsMatchGolden(decoded: DgcDag, golden: GoldenJson, label: string): void {
  expect(decoded.parentsByLevel.length, `${label} parent pair count`).toBe(golden.parentsByLevel.length);
  golden.parentsByLevel.forEach((row, k) => {
    const parents = decoded.parentsByLevel[k]!;
    expect(parents.length, `${label} parents ${k} length`).toBe(row.length);
    for (let c = 0; c < row.length; c++) expect(parents[c], `${label} parents ${k} cluster ${c}`).toBe(row[c]!);
    const sentinels = row.filter((v) => v === DGC_NO_PARENT).length;
    const decodedSentinels = Array.from(parents).filter((v) => v === DGC_NO_PARENT).length;
    expect(decodedSentinels, `${label} parents ${k} sentinel count`).toBe(sentinels);
    if (k === 0 && sentinels > 0) expect(sentinels, `${label} 无父哨兵必须真实存在`).toBeGreaterThan(0);
  });
}

/** 同构断言:解码产物 vs TS buildMeshletDag 输出(共享字段逐值/逐位一致,消费面零换算)。 */
function assertIsomorphicWithTsBuild(decoded: DgcDag, ts: MeshletDag, label: string): void {
  expect(decoded.levels.length, `${label} level count`).toBe(ts.levels.length);
  expect(decoded.parentsByLevel.length, `${label} parent pair count`).toBe(ts.parentsByLevel.length);
  decoded.levels.forEach((level, k) => {
    const tsLevel = ts.levels[k]!;
    expect(level.level, `${label} L${k} level`).toBe(tsLevel.level);
    expect(level.error, `${label} L${k} error(f64)`).toBe(tsLevel.error);
    expect(level.meshletCount, `${label} L${k} meshletCount`).toBe(tsLevel.meshletCount);
    expectF32BitsEqual(level.positions, tsLevel.positions, `${label} L${k} positions`);
    expectBytesEqual(level.indices, bytesOf(tsLevel.indices), `${label} L${k} indices`);
    expectBytesEqual(level.descriptors, bytesOf(tsLevel.descriptors), `${label} L${k} descriptors`);
    expectBytesEqual(level.vertexRemap, bytesOf(tsLevel.vertexRemap), `${label} L${k} vertexRemap`);
    expectBytesEqual(level.localTriangleIndices, bytesOf(tsLevel.localTriangleIndices), `${label} L${k} localTriangleIndices`);
    expectF32BitsEqual(level.bounds, tsLevel.bounds, `${label} L${k} bounds`);
    expectBytesEqual(level.sourceTriangles, bytesOf(tsLevel.sourceTriangles), `${label} L${k} sourceTriangles`);
    expectBytesEqual(level.clusterSourceSpans, bytesOf(tsLevel.clusterSourceSpans), `${label} L${k} clusterSourceSpans`);
  });
  decoded.parentsByLevel.forEach((parents, k) => {
    expectBytesEqual(parents, bytesOf(ts.parentsByLevel[k]!), `${label} parents ${k}`);
  });
}

const goldenGeometry = (json: GoldenJson): IndexedTriangleGeometry => {
  const positions = new Float32Array(b64ToBytes(json.input.positionsB64).buffer);
  const indices = new Uint32Array(b64ToBytes(json.input.indicesB64).buffer);
  return { positions, indices };
};

describe("dgcLoader", () => {
  it("crc32c 与 iSCSI 标准测试向量一致", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
  });

  for (const name of ["quick_sphere", "synthetic50k"] as const) {
    for (const compress of [true, false]) {
      it(`golden ${name} 解码逐位对拍(zlib ${compress ? "开" : "关"})`, () => {
        const json = loadGolden(name);
        const encoded = new Uint8Array(encodeDgc(goldenToEncoderDag(json), { compress }));
        const header = parseDgcHeader(encoded);
        expect(header.compressed).toBe(compress);
        expect(header.levelCount).toBe(json.levels.length);
        expect(header.parentPairCount).toBe(json.parentsByLevel.length);
        expect(header.sourceVertexCount).toBe(json.input.vertexCount);
        expect(header.sourceTriangleCount).toBe(json.input.triangleCount);
        expect(header.maxVertices).toBe(64);
        expect(header.maxTriangles).toBe(json.options.maxTriangles);
        expect(header.totalFileSize).toBe(encoded.byteLength);
        const dag = decodeDgc(encoded);
        json.levels.forEach((goldenLevel, k) => assertLevelMatchesGolden(dag.levels[k]!, goldenLevel, `${name} L${k}`));
        assertParentsMatchGolden(dag, json, name);
      });
    }
  }

  // 核心验收:同一源网格上,Rust 工具链序列化格式(由测试编码器按 dgc.rs 写路径产出)
  // 的解码结果与 TS buildMeshletDag 输出同构 —— 8 个数组槽逐位、error 逐值、parents 逐元素。
  for (const name of ["quick_sphere", "synthetic50k"] as const) {
    it(`解码结果与 buildMeshletDag 同构(${name})`, () => {
      const json = loadGolden(name);
      const dag = decodeDgc(encodeDgc(goldenToEncoderDag(json)));
      const ts = buildMeshletDag(goldenGeometry(json), { levels: json.options.levels });
      assertIsomorphicWithTsBuild(dag, ts, name);
    });
  }

  it("Rust 工具链产物 synthetic50k.dgc(sha256 钉版)跨工具链对拍", (ctx) => {
    const artifact = ARTIFACT_URLS.find((url) => existsSync(fileURLToPath(url)));
    if (!artifact) {
      ctx.skip(true, "缺 synthetic50k.dgc 工件:cd packages/deep-engine-native/geometry_dag && cargo run --release --bin geometry_dag -- build tests/fixtures/synthetic50k.obj <out>.dgc");
      return;
    }
    const bytes = readFileSync(artifact);
    expect(createHash("sha256").update(bytes).digest("hex"), "sha256 钉版不符(工具链输出漂移?)").toBe(ARTIFACT_SHA256);
    const json = loadGolden("synthetic50k");
    const dag = decodeDgc(bytes);
    json.levels.forEach((goldenLevel, k) => assertLevelMatchesGolden(dag.levels[k]!, goldenLevel, `artifact L${k}`, true));
    assertParentsMatchGolden(dag, json, "artifact");
    assertIsomorphicWithTsBuild(dag, buildMeshletDag(goldenGeometry(json), { levels: json.options.levels }), "artifact vs ts");
  });

  it("非 8 对齐的输入视图走拷贝回退,解码结果不变", () => {
    const encoded = new Uint8Array(encodeDgc(goldenToEncoderDag(loadGolden("quick_sphere"))));
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded, 1);
    const misaligned = new Uint8Array(padded.buffer, 1, encoded.length);
    const dag = decodeDgc(misaligned);
    expectBytesEqual(dag.levels[0]!.positions, bytesOf(decodeDgc(encoded).levels[0]!.positions), "misaligned copy path");
  });

  describe("fail-closed 矩阵(全部显式 DgcFormatError,信息含偏移)", () => {
    const quick = () => new Uint8Array(encodeDgc(goldenToEncoderDag(loadGolden("quick_sphere"))));
    const raw = () => new Uint8Array(encodeDgc(goldenToEncoderDag(loadGolden("quick_sphere")), { compress: false }));
    const dv = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expectFormatError = (mutate: (bytes: Uint8Array) => void, fragment: string, source: () => Uint8Array = quick) => {
      const bytes = source();
      mutate(bytes);
      expect(() => decodeDgc(bytes)).toThrow(DgcFormatError);
      expect(() => decodeDgc(bytes)).toThrow(fragment);
    };
    const sectionBase = (index: number) => 64 + 88 * index;

    it("坏魔数", () => expectFormatError((b) => { b[0] = 0x58; }, "bad magic"));
    it("未知版本", () => expectFormatError((b) => { dv(b).setUint32(4, 2, true); }, "unsupported version 2"));
    it("未知 flags 位", () => expectFormatError((b) => { dv(b).setUint32(8, 0x2, true); }, "unknown flags"));
    it("零层数", () => expectFormatError((b) => { dv(b).setUint32(0x0c, 0, true); }, "zero level count"));
    it("parents 层对数与层数不一致", () => expectFormatError((b) => { dv(b).setUint32(0x10, 2, true); }, "parent pairs 2"));
    it("簇上限超 schema", () => expectFormatError((b) => { dv(b).setUint32(0x1c, 65, true); }, "cluster limits exceed schema caps"));
    it("文件头保留字段非零(offset 44)", () => expectFormatError((b) => { b[0x30] = 1; }, "header reserved bytes must be zero"));
    it("total_file_size 尺寸锁不匹配(offset 36)", () => expectFormatError((b) => { dv(b).setBigUint64(0x24, BigInt(b.length + 1), true); }, "size lock mismatch"));
    it("头部截断(<64B)", () => expectFormatError(() => undefined, "truncated: file is", () => quick().slice(0, 32)));
    it("段头区截断", () => expectFormatError(() => undefined, "bytes < header span", () => {
      const bytes = quick().slice(0, 200); // quick_sphere 仅 3 段,header span = 64 + 88×3 = 328
      dv(bytes).setBigUint64(0x24, BigInt(bytes.length), true); // 尺寸锁自洽,只留段头区截断一处错误
      return bytes;
    }));
    it("段保留字段非零", () => expectFormatError((b) => { b[sectionBase(0) + 0x4c] = 1; }, "section 0 reserved bytes"));
    it("未知段类型", () => expectFormatError((b) => { dv(b).setUint32(sectionBase(0), 7, true); }, "unknown section kind 7"));
    it("payload 偏移非 8 对齐", () => {
      const bytes = quick();
      const view = dv(bytes);
      const offset = Number(view.getBigUint64(sectionBase(0) + 0x40, true));
      view.setBigUint64(sectionBase(0) + 0x40, BigInt(offset + 1), true);
      expect(() => decodeDgc(bytes)).toThrow(DgcFormatError);
      expect(() => decodeDgc(bytes)).toThrow("not 8-byte aligned");
    });
    it("payload 越出文件尾", () => expectFormatError((b) => { dv(b).setBigUint64(sectionBase(0) + 0x38, BigInt(dv(b).getBigUint64(sectionBase(0) + 0x38, true)) + 1_000_000n, true); }, "exceeds file size"));
    it("未压缩段 stored≠raw", () => expectFormatError((b) => { dv(b).setBigUint64(sectionBase(0) + 0x38, BigInt(dv(b).getBigUint64(sectionBase(0) + 0x38, true)) + 4n, true); }, "uncompressed stored size", raw));
    it("CRC32C 不匹配(单字节翻转)", () => expectFormatError((b) => { const at = Number(dv(b).getBigUint64(sectionBase(0) + 0x40, true)); b[at] ^= 0xff; }, "crc mismatch", raw));
    it("zlib 流截断 → 解码失败", () => expectFormatError((b) => {
      const base = sectionBase(0);
      const storedSize = Number(dv(b).getBigUint64(base + 0x38, true));
      dv(b).setBigUint64(base + 0x38, BigInt(storedSize - 2), true); // 声称的 stored 缩短 2 字节 → 流被截断
    }, "zlib decode failed"));
    it("zlib 静默损坏(fflate 不校验 adler)由 raw CRC32C 兜底(构造式)", () => {
      const json = loadGolden("quick_sphere");
      const good = new Uint8Array(encodeDgc(goldenToEncoderDag(json)));
      const tampered = goldenToEncoderDag(json);
      tampered.levels[0]!.positions[0] ^= 0xff; // payload 改一字节,CRC 域沿用旧值
      const bad = new Uint8Array(encodeDgc(tampered));
      const crcOf = (bytes: Uint8Array) => dv(bytes).getUint32(64 + 0x48, true);
      dv(bad).setUint32(64 + 0x48, crcOf(good), true);
      expect(() => decodeDgc(bad)).toThrow(DgcFormatError);
      expect(() => decodeDgc(bad)).toThrow("crc mismatch");
    });
    it("解压尺寸 ≠ raw_size(炸弹锁定)", () => expectFormatError((b) => {
      const base = sectionBase(0);
      dv(b).setUint32(base + 0x2c, dv(b).getUint32(base + 0x2c, true) - 1, true); // counts[7]-1,使 counts 谎言与 raw_size 自洽
      dv(b).setBigUint64(base + 0x30, dv(b).getBigUint64(base + 0x30, true) - 4n, true);
    }, "zlib payload size"));
    it("counts 蕴含字节数与 raw_size 不一致", () => expectFormatError((b) => { dv(b).setBigUint64(sectionBase(0) + 0x30, BigInt(dv(b).getBigUint64(sectionBase(0) + 0x30, true)) + 4n, true); }, "counts imply", raw));
    it("level 段乱序", () => expectFormatError((b) => {
      dv(b).setUint32(sectionBase(0) + 4, 1, true);
      dv(b).setUint32(sectionBase(1) + 4, 0, true);
    }, "level sections must appear in order"));
    it("parents 段先于 level 段(段序合同)", () => expectFormatError((b) => { dv(b).setUint32(sectionBase(0), 1, true); }, "order contract violated"));
    it("parents 条数 ≠ 细层簇数(构造式:CRC 自洽)", () => {
      const dag = goldenToEncoderDag(loadGolden("quick_sphere"));
      const padded = new Uint32Array(dag.parentsByLevel[0]!.length + 1);
      padded.set(dag.parentsByLevel[0]!);
      const bytes = new Uint8Array(encodeDgc({ ...dag, parentsByLevel: [padded, ...dag.parentsByLevel.slice(1)] }));
      expect(() => decodeDgc(bytes)).toThrow(DgcFormatError);
      expect(() => decodeDgc(bytes)).toThrow("entries, fine level has");
    });
    it("父索引越界(构造式:CRC 自洽)", () => {
      const dag = goldenToEncoderDag(loadGolden("quick_sphere"));
      const bad = dag.parentsByLevel[0]!.slice();
      bad[0] = 999_999;
      const bytes = new Uint8Array(encodeDgc({ ...dag, parentsByLevel: [bad, ...dag.parentsByLevel.slice(1)] }));
      expect(() => decodeDgc(bytes)).toThrow(DgcFormatError);
      expect(() => decodeDgc(bytes)).toThrow("parent 999999 out of range");
    });
    it("level 0 尺寸与文件头 source counts 不一致", () => expectFormatError((b) => { dv(b).setUint32(0x14, dv(b).getUint32(0x14, true) + 1, true); }, "level 0 geometry size disagrees"));
  });
});
