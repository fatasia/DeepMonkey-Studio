import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Accessor, Document, NodeIO, type Material, type Mesh } from "@gltf-transform/core";
import createOcct, { type OcctMesh, type OcctNode } from "occt-import-js";

export interface StepConversionResult {
  meshCount: number;
  triangleCount: number;
  vertexCount: number;
}

type PreciseCadFormat = "STEP" | "IGES";

interface StepHierarchyNode {
  id: string;
  name: string;
  type: string;
  meshIds: string[];
  children: StepHierarchyNode[];
}

let occtPromise: ReturnType<typeof createOcct> | undefined;

export async function convertStepToGlb(sourcePath: string, outputDir: string): Promise<StepConversionResult> {
  return convertPreciseCadToGlb(sourcePath, outputDir, "STEP");
}

export async function convertIgesToGlb(sourcePath: string, outputDir: string): Promise<StepConversionResult> {
  return convertPreciseCadToGlb(sourcePath, outputDir, "IGES");
}

async function convertPreciseCadToGlb(sourcePath: string, outputDir: string, format: PreciseCadFormat): Promise<StepConversionResult> {
  occtPromise ??= createOcct();
  const occt = await occtPromise;
  const bytes = await readFile(sourcePath);
  const parameters = {
    linearUnit: "meter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.001,
    angularDeflection: 0.5
  };
  const imported = format === "STEP"
    ? occt.ReadStepFile(bytes, parameters)
    : occt.ReadIgesFile(bytes, parameters);
  if (!imported.success || imported.meshes.length === 0) {
    throw new Error(`${format} 解析失败：文件没有可用的 B-Rep 网格，或数据不完整`);
  }

  const document = new Document();
  const buffer = document.createBuffer(`${format} geometry`);
  const scene = document.createScene(path.basename(sourcePath));
  const materialCache = new Map<string, Material>();
  const gltfMeshes = imported.meshes.map((mesh, index) => createMesh(document, buffer, materialCache, mesh, index, format));
  const properties: Record<string, unknown> = {};
  let nodeSequence = 0;
  const buildNode = (source: OcctNode, nodePath: string, isRoot = false): { node: ReturnType<Document["createNode"]>; hierarchy: StepHierarchyNode } => {
    const nodeId = `${format.toLowerCase()}-node:${nodeSequence++}`;
    const name = source.name?.trim() || (isRoot ? path.basename(sourcePath) : `${format} 装配 ${nodeSequence}`);
    const nodeType = isRoot ? `${format} 模型` : `${format} 装配`;
    const node = document.createNode(name).setExtras({
      ElementId: nodeId,
      NodeType: isRoot ? "Model" : "Assembly",
      SourceFormat: format,
      名称: name,
      类型: nodeType,
      子节点数: String(source.children.length),
      直属零件数: String(source.meshes.length),
      路径: nodePath
    });
    const meshIds: string[] = [];
    source.meshes.forEach((meshIndex, localIndex) => {
      const sourceMesh = imported.meshes[meshIndex];
      const gltfMesh = gltfMeshes[meshIndex];
      if (!sourceMesh || !gltfMesh) return;
      const meshId = `${format.toLowerCase()}-mesh:${meshIndex}`;
      meshIds.push(meshId);
      const meshNode = document.createNode(sourceMesh.name?.trim() || `零件 ${meshIndex + 1}`)
        .setMesh(gltfMesh)
        .setExtras({
          ElementId: meshId,
          NodeType: "Element",
          ParentId: nodeId,
          SourceFormat: format,
          MeshIndex: meshIndex
        });
      node.addChild(meshNode);
      properties[meshId] = {
        elementId: meshId,
        displayProperties: {
          名称: meshNode.getName(),
          类型: `${format} 零件`,
          所属装配: name,
          网格序号: String(meshIndex + 1),
          顶点数: String(sourceMesh.attributes.position.array.length / 3),
          三角面数: String(sourceMesh.index.array.length / 3),
          ...(sourceMesh.color ? { 颜色: sourceMesh.color.map((value) => Math.round(value * 255)).join(", ") } : {})
        }
      };
      // Preserve repeated mesh names as independent selectable nodes.
      if (localIndex > 0 && meshNode.getName() === node.getName()) meshNode.setName(`${meshNode.getName()} ${localIndex + 1}`);
    });
    const children = source.children.map((child, index) => buildNode(child, `${nodePath}/${index}`));
    children.forEach((child) => node.addChild(child.node));
    return {
      node,
      hierarchy: {
        id: nodeId,
        name,
        type: isRoot ? `${format} 模型` : source.meshes.length > 0 && source.children.length === 0 ? "零件" : "装配",
        meshIds,
        children: children.map((child) => child.hierarchy)
      }
    };
  };

  const root = buildNode(imported.root, "0", true);
  scene.addChild(root.node);
  const binary = await new NodeIO().writeBinary(document);
  const triangleCount = imported.meshes.reduce((total, mesh) => total + mesh.index.array.length / 3, 0);
  const vertexCount = imported.meshes.reduce((total, mesh) => total + mesh.attributes.position.array.length / 3, 0);
  await Promise.all([
    writeFile(path.join(outputDir, "geometry.glb"), binary),
    writeFile(path.join(outputDir, "hierarchy.json"), JSON.stringify({ schemaVersion: 1, root: root.hierarchy }, null, 2), "utf8"),
    writeFile(path.join(outputDir, "properties.json"), JSON.stringify({
      schemaVersion: 1,
      model: {
        sourceFormat: format,
        sourceName: path.basename(sourcePath),
        meshCount: imported.meshes.length,
        triangleCount,
        vertexCount,
        units: "meter"
      },
      elements: properties
    }, null, 2), "utf8")
  ]);
  return { meshCount: imported.meshes.length, triangleCount, vertexCount };
}

