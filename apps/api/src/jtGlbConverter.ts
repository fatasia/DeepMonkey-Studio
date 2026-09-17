import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, NodeIO, type Material, type Mesh } from "@gltf-transform/core";
import type { JtDocument, JtMesh, JtMeshInstance } from "@bim-studio/jt-reader";
import { calculateVertexNormals, createIndexedTrianglePrimitive } from "./indexedTriangleMesh.js";
import { jtInstanceElementId, type JtMaterialEvidence } from "./jtInspection.js";
import { createJtMaterialResolver } from "./jtMaterialResolution.js";

type GltfMatrix = Parameters<ReturnType<Document["createNode"]>["setMatrix"]>[0];

export interface JtGlbConversionResult {
  /** 源 LOD0 几何计数；材质变体只共享 accessor，不重复计入。 */
  meshCount: number;
  instanceCount: number;
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** 将 reader 已验证的最高精度 LOD0 网格写入现有 glTF 浏览链。 */
export async function convertJtLod0ToGlb(
  document: JtDocument,
  outputDir: string,
  sourceName: string,
  materials: readonly JtMaterialEvidence[],
): Promise<JtGlbConversionResult | undefined> {
  const meshes = document.meshes.filter((mesh) => mesh.lod === 0);
  if (meshes.length === 0 || !meshes.every(isValidMesh)) return undefined;
  const meshById = new Map(meshes.map((mesh) => [mesh.id, mesh]));
  const instances = document.meshInstances.filter((instance) => meshById.has(instance.meshId));
  const linkedMeshIds = new Set(instances.map((instance) => instance.meshId));
  if (instances.length === 0 || !meshes.every((mesh) => linkedMeshIds.has(mesh.id)) || !instances.every(isValidInstance)) {
    return undefined;
  }

  const gltf = new Document();
  const buffer = gltf.createBuffer("JT LOD0 geometry");
  const scene = gltf.createScene(sourceName);
  const sceneNodes = new Map(document.sceneGraph.nodes.map((node) => [node.objectId, node]));
  const gltfMeshes = new Map<string, Mesh>();
  const resolveMaterial = createJtMaterialResolver(materials);
  const variants = new Map<string, Mesh>();
  const gltfMaterials = new Map<string, Material>();
  const assignedMeshes = new Set<string>();
  const placeholder = createMaterial(gltf, undefined, 0);
  let primitiveCount = 0;
  meshes.forEach((mesh, index) => {
    const gltfMesh = gltf.createMesh(`JT 网格 ${index + 1}`);
    for (const [groupId, indices] of triangleGroups(mesh)) {
      const primitive = createIndexedTrianglePrimitive(gltf, buffer, placeholder, {
        positions: mesh.positions,
        indices,
        normals: calculateVertexNormals(mesh.positions, indices),
      }).setExtras({ PolygonGroup: groupId });
      gltfMesh.addPrimitive(primitive);
      primitiveCount += 1;
    }
    gltfMeshes.set(mesh.id, gltfMesh);
  });
  instances.forEach((instance, index) => {
    const mesh = meshById.get(instance.meshId)!;
    const sourceNode = sceneNodes.get(instance.sceneNodeObjectId);
    const resolved = resolveMaterial(instance);
    const variantKey = JSON.stringify([mesh.id, resolved.key]);
    let variant = variants.get(variantKey);
    if (!variant) {
      let material = gltfMaterials.get(resolved.key);
      if (!material) {
        material = resolved.evidence ? createMaterial(gltf, resolved.evidence, gltfMaterials.size) : placeholder;
        gltfMaterials.set(resolved.key, material);
      }
      const base = gltfMeshes.get(mesh.id)!;
      variant = base;
      if (assignedMeshes.has(mesh.id)) {
        // 材质属于 primitive：只复制其引用容器，顶点/法线/索引 accessor 仍共享。
        variant = gltf.createMesh(`${base.getName()} 材质变体`);
        for (const primitive of base.listPrimitives()) variant.addPrimitive(primitive.clone());
      }
      for (const primitive of variant.listPrimitives()) primitive.setMaterial(material);
      variants.set(variantKey, variant);
      assignedMeshes.add(mesh.id);
    }
    scene.addChild(gltf.createNode(sourceNode?.label || `JT LOD0 实例 ${index + 1}`)
      .setMesh(variant)
      .setMatrix(instance.worldTransform as GltfMatrix)
      .setExtras({
        ElementId: jtInstanceElementId(instance),
        NodeType: "Element",
        SourceFormat: "JT",
        SegmentId: mesh.segmentId,
        Lod: mesh.lod,
        SceneNodeObjectId: instance.sceneNodeObjectId,
        AssemblyPath: instance.pathObjectIds.join("/"),
        MaterialStatus: resolved.status,
        MaterialSourceObjectIds: resolved.sourceObjectIds,
      }));
  });
  if (!gltfMaterials.has("unassigned")) placeholder.dispose();

  const binary = await new NodeIO().writeBinary(gltf);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "geometry.glb"), binary);
  return summarize(meshes, instances, primitiveCount);
}

