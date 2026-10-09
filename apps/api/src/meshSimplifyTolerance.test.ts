import { readFile, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import {
  simplifyGlbWithTolerance,
  simplifyPrimitiveWithTolerance,
  type SimplifiablePrimitive,
} from "./meshSimplifyTolerance.js";

const FACTORY_ZIP = path.resolve(import.meta.dirname, "../../../test-fixtures/kenney-factory/factory.zip");
const FACTORY_GLB_ENTRY = "Models/GLB format/robot-arm-a.glb";

const tempDirectories: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** 高分辨率 icosphere(确定性构造,共享顶点,平滑可简化)。 */
function icosphere(subdivisions = 3): SimplifiablePrimitive {
  const t = (1 + Math.sqrt(5)) / 2;
  const vertices: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  });
  let faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let level = 0; level < subdivisions; level += 1) {
    const midpointCache = new Map<string, number>();
    const nextFaces: Array<[number, number, number]> = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const [ax, ay, az] = vertices[a]!;
      const [bx, by, bz] = vertices[b]!;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      const length = Math.hypot(mx, my, mz);
      vertices.push([mx / length, my / length, mz / length]);
      const index = vertices.length - 1;
      midpointCache.set(key, index);
      return index;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nextFaces;
  }
  const positions = new Float32Array(vertices.length * 3);
  vertices.forEach(([x, y, z], index) => {
    positions[index * 3] = x; positions[index * 3 + 1] = y; positions[index * 3 + 2] = z;
  });
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach(([a, b, c], index) => {
    indices[index * 3] = a; indices[index * 3 + 1] = b; indices[index * 3 + 2] = c;
  });
  return { primitiveId: "icosphere", positions, indices };
}

/** 解压一次 T00 工厂资产(Kenney factory kit,CC0)中的 robot-arm-a.glb 及其同级纹理。 */
let realFilePromise: Promise<string> | null = null;
async function realFile(): Promise<string> {
  realFilePromise ??= (async () => {
    const zip = await JSZip.loadAsync(await readFile(FACTORY_ZIP));
    const entry = zip.file(FACTORY_GLB_ENTRY);
    if (!entry) throw new Error(`factory.zip 缺少 ${FACTORY_GLB_ENTRY}`);
    const temp = await mkdtemp(path.join(tmpdir(), "bim-t12-realglb-"));
    tempDirectories.push(temp);
    await writeFile(path.join(temp, "model.glb"), await entry.async("nodebuffer"));
    // Kenney 包内纹理位于 Models/GLB format/Textures/,GLB 以相对路径 Textures/ 引用,
    // 因此按 GLB 的 URI 视角落盘到 temp/Textures/。
    const texturePrefix = "Models/GLB format/Textures/";
    for (const textureName of Object.keys(zip.files).filter((name) => name.startsWith(texturePrefix))) {
      const textureEntry = zip.file(textureName);
      if (!textureEntry || textureEntry.dir) continue;
      const relative = textureName.slice(texturePrefix.length);
      if (relative.length === 0) continue;
      const destination = path.join(temp, "Textures", ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await textureEntry.async("nodebuffer"));
    }
    return path.join(temp, "model.glb");
  })();
  return realFilePromise;
}

let realIo: NodeIO | null = null;
async function realDocument(file: string) {
  realIo ??= new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return realIo.read(file);
}

async function realExtent(file: string): Promise<number> {
  const document = await realDocument(file);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const array = primitive.getAttribute("POSITION")!.getArray() as Float32Array;
      for (let offset = 0; offset + 2 < array.length; offset += 3) {
        minX = Math.min(minX, array[offset]!); maxX = Math.max(maxX, array[offset]!);
        minY = Math.min(minY, array[offset + 1]!); maxY = Math.max(maxY, array[offset + 1]!);
        minZ = Math.min(minZ, array[offset + 2]!); maxZ = Math.max(maxZ, array[offset + 2]!);
      }
    }
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

