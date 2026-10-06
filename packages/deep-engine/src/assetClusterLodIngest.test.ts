/**
 * 场景包 → .dgc 驻留摄入(ingestSceneClusterLod)门:
 * 材质实例分节语义(绑定由构造保证)、.dgc 字节经解码回路签核、fail-closed 全族
 * (变形整包拒/BLEND 回退/顶点预算回退/bake 失败回退/节预算整包拒)与确定性。
 * 几何 fixture 为纯 CPU 确定性立方体(12 三角),与 meshletBuilder.test 同风格。
 */
import { describe, expect, it } from "vitest";
import { ingestSceneClusterLod, type SceneClusterLodSection } from "./assetClusterLodIngest.js";
import { decodeDgc } from "./geometry/dgcLoader.js";
import type { GeometryResource, PbrMaterial, RenderInstance, RenderPacket } from "./renderPacketTypes.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const TRANSLATE_X = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1];

function cubeGeometry(id: string): GeometryResource {
  const corners = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] as const;
  const vertices = new Float32Array(corners.length * 6);
  corners.forEach(([x, y, z], vertex) => vertices.set([x, y, z, 0, 0, 1], vertex * 6));
  const quads = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7]];
  const indices = new Uint32Array(quads.length * 6);
  quads.forEach(([a, b, c, d], quad) => indices.set([a, b, c, a, c, d], quad * 6));
  return { id, revision: 1, vertices, indices };
}

const STEEL: PbrMaterial = { id: "steel", baseColor: [0.8, 0.8, 0.8], metallic: 1, roughness: 0.4 };
const GLASS: PbrMaterial = { id: "glass", baseColor: [0.9, 0.9, 1], metallic: 0, roughness: 0.1,
  alphaMode: "BLEND" };
const MASK: PbrMaterial = { id: "mask", baseColor: [1, 1, 1], metallic: 0, roughness: 0.6,
  alphaMode: "MASK" };

function scenePacket(instances: readonly RenderInstance[],
  materials: readonly PbrMaterial[] = [STEEL, GLASS, MASK]): RenderPacket {
  return { geometries: [cubeGeometry("cube")], materials, instances };
}

const instance = (id: string, material: string,
  transform: ArrayLike<number> = IDENTITY): RenderInstance => ({ id, geometry: "cube", material, transform });

