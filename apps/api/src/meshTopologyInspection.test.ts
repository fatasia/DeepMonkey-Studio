import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MESH_TOPOLOGY_ISSUE_DICTIONARY,
  inspectGlbTopology,
  inspectMeshTopologies,
  inspectPrimitiveTopology,
  type MeshPrimitiveTopologyInput,
} from "./meshTopologyInspection.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function tetrahedron(primitiveId = "tet", scale = 1): MeshPrimitiveTopologyInput {
  const s = scale;
  return {
    primitiveId,
    positions: Float32Array.from([0, 0, 0, s, 0, 0, 0, s, 0, 0, 0, s]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  };
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((entry) => entry.code);
}

function firstIssue(
  report: { issues: Array<{ code: string; count: number; samples: string[] }> },
  code: string,
): { count: number; samples: string[] } {
  const found = report.issues.find((entry) => entry.code === code);
  expect(found, `缺少 issue ${code},实际:${codes(report.issues).join(",")}`).toBeDefined();
  return found!;
}

describe("T12 拓扑检查 issue 字典", () => {
  it("每个码都有唯一严重级、含义与定位符格式", () => {
    const entries = Object.entries(MESH_TOPOLOGY_ISSUE_DICTIONARY);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    for (const [code, descriptor] of entries) {
      expect(["error", "warning", "info"], code).toContain(descriptor.severity);
      expect(descriptor.meaning.length, code).toBeGreaterThan(4);
      expect(descriptor.locator, code).toContain("<");
    }
  });
});

describe("T12 拓扑检查:合成异常样本矩阵(只检测不修补,无崩溃)", () => {
  it("干净封闭四面体:ok=true 且零 issue", async () => {
    const report = await inspectPrimitiveTopology(tetrahedron());
    expect(report).toHaveLength(0);
  });

  it("非流形边:三条三角形共享一条边 → NON_MANIFOLD_EDGE,定位到边与入射数", async () => {
    const primitive: MeshPrimitiveTopologyInput = {
      primitiveId: "nonmanifold",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 1, 4]),
    };
    const report = await inspectMeshTopologies({ primitives: [primitive] });
    const nonManifold = firstIssue(report, "NON_MANIFOLD_EDGE");
    expect(nonManifold.count).toBe(1);
    expect(nonManifold.samples[0]).toMatch(/edge:0_1 incident:3/);
    expect(report.ok).toBe(false);
    expect(report.issueCountsByCode.NON_MANIFOLD_EDGE).toBe(1);
  });

  it("退化三角形:零面积与重复索引 → DEGENERATE_TRIANGLE 且 reason 区分", async () => {
    const primitive: MeshPrimitiveTopologyInput = {
      primitiveId: "degenerate",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 0, 1, 0, 1, 4]),
    };
    const issues = await inspectPrimitiveTopology(primitive);
    const degenerate = issues.find((entry) => entry.code === "DEGENERATE_TRIANGLE");
    expect(degenerate).toBeDefined();
    expect(degenerate!.count).toBe(2);
    expect(degenerate!.samples).toContain("triangle:0 reason:zero-area");
    expect(degenerate!.samples).toContain("triangle:1 reason:repeated-index");
  });

  it("孤立顶点与重复三角形 → ISOLATED_VERTEX / DUPLICATE_TRIANGLE", async () => {
    const primitive: MeshPrimitiveTopologyInput = {
      primitiveId: "isolated",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 2]),
    };
    const report = await inspectMeshTopologies({ primitives: [primitive] });
    const isolated = firstIssue(report, "ISOLATED_VERTEX");
    expect(isolated.samples).toContain("vertex:3");
    const duplicate = firstIssue(report, "DUPLICATE_TRIANGLE");
    expect(duplicate.count).toBe(1);
    expect(report.ok).toBe(true);
  });

  it("开放壳:单三角形 → OPEN_EDGE 仅 info,不判失败", async () => {
    const primitive: MeshPrimitiveTopologyInput = {
      primitiveId: "open",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
    };
    const report = await inspectMeshTopologies({ primitives: [primitive] });
    const openEdge = firstIssue(report, "OPEN_EDGE");
    expect(openEdge.count).toBe(3);
    const severity = Object.fromEntries(report.issues.map((entry) => [entry.code, entry.severity]));
    expect(severity.OPEN_EDGE).toBe("info");
    expect(report.ok).toBe(true);
  });

  it("整体翻转法线判 error,局部翻转判 warning", async () => {
    // 四个独立面,每面顶点专用;法线给成外法线的相反数 → 全部翻转。
    const positions = Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // 面1:外法线 (0,0,1)
      0, 0, 0, 0, 1, 0, 0, 0, 1, // 面2:外法线 (1,0,0)
      0, 0, 0, 0, 0, 1, 1, 0, 0, // 面3:外法线 (0,1,0)
      1, 0, 0, 0, 1, 0, 0, 0, 1, // 面4:外法线 (1,1,1)/√3
    ]);
    const indices = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const inward = (face: number): number[] => {
      const outward: number[][] = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]];
      const [x, y, z] = outward[face]!;
      return [-x, -y, -z, -x, -y, -z, -x, -y, -z];
    };
    const outwardNormals = (face: number): number[] => {
      const [x, y, z] = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]][face]!;
      return [x, y, z, x, y, z, x, y, z];
    };
    const allFlippedNormals = Float32Array.from([...inward(0), ...inward(1), ...inward(2), ...inward(3)]);
    const flippedAll = await inspectPrimitiveTopology({
      primitiveId: "flipped-all", positions, indices, normals: allFlippedNormals });
    const flipped = flippedAll.find((entry) => entry.code === "FLIPPED_NORMAL");
    expect(flipped!.severity).toBe("error");
    expect(flipped!.count).toBe(4);
    expect(flipped!.detail).toContain("flippedRatio:1.0000");

    const oneFlippedNormals = Float32Array.from([...inward(0), ...outwardNormals(1), ...outwardNormals(2), ...outwardNormals(3)]);
    const flippedOne = await inspectPrimitiveTopology({
      primitiveId: "flipped-one", positions, indices, normals: oneFlippedNormals });
    const partial = flippedOne.find((entry) => entry.code === "FLIPPED_NORMAL");
    expect(partial!.severity).toBe("warning");
    expect(partial!.count).toBe(1);
  });

  it("零长法线 → ZERO_LENGTH_NORMAL", async () => {
    const issues = await inspectPrimitiveTopology({
      primitiveId: "zero-normal",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      normals: Float32Array.from([0, 0, 0, 0, 0, 1, 0, 1, 0]),
    });
    const zero = issues.find((entry) => entry.code === "ZERO_LENGTH_NORMAL");
    expect(zero!.count).toBe(1);
    expect(zero!.samples).toContain("vertex:0");
  });

  it("索引越界与空图元:报告 issue 而非抛异常", async () => {
    const outOfRange = await inspectPrimitiveTopology({
      primitiveId: "bad-index",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 7]),
    });
    expect(firstIssue({ issues: outOfRange }, "INDEX_OUT_OF_RANGE").count).toBe(1);
    const empty = await inspectPrimitiveTopology({
      primitiveId: "empty", positions: new Float32Array(0), indices: new Uint32Array(0) });
    expect(firstIssue({ issues: empty }, "EMPTY_PRIMITIVE").count).toBe(1);
  });

  it("畸形 accessor:长度非 3 倍数按 issue 呈现,不崩溃", async () => {
    const malformed = await inspectPrimitiveTopology({
      primitiveId: "malformed",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 1]),
    });
    const codesFound = codes(malformed);
    expect(codesFound).toContain("MALFORMED_ACCESSOR");
  });
});