describe("T12 公差简化:公差受输入约束(合成网格)", () => {
  it("公差内简化:实际误差 ≤ 公差、三角形明显减少、源面映射可追溯", async () => {
    const sphere = icosphere(3);
    const tolerance = 0.02; // 单位球直径的 1%
    const result = await simplifyPrimitiveWithTolerance(sphere, { tolerance });
    expect(result.status).toBe("ok");
    expect(result.withinTolerance).toBe(true);
    expect(result.simplifierErrorAbsolute!).toBeLessThanOrEqual(tolerance);
    expect(result.outputTriangleCount).toBeLessThan(result.inputTriangleCount);
    expect(result.mappedOutputTriangles).toBeGreaterThan(0);
    expect(result.collapsedSourceFaceCount).toBeGreaterThan(0);
    expect(result.faceMapping[0]!.sourceFaceId).toBeLessThan(result.inputTriangleCount);
    for (const index of result.outputIndices!) expect(index).toBeLessThan(result.vertexCount);
  });

  it("公差-误差曲线:三档公差单调,实际误差逐档受约束(报告数据源)", async () => {
    const sphere = icosphere(3);
    const curve: Array<Record<string, number>> = [];
    for (const ratio of [0.002, 0.01, 0.05]) {
      const tolerance = 2 * ratio;
      const result = await simplifyPrimitiveWithTolerance(sphere, { tolerance });
      expect(result.withinTolerance).toBe(true);
      expect(result.simplifierErrorAbsolute!).toBeLessThanOrEqual(tolerance * (1 + 1e-9));
      curve.push({
        toleranceRatioOfExtent: ratio,
        tolerance,
        inputTriangles: result.inputTriangleCount,
        outputTriangles: result.outputTriangleCount,
        simplifierErrorAbsolute: result.simplifierErrorAbsolute!,
        measuredMaxCentroidDeviation: result.measuredMaxCentroidDeviation!,
      });
    }
    expect(curve[0]!.outputTriangles).toBeGreaterThan(curve[1]!.outputTriangles);
    expect(curve[1]!.outputTriangles).toBeGreaterThan(curve[2]!.outputTriangles);
    expect(curve[1]!.simplifierErrorAbsolute).toBeGreaterThanOrEqual(curve[0]!.simplifierErrorAbsolute);
    expect(curve[2]!.simplifierErrorAbsolute).toBeGreaterThanOrEqual(curve[1]!.simplifierErrorAbsolute);
    console.log("[T12 合成 icosphere 公差曲线]", JSON.stringify(curve));
  });

  it("同输入两次简化逐字节一致(确定性)", async () => {
    const sphere = icosphere(2);
    const first = await simplifyPrimitiveWithTolerance(sphere, { tolerance: 0.02 });
    const second = await simplifyPrimitiveWithTolerance(sphere, { tolerance: 0.02 });
    expect(Buffer.from(second.outputIndices!.buffer).equals(Buffer.from(first.outputIndices!.buffer))).toBe(true);
    expect(second.simplifierErrorAbsolute).toBe(first.simplifierErrorAbsolute);
    expect(second.faceMapping).toEqual(first.faceMapping);
  });

  it("重复顶点输入(未焊接)与焊接输入在同一公差下等价", async () => {
    const sphere = icosphere(2);
    const positions: number[] = [];
    const indices: number[] = [];
    for (let triangle = 0; triangle < sphere.indices.length / 3; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const source = sphere.indices[triangle * 3 + corner]!;
        positions.push(
          sphere.positions[source * 3]!, sphere.positions[source * 3 + 1]!, sphere.positions[source * 3 + 2]!);
        indices.push(indices.length);
      }
    }
    const tolerance = 0.2;
    const welded = await simplifyPrimitiveWithTolerance(sphere, { tolerance });
    const unwelded = await simplifyPrimitiveWithTolerance(
      { primitiveId: "unwelded", positions: Float32Array.from(positions), indices: Uint32Array.from(indices) },
      { tolerance });
    expect(welded.status).toBe("ok");
    expect(unwelded.status).toBe("ok");
    expect(unwelded.outputTriangleCount).toBeLessThan(unwelded.inputTriangleCount);
    // 位置焊接正确时,两者可达的简化程度一致(顶点编号差异只允许带来次要的坍缩顺序抖动)。
    expect(Math.abs(unwelded.outputTriangleCount - welded.outputTriangleCount))
      .toBeLessThanOrEqual(Math.ceil(welded.outputTriangleCount * 0.05));
    expect(unwelded.simplifierErrorAbsolute!).toBeLessThanOrEqual(tolerance);
  });

  it("外部源面 id(如 CAD face id)在映射中原样返回", async () => {
    const sphere = icosphere(2);
    const sourceFaceIds = new Uint32Array(sphere.indices.length / 3);
    for (let triangle = 0; triangle < sourceFaceIds.length; triangle += 1) {
      sourceFaceIds[triangle] = 1000 + triangle * 7;
    }
    const result = await simplifyPrimitiveWithTolerance({ ...sphere, sourceFaceIds }, {
      tolerance: 0.05, targetTriangleRatio: 0.3, faceMappingLimit: 16 });
    expect(result.faceMapping.length).toBeLessThanOrEqual(16);
    expect(result.mappedSourceFaceCount).toBeGreaterThan(0);
    for (const mapping of result.faceMapping) {
      expect((mapping.sourceFaceId - 1000) % 7).toBe(0);
    }
  });

  it("非法公差 / 空图元 / 退化图元:显式 rejected 或剔除,不产出伪结果", async () => {
    const sphere = icosphere(1);
    const zeroTolerance = await simplifyPrimitiveWithTolerance(sphere, { tolerance: 0 });
    expect(zeroTolerance.status).toBe("rejected");
    const empty = await simplifyPrimitiveWithTolerance(
      { primitiveId: "empty", positions: new Float32Array(0), indices: new Uint32Array(0) }, { tolerance: 1 });
    expect(empty.status).toBe("ok");
    expect(empty.outputTriangleCount).toBe(0);
    const degenerate = await simplifyPrimitiveWithTolerance(
      { primitiveId: "line", positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), indices: Uint32Array.from([0, 1, 2]) },
      { tolerance: 1 });
    expect(degenerate.strippedDegenerateTriangles).toBe(1);
    expect(degenerate.outputTriangleCount).toBe(0);
  });
});

