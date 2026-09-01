import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_JT_READ_LIMITS,
  readJt,
  type JtDocument,
  type JtMesh,
  type JtMeshInstance,
  type JtPropertyValue,
  type JtSceneNode,
} from "@bim-studio/jt-reader";

export interface JtMaterialEvidence {
  objectId: number;
  diffuse: [number, number, number];
  opacity: number;
  shininess: number;
  reflectivity: number;
}

export interface JtInspectionResult {
  status: "structure-read" | "geometry-supported";
  recognizedFormat: "jt";
  inspectionScope: "structure-and-metadata" | "structure-metadata-and-geometry";
  geometryParsed: boolean;
  message: string;
  header: JtDocument["header"];
  toc: { entryCount: number; segments: JtDocument["segments"] };
  assembly: {
    nodeCount: number;
    rootObjectIds: number[];
    nodes: JtSceneNode[];
  };
  properties: {
    atomCount: number;
    nodeCount: number;
    valueCount: number;
  };
  materials: JtMaterialEvidence[];
  geometry: {
    status: "not-decoded" | "decoded";
    meshCount: number;
    lod0MeshCount: number;
    lod0InstanceCount: number;
    vertexCount: number;
    triangleCount: number;
    availableLods: number[];
    reason: string;
  };
  unknownElementTypeIds: string[];
  warnings: string[];
}

export interface JtInspectionArtifacts {
  inspection: JtInspectionResult;
  document: JtDocument;
  hierarchyFileName: "hierarchy.json";
  propertiesFileName: "properties.json";
  inspectionFileName: "inspection.json";
}

/** 读取完整 LSG 元数据；文件大小在分配内存前先受 reader 合同约束。 */
export async function inspectJtFile(filePath: string): Promise<JtInspectionResult> {
  return inspectJtDocument(await readJtFile(filePath));
}

/** 将 reader 文档压缩为可发布检查证据，不把原始顶点数组写入 JSON。 */
export function inspectJtDocument(document: JtDocument): JtInspectionResult {
  const lod0Meshes = document.meshes.filter((mesh) => mesh.lod === 0);
  const lod0MeshIds = new Set(lod0Meshes.map((mesh) => mesh.id));
  const lod0Instances = document.meshInstances.filter((instance) => lod0MeshIds.has(instance.meshId));
  const nodesWithProperties = document.sceneGraph.nodes.filter((node) => Object.keys(node.properties).length > 0);
  const valueCount = nodesWithProperties.reduce((total, node) => total + Object.keys(node.properties).length, 0);
  const materials = document.sceneGraph.nodes.flatMap(materialEvidence);
  const geometryParsed = lod0Meshes.length > 0;
  const geometryReason = geometryParsed
    ? "已读取 TriStrip/TopoMesh 最高精度 LOD0 顶点、索引与面组"
    : "未发现当前 reader 可安全译码的最高精度 LOD0 网格";
  return {
    status: geometryParsed ? "geometry-supported" : "structure-read",
    recognizedFormat: "jt",
    inspectionScope: geometryParsed ? "structure-metadata-and-geometry" : "structure-and-metadata",
    geometryParsed,
    message: `JT ${document.header.majorVersion}.${document.header.minorVersion} 结构已读取；${geometryReason}`,
    header: document.header,
    toc: { entryCount: document.segments.length, segments: document.segments },
    assembly: {
      nodeCount: document.sceneGraph.nodes.length,
      rootObjectIds: document.sceneGraph.rootObjectIds,
      nodes: document.sceneGraph.nodes,
    },
    properties: { atomCount: document.sceneGraph.propertyAtomCount, nodeCount: nodesWithProperties.length, valueCount },
    materials,
    geometry: {
      status: geometryParsed ? "decoded" : "not-decoded",
      meshCount: document.meshes.length,
      lod0MeshCount: lod0Meshes.length,
      lod0InstanceCount: lod0Instances.length,
      vertexCount: lod0Meshes.reduce((total, mesh) => total + mesh.vertexCount, 0),
      triangleCount: lod0Meshes.reduce((total, mesh) => total + mesh.triangleCount, 0),
      availableLods: [...new Set(document.meshes.map((mesh) => mesh.lod))].sort((left, right) => left - right),
      reason: geometryReason,
    },
    unknownElementTypeIds: document.sceneGraph.unknownElementTypeIds,
    warnings: document.warnings,
  };
}

/** 写入结构、属性和网格摘要；是否发布几何仍由 GLB 审计结果决定。 */
export async function writeJtInspectionArtifacts(
  sourcePath: string,
  outputDir: string,
): Promise<JtInspectionArtifacts> {
  const document = await readJtFile(sourcePath);
  const inspection = inspectJtDocument(document);
  await mkdir(outputDir, { recursive: true });
  const hierarchy = buildHierarchy(inspection, path.basename(sourcePath), document.meshes, document.meshInstances);
  const properties = buildProperties(inspection, path.basename(sourcePath), document.meshes, document.meshInstances);
  await Promise.all([
    writeFile(path.join(outputDir, "inspection.json"), JSON.stringify(inspection, null, 2), "utf8"),
    writeFile(path.join(outputDir, "hierarchy.json"), JSON.stringify(hierarchy, null, 2), "utf8"),
    writeFile(path.join(outputDir, "properties.json"), JSON.stringify(properties, null, 2), "utf8"),
  ]);
  return {
    inspection,
    document,
    hierarchyFileName: "hierarchy.json",
    propertiesFileName: "properties.json",
    inspectionFileName: "inspection.json",
  };
}

