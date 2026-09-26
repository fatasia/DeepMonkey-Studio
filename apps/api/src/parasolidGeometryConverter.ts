import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import type { ParasolidGeometryExport } from "./parasolidSchemaProbe.js";
import { calculateVertexNormals, createIndexedTrianglePrimitive } from "./indexedTriangleMesh.js";

/**
 * Parasolid schema-aware 几何发布(R1 MVP 三角化,2026-09-26):
 * ps-schema-probe `--geometry` 的 faces(positions/indices,源单位)→ GLB。
 * - 层级:root(模型)→ BODY → FACE(每面一个 mesh,法线由三角面重算);
 * - losses 如实透传探针清单,追加名称/颜色/装配未解码与 trim 近似项;
 * - faces 为空时拒绝发布 —— 绝不 ready 空几何(调用方回落 waiting 语义)。
 */

export interface ParasolidGeometryConversionResult {
  partial: boolean;
  losses: string[];
  approximations: string[];
  meshCount: number;
  triangleCount: number;
  vertexCount: number;
  facesTotal: number;
  facesPublished: number;
  facesSkipped: number;
  bodies: number;
  surfaceKindCounts: Record<string, number>;
}

export interface ParasolidGeometryConversionInput {
  geometry: ParasolidGeometryExport;
  sourcePath: string;
  outputDir: string;
  /** 探针 schema 证据(写入 properties.json 供审计追溯)。 */
  schemaKey?: string;
  modellerVersion?: string;
}

const ROOT_ID = "parasolid-schema-model:1";