describe("ingestSceneClusterLod(场景包→.dgc 驻留摄入)", () => {
  it("按 (geometry, material) 分节:同材质实例并入一节,节内簇顶点绑定该材质实例", () => {
    const outcome = ingestSceneClusterLod(scenePacket([
      instance("inst-1", "steel"), instance("inst-2", "steel", TRANSLATE_X), instance("inst-4", "mask"),
    ]));
    if (!outcome.ok) throw outcome.failure;
    expect(outcome.value.sections.length).toBe(2);
    expect(outcome.value.mergedInstances).toBe(3);
    expect(outcome.value.skippedDeformedInstances).toBe(0);
    const [steel, mask] = outcome.value.sections;
    expect(steel!.id).toBe("cluster-lod:s0:cube:steel");
    expect(steel!.geometryId).toBe("cube");
    expect(steel!.materialId).toBe("steel");
    expect([...steel!.instanceIds]).toEqual(["inst-1", "inst-2"]);
    expect(mask!.materialId).toBe("mask");
    expect(steel!.vertexCount).toBe(16);
    expect(steel!.triangleCount).toBe(24);
  });

  it("节产物自证:.dgc 过解码回路签核,staging 为既有驻留链直取形状", () => {
    const outcome = ingestSceneClusterLod(scenePacket([instance("inst-1", "steel")]),
      { pixelThreshold: 2.5 });
    if (!outcome.ok) throw outcome.failure;
    const section: SceneClusterLodSection = outcome.value.sections[0]!;
    const decoded = decodeDgc(section.dgcBytes);
    expect(section.levelCount).toBe(decoded.levels.length);
    expect(decoded.levels[0]!.maxVertices).toBe(64);
    expect(decoded.levels[0]!.maxTriangles).toBe(64);
    expect(section.nodeCount).toBe(section.staging.dag.nodes.length);
    expect(section.staging.dag.geometryId).toBe(section.id);
    expect(section.staging.dag.leafTriangleTotal).toBe(12);
    expect(section.staging.pixelThreshold).toBe(2.5);
    expect(section.staging.levelGeometry.length).toBe(decoded.levels.length);
    for (const [level, geometry] of section.staging.levelGeometry.entries()) {
      expect(geometry.vertices.length).toBe(decoded.levels[level]!.positions.length);
      expect(geometry.indices.length).toBe(decoded.levels[level]!.indices.length);
    }
  });

  it("BLEND 材质显式回退(MASK/OPAQUE 进节):回退实例保持普通 draw 路径且如实登记", () => {
    const outcome = ingestSceneClusterLod(scenePacket([
      instance("inst-3", "glass"), instance("inst-1", "steel"), instance("inst-4", "mask"),
    ]));
    if (!outcome.ok) throw outcome.failure;
    expect(outcome.value.sections.length).toBe(2);
    expect(outcome.value.fallbacks.length).toBe(1);
    expect(outcome.value.fallbacks[0]!.reason).toBe("blend-material");
    expect(outcome.value.fallbacks[0]!.materialId).toBe("glass");
    expect([...outcome.value.fallbacks[0]!.instanceIds]).toEqual(["inst-3"]);
    expect(outcome.value.fallbacks[0]!.detail).toContain("normal draw path");
  });

  it("带 pose 实例跳过并计数(变形边界,slot 不接收变形)", () => {
    const posed = { ...instance("inst-5", "steel"), pose: "wave" };
    const outcome = ingestSceneClusterLod(scenePacket([posed, instance("inst-1", "steel")]));
    if (!outcome.ok) throw outcome.failure;
    expect(outcome.value.skippedDeformedInstances).toBe(1);
    expect(outcome.value.mergedInstances).toBe(1);
    expect([...outcome.value.sections[0]!.instanceIds]).toEqual(["inst-1"]);
  });

  it("包级 deformation 整包拒绝(与作者链合并器同边界)", () => {
    const packet = { ...scenePacket([instance("inst-1", "steel")]),
      deformation: { sources: [], poses: [] } };
    const outcome = ingestSceneClusterLod(packet);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.reason).toBe("deformation-packet");
  });

  it("顶点预算超限:该节显式回退带数值,其余节照常驻留", () => {
    const outcome = ingestSceneClusterLod(
      scenePacket([instance("inst-1", "steel"), instance("inst-4", "mask")]),
      { maxSectionVertices: 4 });
    if (!outcome.ok) throw outcome.failure;
    expect(outcome.value.sections.length).toBe(0);
    expect(outcome.value.fallbacks.map(fallback => fallback.reason))
      .toEqual(["vertex-budget-exceeded", "vertex-budget-exceeded"]);
    expect(outcome.value.fallbacks[0]!.detail).toContain("8 > 4");
  });

  it("零可摄入实例:ok:true 空节集,无隐藏语义", () => {
    const outcome = ingestSceneClusterLod(scenePacket([]));
    if (!outcome.ok) throw outcome.failure;
    expect(outcome.value.sections).toEqual([]);
    expect(outcome.value.fallbacks).toEqual([]);
    expect(outcome.value.mergedInstances).toBe(0);
  });

  it("节预算超限整包拒绝(section-budget-exceeded)", () => {
    const outcome = ingestSceneClusterLod(
      scenePacket([instance("inst-1", "steel"), instance("inst-4", "mask")]), { maxSections: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.reason).toBe("section-budget-exceeded");
  });

  it("确定性:同输入两次摄入 .dgc 字节与 cacheKey 逐位一致", () => {
    const first = ingestSceneClusterLod(scenePacket([instance("inst-1", "steel")]));
    const second = ingestSceneClusterLod(scenePacket([instance("inst-1", "steel")]));
    if (!first.ok || !second.ok) throw first.ok ? second.failure : first.failure;
    expect(Buffer.from(first.value.sections[0]!.dgcBytes)
      .equals(Buffer.from(second.value.sections[0]!.dgcBytes))).toBe(true);
    expect(first.value.cacheKey).toBe(second.value.cacheKey);
    expect(first.value.cacheKey).toMatch(/^deep\.cluster-lod-ingest\.v1:[0-9a-f]{16}$/);
  });

  it("选项契约:非法预算 RangeError / 变换非 4x4 TypeError / 已中止 signal AbortError", () => {
    expect(() => ingestSceneClusterLod(scenePacket([]), { maxVertices: 65 })).toThrow(RangeError);
    expect(() => ingestSceneClusterLod(scenePacket([]), { levels: 0 })).toThrow(RangeError);
    const broken = scenePacket([instance("inst-1", "steel", [...IDENTITY.slice(0, 15)])]);
    expect(() => ingestSceneClusterLod(broken)).toThrow(TypeError);
    const controller = new AbortController();
    controller.abort();
    expect(() => ingestSceneClusterLod(scenePacket([instance("inst-1", "steel")]),
      { signal: controller.signal })).toThrow(/aborted/);
  });
});