describe("T12 拓扑检查:GLB 适配器与负缩放", () => {
  it("负缩放节点 → NEGATIVE_SCALE(定位到节点),正常节点不报", async () => {
    const file = await saveGlb(-1, "flipped-node");
    const report = await inspectGlbTopology(file);
    const negative = firstIssue(report, "NEGATIVE_SCALE");
    expect(negative.primitiveId).toBe("node:0");
    expect(negative.samples[0]).toContain("determinant:-1");
    expect(report.ok).toBe(false);
    const clean = await inspectGlbTopology(await saveGlb(1, "clean-node"));
    expect(codes(clean.issues)).not.toContain("NEGATIVE_SCALE");
    expect(clean.ok).toBe(true);
  });

  it("异常样本合成 GLB:共线退化三角形检出,全程无崩溃", async () => {
    const document = new Document();
    const buffer = document.createBuffer();
    const mesh = document.createMesh();
    const degenerate = document.createPrimitive()
      .setAttribute("POSITION", document.createAccessor().setType(Accessor.Type.VEC3).setBuffer(buffer)
        .setArray(Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0])));
    degenerate.setIndices(document.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer)
      .setArray(Uint32Array.from([0, 1, 2, 0, 1, 2])));
    degenerate.setMode(4);
    mesh.addPrimitive(degenerate);
    document.createScene().addChild(document.createNode().setMesh(mesh));
    const file = await saveDocument(document);
    const report = await inspectGlbTopology(file);
    const degenerateIssue = firstIssue(report, "DEGENERATE_TRIANGLE");
    expect(degenerateIssue.count).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.primitiveCount).toBe(1);
    expect(report.triangleCount).toBe(2);
  });

  it("同输入两次检查输出完全一致(确定性)", async () => {
    const primitive = {
      ...tetrahedron("determinism"),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    };
    const first = JSON.stringify(await inspectPrimitiveTopology(primitive));
    const second = JSON.stringify(await inspectPrimitiveTopology(primitive));
    expect(second).toBe(first);
  });
});

async function saveGlb(determinant: number, nodeName: string): Promise<string> {
  const document = new Document();
  const buffer = document.createBuffer();
  const mesh = document.createMesh();
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType(Accessor.Type.VEC3).setBuffer(buffer)
      .setArray(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])));
  primitive.setIndices(document.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer)
    .setArray(Uint32Array.from([0, 1, 2])));
  primitive.setMode(4);
  mesh.addPrimitive(primitive);
  const node = document.createNode(nodeName).setMesh(mesh);
  node.setMatrix([
    determinant, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  document.createScene().addChild(node);
  return saveDocument(document);
}

async function saveDocument(document: Document): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-t12-topology-"));
  directories.push(directory);
  const file = path.join(directory, "geometry.glb");
  await writeFile(file, await new NodeIO().writeBinary(document));
  return file;
}
