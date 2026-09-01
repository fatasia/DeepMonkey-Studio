import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { createIndexedTrianglePrimitive } from "./indexedTriangleMesh.js";
import { buildXtRevolvedMesh, type XtFaceMesh } from "./xtRevolvedMesh.js";
import { parseXtRevolvedSubset } from "./xtTextSubsetParser.js";

export interface XtTextSubsetConversionResult {
  bodyCount: number;
  faceCount: number;
  meshCount: number;
  triangleCount: number;
  vertexCount: number;
  schema: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** 将受支持的 X_T 文本旋转体写成可独立浏览的 GLB 与选择元数据。 */
export async function convertXtTextSubsetToGlb(
  sourcePath: string,
  outputDir: string,
): Promise<XtTextSubsetConversionResult> {
  const subset = parseXtRevolvedSubset(await readFile(sourcePath));
  const geometry = buildXtRevolvedMesh(subset);
  const document = new Document();
  const buffer = document.createBuffer("X_T geometry");
  const sourceName = sourceDisplayName(subset.header.sourceFileName, sourcePath);
  const scene = document.createScene(sourceName);
  const bodyId = "x_t-body:1";
  const bodyNode = document.createNode("旋转体 1").setExtras({
    ElementId: bodyId,
    NodeType: "Body",
    SourceFormat: "X_T",
    Schema: subset.schema,
    SourceName: sourceName,
    EntityNameSource: "Generated",
    面数: String(subset.faceCount),
  });
  const material = document.createMaterial("X_T 工业灰")
    .setBaseColorFactor([0.52, 0.56, 0.61, 1])
    .setMetallicFactor(0.35)
    .setRoughnessFactor(0.42)
    .setDoubleSided(true);

  const properties: Record<string, unknown> = {};
  geometry.faces.forEach((face, index) => {
    const name = `面 ${index + 1}`;
    const mesh = createFaceMesh(document, buffer, material, face, name);
    bodyNode.addChild(document.createNode(name).setMesh(mesh).setExtras({
      ElementId: face.id,
      ParentId: bodyId,
      NodeType: "Face",
      SourceFormat: "X_T",
      SurfaceType: face.surfaceType,
    }));
    properties[face.id] = {
      elementId: face.id,
      displayProperties: {
        名称: name,
        类型: surfaceLabel(face.surfaceType),
        所属实体: "旋转体 1",
        源轮廓实体索引: face.sourceEntityIds.join(" → "),
        三角面数: face.triangleCount.toLocaleString("zh-CN"),
      },
    };
  });
  scene.addChild(bodyNode);
  await mkdir(outputDir, { recursive: true });
  const binary = await new NodeIO().writeBinary(document);
  const result: XtTextSubsetConversionResult = {
    bodyCount: subset.bodyCount,
    faceCount: subset.faceCount,
    meshCount: geometry.faces.length,
    triangleCount: geometry.triangleCount,
    vertexCount: geometry.vertexCount,
    schema: subset.schema,
    bounds: geometry.bounds,
  };
  await Promise.all([
    writeFile(path.join(outputDir, "geometry.glb"), binary),
    writeFile(path.join(outputDir, "hierarchy.json"), JSON.stringify({
      schemaVersion: 1,
      root: {
        id: "x_t-model:1",
        name: sourceName,
        type: "X_T 模型",
        metadataSource: "文件头与已验证拓扑",
        children: [{
          id: bodyId,
          name: "旋转体 1",
          type: "实体",
          meshIds: geometry.faces.map((face) => face.id),
          children: geometry.faces.map((face, index) => ({
            id: face.id,
            name: `面 ${index + 1}`,
            type: surfaceLabel(face.surfaceType),
            meshIds: [face.id],
            children: [],
          })),
        }],
      },
    }, null, 2), "utf8"),
    writeFile(path.join(outputDir, "properties.json"), JSON.stringify({
      schemaVersion: 1,
      model: {
        sourceFormat: "X_T",
        sourceName,
        schema: subset.schema,
        application: subset.application,
        header: subset.header,
        bodyCount: subset.bodyCount,
        faceCount: subset.faceCount,
        sourceFaceEntityIds: subset.faceEntityIds,
        meshCount: result.meshCount,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        units: subset.outputUnits,
        converterScope: "自研 V24.1 单体共轴旋转体子集",
        entityMetadata: {
          names: "generated-labels",
          colors: "not-decoded",
          properties: "header-only",
          material: "generated-default",
        },
        limitations: subset.limitations,
      },
      elements: properties,
    }, null, 2), "utf8"),
  ]);
  return result;
}

function sourceDisplayName(headerName: string | undefined, sourcePath: string): string {
  const candidate = headerName?.trim();
  if (!candidate || candidate.length > 180 || /[\u0000-\u001f]/.test(candidate)) return path.basename(sourcePath);
  return path.win32.basename(candidate).slice(0, 180);
}

function createFaceMesh(
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  material: ReturnType<Document["createMaterial"]>,
  face: XtFaceMesh,
  name: string,
) {
  const primitive = createIndexedTrianglePrimitive(document, buffer, material, face);
  return document.createMesh(name).addPrimitive(primitive);
}

function surfaceLabel(type: XtFaceMesh["surfaceType"]): string {
  return { plane: "平面", cylinder: "圆柱面", cone: "圆锥面", torus: "圆环过渡面" }[type];
}