describe("T12 公差简化:真实 GLB(T00 工厂 Kenney 机器资产)双路验证", () => {
  it("robot-arm-a 全图元:三档公差内误差受约束、只读不写(报告数据源)", async () => {
    const file = await realFile();
    const bytesBefore = await readFile(file);
    const extent = await realExtent(file);
    const curve: Array<Record<string, number>> = [];
    for (const ratio of [0.002, 0.01, 0.02] as const) {
      const tolerance = extent * ratio;
      const results = await simplifyGlbWithTolerance(file, { tolerance });
      const triangleResults = results.filter((entry) => entry.inputTriangleCount > 0);
      expect(triangleResults.length).toBeGreaterThan(0);
      for (const result of triangleResults) {
        expect(result.status, `${result.primitiveId}: ${result.reason ?? ""}`).toBe("ok");
        expect(result.simplifierErrorAbsolute!).toBeLessThanOrEqual(tolerance * (1 + 1e-9));
      }
      curve.push({
        toleranceRatioOfExtent: ratio,
        tolerance,
        inputTriangles: triangleResults.reduce((sum, entry) => sum + entry.inputTriangleCount, 0),
        outputTriangles: triangleResults.reduce((sum, entry) => sum + entry.outputTriangleCount, 0),
        maxSimplifierErrorAbsolute: Math.max(...triangleResults.map((entry) => entry.simplifierErrorAbsolute!)),
        mappedSourceFaces: triangleResults.reduce((sum, entry) => sum + entry.mappedSourceFaceCount, 0),
      });
    }
    expect(curve[0]!.outputTriangles).toBeLessThan(curve[0]!.inputTriangles);
    expect(curve[2]!.outputTriangles).toBeLessThan(curve[1]!.outputTriangles);
    console.log("[T12 真实 GLB robot-arm-a 公差曲线]", JSON.stringify(curve));
    const bytesAfter = await readFile(file);
    expect(createHash("sha256").update(bytesAfter).digest("hex"))
      .toBe(createHash("sha256").update(bytesBefore).digest("hex"));
  }, 60_000);
});