function isValidMesh(mesh: JtMesh): boolean {
  if (!Number.isSafeInteger(mesh.vertexCount) || !Number.isSafeInteger(mesh.triangleCount)) return false;
  if (mesh.vertexCount <= 0 || mesh.triangleCount <= 0) return false;
  if (mesh.positions.length !== mesh.vertexCount * 3 || mesh.indices.length !== mesh.triangleCount * 3) return false;
  if (!mesh.positions.every(Number.isFinite)) return false;
  if (!mesh.polygonGroups.every(Number.isSafeInteger)) return false;
  return mesh.indices.every((index) => Number.isInteger(index) && index >= 0 && index < mesh.vertexCount);
}

function isValidInstance(instance: JtMeshInstance): boolean {
  return instance.worldTransform.length === 16 && instance.worldTransform.every(Number.isFinite);
}

function triangleGroups(mesh: JtMesh): Array<[number, number[]]> {
  // JT 9.5 的面组数组可能按原多边形计数，而 indices 已被 reader 三角化；
  // 缺少多边形边界时不能猜测归属，安全退化为单图元但保留完整几何。
  if (mesh.polygonGroups.length !== mesh.triangleCount) return [[0, [...mesh.indices]]];
  const groups = new Map<number, number[]>();
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const groupId = mesh.polygonGroups[triangle]!;
    const indices = groups.get(groupId) ?? [];
    indices.push(...mesh.indices.slice(triangle * 3, triangle * 3 + 3));
    groups.set(groupId, indices);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right);
}

function createMaterial(
  document: Document,
  evidence: JtMaterialEvidence | undefined,
  index: number,
): Material {
  const rgb = evidence?.diffuse ?? [0.64, 0.69, 0.72];
  const opacity = clamp(evidence?.opacity ?? 1);
  const material = document.createMaterial(`JT 材质 ${index + 1}`)
    .setBaseColorFactor([clamp(rgb[0]), clamp(rgb[1]), clamp(rgb[2]), opacity])
    .setMetallicFactor(clamp(evidence?.reflectivity ?? 0))
    .setRoughnessFactor(clamp(1 - (evidence?.shininess ?? 15) / 128))
    .setDoubleSided(true);
  if (opacity < 1) material.setAlphaMode("BLEND");
  return material;
}

function summarize(
  meshes: readonly JtMesh[],
  instances: readonly JtMeshInstance[],
  primitiveCount: number,
): JtGlbConversionResult {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const meshById = new Map(meshes.map((mesh) => [mesh.id, mesh]));
  for (const instance of instances) {
    const mesh = meshById.get(instance.meshId)!;
    for (let offset = 0; offset < mesh.positions.length; offset += 3) {
      const position = transformPoint(instance.worldTransform, mesh.positions, offset);
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis]!, position[axis]!);
        maximum[axis] = Math.max(maximum[axis]!, position[axis]!);
      }
    }
  }
  return {
    meshCount: meshes.length,
    instanceCount: instances.length,
    primitiveCount,
    vertexCount: meshes.reduce((total, mesh) => total + mesh.vertexCount, 0),
    triangleCount: meshes.reduce((total, mesh) => total + mesh.triangleCount, 0),
    bounds: { min: minimum, max: maximum },
  };
}

/** glTF 与 reader 均使用列主序矩阵，此处只展开仿射点变换用于世界包围盒证据。 */
function transformPoint(matrix: readonly number[], values: readonly number[], offset: number): [number, number, number] {
  const x = values[offset]!;
  const y = values[offset + 1]!;
  const z = values[offset + 2]!;
  return [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
  ];
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