export async function convertParasolidGeometryToGlb(
  input: ParasolidGeometryConversionInput,
): Promise<ParasolidGeometryConversionResult> {
  const { geometry, sourcePath, outputDir } = input;
  const faces = geometry.faces.filter((face) => face.indices.length >= 3 && face.positions.length >= 9);
  if (faces.length === 0) {
    throw new Error("schema-aware 几何为空：探针未发布任何可用面，拒绝生成空 GLB");
  }

  const losses = [...geometry.losses];
  const approximations = [...geometry.approximations];
  const hasApproximatedFace = geometry.faces.some((face) => face.approximations.length > 0)
    || geometry.skipped.some((face) => face.reason.startsWith("trim-unresolved:"));
  if (hasApproximatedFace) losses.push("brep.trim.approximated");
  losses.push("entity.names", "entity.colors", "assembly.instance-linkage");
  approximations.push("geometry.normals:computed-vertex-normals");
  approximations.push("orientation:derived-from-sense-flags-double-sided-material");

  const surfaceKindCounts: Record<string, number> = {};
  for (const face of faces) {
    surfaceKindCounts[face.surfaceKind] = (surfaceKindCounts[face.surfaceKind] ?? 0) + 1;
  }

  const gltf = new Document();
  const buffer = gltf.createBuffer("Parasolid schema-aware geometry");
  const material = gltf.createMaterial("Parasolid 通用灰")
    .setBaseColorFactor([0.55, 0.58, 0.62, 1])
    .setMetallicFactor(0.4)
    .setRoughnessFactor(0.4)
    .setDoubleSided(true);
  const scene = gltf.createScene(path.basename(sourcePath));
  const rootNode = gltf.createNode(path.basename(sourcePath)).setExtras({
    ElementId: ROOT_ID,
    NodeType: "Model",
    SourceFormat: "Parasolid",
    ...(input.schemaKey ? { SchemaKey: input.schemaKey } : {}),
    ...(input.modellerVersion ? { ModellerVersion: input.modellerVersion } : {}),
  });
  scene.addChild(rootNode);

  // body 分组(body 缺失时归入未归属组),每组一个 BODY 节点,face 节点挂其下。
  const groups = new Map<string, typeof faces>();
  for (const face of faces) {
    const key = face.body === null || face.body === undefined ? "unassigned" : String(face.body);
    const group = groups.get(key) ?? [];
    group.push(face);
    groups.set(key, group);
  }
  const properties: Record<string, unknown> = {};
  const bodyMeshIds: Array<{ bodyKey: string; meshIds: string[] }> = [];
  let triangleCount = 0;
  let vertexCount = 0;
  for (const [bodyKey, groupFaces] of groups) {
    const assigned = bodyKey !== "unassigned";
    const bodyNodeId = `parasolid-schema-body:${bodyKey}`;
    const bodyNode = gltf
      .createNode(assigned ? `BODY ${Number(bodyKey) + 1}` : "未归属面")
      .setExtras({
        ElementId: bodyNodeId,
        ParentId: ROOT_ID,
        NodeType: "Body",
        SourceFormat: "Parasolid",
      });
    rootNode.addChild(bodyNode);
    const meshIds: string[] = [];
    for (const face of groupFaces) {
      const faceId = `parasolid-schema-face:${face.id}`;
      const name = `${surfaceLabel(face.surfaceKind)} ${face.id}`;
      const positions = new Float32Array(face.positions);
      const indices = new Uint32Array(face.indices);
      const primitive = createIndexedTrianglePrimitive(gltf, buffer, material, {
        positions,
        indices,
        normals: calculateVertexNormals(positions, indices),
      });
      bodyNode.addChild(
        gltf.createNode(name)
          .setMesh(gltf.createMesh(name).addPrimitive(primitive))
          .setExtras({
            ElementId: faceId,
            ParentId: bodyNodeId,
            NodeType: "Face",
            SourceFormat: "Parasolid",
            SurfaceType: face.surfaceKind,
            FaceApproximations: face.approximations,
          }),
      );
      meshIds.push(faceId);
      properties[faceId] = {
        elementId: faceId,
        displayProperties: {
          名称: name,
          类型: surfaceLabel(face.surfaceKind),
          面: face.id,
          三角面数: (indices.length / 3).toLocaleString("zh-CN"),
        },
      };
      triangleCount += indices.length / 3;
      vertexCount += positions.length / 3;
    }
    bodyMeshIds.push({ bodyKey, meshIds });
  }

  await mkdir(outputDir, { recursive: true });
  const binary = await new NodeIO().writeBinary(gltf);
  await Promise.all([
    writeFile(path.join(outputDir, "geometry.glb"), binary),
    writeFile(path.join(outputDir, "hierarchy.json"), JSON.stringify({
      schemaVersion: 1,
      partial: losses.length > 0,
      root: {
        id: ROOT_ID,
        name: path.basename(sourcePath),
        type: "Parasolid 模型",
        metadataSource: "schema-aware B-Rep MVP 三角化(ps-schema-probe --geometry)",
        children: bodyMeshIds.map(({ bodyKey, meshIds }) => ({
          id: `parasolid-schema-body:${bodyKey}`,
          name: bodyKey === "unassigned" ? "未归属面" : `BODY ${Number(bodyKey) + 1}`,
          type: "实体",
          meshIds,
          children: [],
        })),
      },
    }, null, 2), "utf8"),
    writeFile(path.join(outputDir, "properties.json"), JSON.stringify({
      schemaVersion: 1,
      model: {
        sourceFormat: "Parasolid",
        sourceName: path.basename(sourcePath),
        converterScope: "schema-aware B-Rep 逐面三角化(plane/柱/锥/球/环;不支持族如实 losses)",
        ...(input.schemaKey ? { schema: input.schemaKey } : {}),
        ...(input.modellerVersion ? { modellerVersion: input.modellerVersion } : {}),
        units: "source-units-preserved",
        faceStats: geometry.stats,
        budgetExceeded: geometry.budgetExceeded,
        surfaceKindCounts,
        skippedFaces: geometry.skipped,
        partial: losses.length > 0,
        losses,
        approximations,
      },
      elements: properties,
    }, null, 2), "utf8"),
  ]);
  return {
    partial: losses.length > 0,
    losses,
    approximations,
    meshCount: faces.length,
    triangleCount,
    vertexCount,
    facesTotal: geometry.stats.facesTotal,
    facesPublished: faces.length,
    facesSkipped: geometry.stats.facesSkipped,
    bodies: groups.size,
    surfaceKindCounts,
  };
}

const SURFACE_LABELS: Record<string, string> = {
  plane: "平面", cylinder: "圆柱面", cone: "圆锥面", sphere: "球面",
  torus: "圆环面", blended_edge: "过渡面(未三角化)", blend_boundary: "过渡边界(未三角化)",
};

function surfaceLabel(type: string): string {
  return SURFACE_LABELS[type] ?? type;
}