function createMesh(
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  materialCache: Map<string, Material>,
  source: OcctMesh,
  index: number,
  format: PreciseCadFormat,
): Mesh {
  const positions = new Float32Array(source.attributes.position.array);
  const normals = source.attributes.normal?.array;
  const positionAccessor = document.createAccessor()
    .setType(Accessor.Type.VEC3!)
    .setArray(positions)
    .setBuffer(buffer);
  const normalAccessor = normals?.length === positions.length
    ? document.createAccessor()
      .setType(Accessor.Type.VEC3!)
      .setArray(new Float32Array(normals))
      .setBuffer(buffer)
    : undefined;
  const mesh = document.createMesh(source.name?.trim() || `${format} 零件 ${index + 1}`);
  meshIndexGroups(source).forEach((group) => {
    const primitive = document.createPrimitive()
      .setAttribute("POSITION", positionAccessor)
      .setIndices(document.createAccessor()
        .setType(Accessor.Type.SCALAR!)
        .setArray(new Uint32Array(group.indices))
        .setBuffer(buffer))
      .setMaterial(materialFor(document, materialCache, group.color, format));
    if (normalAccessor) primitive.setAttribute("NORMAL", normalAccessor);
    mesh.addPrimitive(primitive);
  });
  return mesh;
}

/** OCCT 的 first/last 使用三角面序号；按有效面色分组，同时保留未被 face 表覆盖的三角面。 */
function meshIndexGroups(source: OcctMesh): Array<{ indices: number[]; color?: number[] }> {
  if (!source.brep_faces?.length) return [{ indices: source.index.array, ...(source.color ? { color: source.color } : {}) }];
  const groups = new Map<string, { indices: number[]; color?: number[] }>();
  const covered = new Set<number>();
  const add = (color: number[] | undefined, triangleIndex: number) => {
    const key = color?.slice(0, 3).map((value) => value.toFixed(6)).join(":") ?? "default";
    const group = groups.get(key) ?? { indices: [], ...(color ? { color } : {}) };
    group.indices.push(...source.index.array.slice(triangleIndex * 3, triangleIndex * 3 + 3));
    groups.set(key, group);
  };
  const triangleCount = Math.floor(source.index.array.length / 3);
  source.brep_faces.forEach((face) => {
    const first = Math.max(0, Math.floor(face.first));
    const last = Math.min(triangleCount - 1, Math.floor(face.last));
    for (let triangle = first; triangle <= last; triangle += 1) {
      if (covered.has(triangle)) continue;
      covered.add(triangle);
      add(face.color ?? source.color, triangle);
    }
  });
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (!covered.has(triangle)) add(source.color, triangle);
  }
  return [...groups.values()].filter((group) => group.indices.length > 0);
}

function materialFor(document: Document, cache: Map<string, Material>, color: number[] | undefined, format: PreciseCadFormat): Material {
  const rgb: [number, number, number] = color && color.length >= 3
    ? [clampColor(color[0]), clampColor(color[1]), clampColor(color[2])]
    : [0.72, 0.75, 0.78];
  const key = rgb.map((value) => value.toFixed(4)).join(":");
  const existing = cache.get(key);
  if (existing) return existing;
  const material = document.createMaterial(`${format} ${key}`)
    .setBaseColorFactor([...rgb, 1])
    .setRoughnessFactor(0.72)
    .setMetallicFactor(0.05)
    .setDoubleSided(true);
  cache.set(key, material);
  return material;
}

function clampColor(value: number | undefined): number {
  return Math.min(1, Math.max(0, value ?? 0.75));
}
