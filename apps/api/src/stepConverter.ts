import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Accessor, Document, NodeIO, type Material, type Mesh } from "@gltf-transform/core";
import createOcct, { type OcctMesh, type OcctNode } from "occt-import-js";

export interface StepConversionResult {
  meshCount: number;
  triangleCount: number;
  vertexCount: number;
}

interface StepHierarchyNode {
  id: string;
  name: string;
  type: "STEP 模型" | "装配" | "零件";
  meshIds: string[];
  children: StepHierarchyNode[];
}

let occtPromise: ReturnType<typeof createOcct> | undefined;

export async function convertStepToGlb(sourcePath: string, outputDir: string): Promise<StepConversionResult> {
  occtPromise ??= createOcct();
  const occt = await occtPromise;
  const bytes = await readFile(sourcePath);
  const imported = occt.ReadStepFile(bytes, {
    linearUnit: "meter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.001,
    angularDeflection: 0.5
  });
  if (!imported.success || imported.meshes.length === 0) {
    throw new Error("STEP 解析失败：文件没有可用的 B-Rep 网格，或 STEP 数据不完整");
  }

  const document = new Document();
  const buffer = document.createBuffer("STEP geometry");
  const scene = document.createScene(path.basename(sourcePath));
  const materialCache = new Map<string, Material>();
  const gltfMeshes = imported.meshes.map((mesh, index) => createMesh(document, buffer, materialCache, mesh, index));
  const properties: Record<string, unknown> = {};
  let nodeSequence = 0;
  const buildNode = (source: OcctNode, nodePath: string, isRoot = false): { node: ReturnType<Document["createNode"]>; hierarchy: StepHierarchyNode } => {
    const nodeId = `step-node:${nodeSequence++}`;
    const name = source.name?.trim() || (isRoot ? path.basename(sourcePath) : `STEP 装配 ${nodeSequence}`);
    const nodeType = isRoot ? "STEP 模型" : "STEP 装配";
    const node = document.createNode(name).setExtras({
      ElementId: nodeId,
      NodeType: isRoot ? "Model" : "Assembly",
      SourceFormat: "STEP",
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
      const meshId = `step-mesh:${meshIndex}`;
      meshIds.push(meshId);
      const meshNode = document.createNode(sourceMesh.name?.trim() || `零件 ${meshIndex + 1}`)
        .setMesh(gltfMesh)
        .setExtras({
          ElementId: meshId,
          NodeType: "Element",
          ParentId: nodeId,
          SourceFormat: "STEP",
          MeshIndex: meshIndex
        });
      node.addChild(meshNode);
      properties[meshId] = {
        elementId: meshId,
        displayProperties: {
          名称: meshNode.getName(),
          类型: "STEP 零件",
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
        type: isRoot ? "STEP 模型" : source.meshes.length > 0 && source.children.length === 0 ? "零件" : "装配",
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
        sourceFormat: "STEP",
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
  index: number
): Mesh {
  const positions = new Float32Array(source.attributes.position.array);
  const indices = new Uint32Array(source.index.array);
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor()
      .setType(Accessor.Type.VEC3!)
      .setArray(positions)
      .setBuffer(buffer))
    .setIndices(document.createAccessor()
      .setType(Accessor.Type.SCALAR!)
      .setArray(indices)
      .setBuffer(buffer));
  if (source.attributes.normal?.array.length === positions.length) {
    primitive.setAttribute("NORMAL", document.createAccessor()
      .setType(Accessor.Type.VEC3!)
      .setArray(new Float32Array(source.attributes.normal.array))
      .setBuffer(buffer));
  }
  primitive.setMaterial(materialFor(document, materialCache, source.color));
  return document.createMesh(source.name?.trim() || `STEP 零件 ${index + 1}`).addPrimitive(primitive);
}

function materialFor(document: Document, cache: Map<string, Material>, color?: number[]): Material {
  const rgb: [number, number, number] = color && color.length >= 3
    ? [clampColor(color[0]), clampColor(color[1]), clampColor(color[2])]
    : [0.72, 0.75, 0.78];
  const key = rgb.map((value) => value.toFixed(4)).join(":");
  const existing = cache.get(key);
  if (existing) return existing;
  const material = document.createMaterial(`STEP ${key}`)
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