function buildHierarchy(
  inspection: JtInspectionResult,
  sourceName: string,
  meshes: readonly JtMesh[],
  instances: readonly JtMeshInstance[],
) {
  const byId = new Map(inspection.assembly.nodes.map((node) => [node.objectId, node]));
  const lod0MeshIds = new Set(meshes.filter((mesh) => mesh.lod === 0).map((mesh) => mesh.id));
  const lod0Instances = instances.filter((instance) => lod0MeshIds.has(instance.meshId));
  const build = (objectId: number, ancestors: ReadonlySet<number>, pathIds: number[]): Record<string, unknown> => {
    const node = byId.get(objectId);
    if (!node) return { id: `jt-missing:${objectId}`, name: `缺失节点 ${objectId}`, type: "缺失引用", meshIds: [], children: [] };
    if (ancestors.has(objectId)) return { id: `jt-node:${objectId}`, name: node.label, type: "循环引用", meshIds: [], children: [] };
    const next = new Set(ancestors).add(objectId);
    const currentPath = [...pathIds, objectId];
    return {
      id: `jt-node:${objectId}`,
      name: node.label,
      type: node.kind,
      meshIds: lod0Instances
        .filter((instance) => samePath(instance.pathObjectIds, currentPath))
        .map(jtInstanceElementId),
      children: node.childObjectIds.map((childId) => build(childId, next, currentPath)),
    };
  };
  return {
    schemaVersion: 1,
    root: {
      id: "jt-model:1",
      name: sourceName,
      type: "JT 结构模型",
      meshIds: lod0Instances.map(jtInstanceElementId),
      children: inspection.assembly.rootObjectIds.map((objectId) => build(objectId, new Set(), [])),
    },
  };
}

function buildProperties(
  inspection: JtInspectionResult,
  sourceName: string,
  meshes: readonly JtMesh[],
  instances: readonly JtMeshInstance[],
) {
  const lod0Meshes = meshes.filter((mesh) => mesh.lod === 0);
  const meshById = new Map(lod0Meshes.map((mesh) => [mesh.id, mesh]));
  const lod0Instances = instances.filter((instance) => meshById.has(instance.meshId));
  const nodeEntries = inspection.assembly.nodes.map((node) => [
    `jt-node:${node.objectId}`,
    {
      elementId: `jt-node:${node.objectId}`,
      displayProperties: {
        名称: node.label,
        类型: node.kind,
        对象编号: String(node.objectId),
        子节点数: String(node.childObjectIds.length),
        ...stringProperties(node.properties),
      },
    },
  ] as const);
  const instanceEntries = lod0Instances.map((instance, index) => {
    const mesh = meshById.get(instance.meshId)!;
    return [
      jtInstanceElementId(instance),
      {
        elementId: jtInstanceElementId(instance),
        displayProperties: {
          名称: `JT LOD0 实例 ${index + 1}`,
          类型: "JT 网格实例",
          LOD: "0",
          场景节点: String(instance.sceneNodeObjectId),
          装配路径: instance.pathObjectIds.join(" / "),
          网格标识: instance.meshId,
          顶点数: String(mesh.vertexCount),
          三角面数: String(mesh.triangleCount),
        },
      },
    ] as const;
  });
  return {
    schemaVersion: 1,
    model: {
      sourceFormat: "JT",
      sourceName,
      version: `${inspection.header.majorVersion}.${inspection.header.minorVersion}`,
      segmentCount: inspection.toc.entryCount,
      nodeCount: inspection.assembly.nodeCount,
      propertyAtomCount: inspection.properties.atomCount,
      materialCount: inspection.materials.length,
      geometryStatus: inspection.geometry.status,
      geometryMessage: inspection.geometry.reason,
      selectedLod: inspection.geometryParsed ? 0 : undefined,
      meshCount: lod0Meshes.length,
      instanceCount: lod0Instances.length,
      vertexCount: inspection.geometry.vertexCount,
      triangleCount: inspection.geometry.triangleCount,
    },
    materials: inspection.materials,
    elements: Object.fromEntries([...nodeEntries, ...instanceEntries]),
  };
}

async function readJtFile(filePath: string): Promise<JtDocument> {
  const fileSize = (await stat(filePath)).size;
  if (fileSize <= 0 || fileSize > DEFAULT_JT_READ_LIMITS.maxFileBytes) {
    throw new Error(`JT 文件大小必须在 1 到 ${DEFAULT_JT_READ_LIMITS.maxFileBytes} 字节之间`);
  }
  return readJt(await readFile(filePath));
}

export function jtInstanceElementId(instance: Pick<JtMeshInstance, "id">): string {
  return `jt-instance:${instance.id}`;
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function materialEvidence(node: JtSceneNode): JtMaterialEvidence[] {
  const red = finiteNumber(node.properties["material.diffuseR"]);
  const green = finiteNumber(node.properties["material.diffuseG"]);
  const blue = finiteNumber(node.properties["material.diffuseB"]);
  if (red === undefined || green === undefined || blue === undefined) return [];
  return [{
    objectId: node.objectId,
    diffuse: [red, green, blue],
    opacity: finiteNumber(node.properties["material.opacity"]) ?? 1,
    shininess: finiteNumber(node.properties["material.shininess"]) ?? 0,
    reflectivity: finiteNumber(node.properties["material.reflectivity"]) ?? 0,
  }];
}

function stringProperties(properties: Record<string, JtPropertyValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, String(value)]));
}

function finiteNumber(value: JtPropertyValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
