import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  buildCylinderFromCoaxialCircles,
  inferCylinderSpanFromCircles,
  parseXtTextDocument,
  tessellateCylinderPatch,
  tessellateSphere,
  type XtCylinderSurface,
  type XtGenericDocument,
  type XtTriangleMesh,
} from "@bim-studio/xt-reader";
import { createIndexedTrianglePrimitive } from "./indexedTriangleMesh.js";

export interface XtGenericConversionResult {
  partial: boolean;
  losses: string[];
  approximations: string[];
  meshCount: number;
  triangleCount: number;
  vertexCount: number;
  familyCounts: {
    circles: number;
    planes: number;
    cylinders: number;
    cones: number;
    spheres: number;
    tori: number;
    transforms: number;
  };
  schema?: string;
  encodingClass: string;
}

interface GenericMesh {
  id: string;
  mesh: XtTriangleMesh;
  source: string;
  surfaceType: string;
}

/**
 * 通用 X_T 文本转换：只发布可解析且几何自洽的实体，命中不了的族如实记入 losses。
 * 坐标保持源单位（不做未经验证的缩放），层级只建一层 PART，变换仅记录不虚构挂接。
 */
export async function convertXtGenericTextToGlb(
  sourcePath: string,
  outputDir: string,
): Promise<XtGenericConversionResult> {
  const document = parseXtTextDocument(await readFile(sourcePath));
  const meshes = collectMeshes(document);
  const losses = collectLosses(document, meshes);
  const approximations = collectApproximations(document, meshes);

  const gltf = new Document();
  const buffer = gltf.createBuffer("X_T generic geometry");
  const material = gltf.createMaterial("X_T 通用灰")
    .setBaseColorFactor([0.52, 0.56, 0.61, 1])
    .setMetallicFactor(0.35)
    .setRoughnessFactor(0.42)
    .setDoubleSided(true);
  const scene = gltf.createScene(path.basename(sourcePath));
  const partNode = gltf.createNode("PART 1").setExtras({
    ElementId: "x_t-generic-part:1",
    NodeType: "Part",
    SourceFormat: "X_T",
    TransformRecords: document.transforms.length,
  });
  scene.addChild(partNode);

  const properties: Record<string, unknown> = {};
  meshes.forEach((entry, index) => {
    const name = `${surfaceLabel(entry.surfaceType)} ${index + 1}`;
    const primitive = createIndexedTrianglePrimitive(gltf, buffer, material, entry.mesh);
    partNode.addChild(gltf.createNode(name).setMesh(gltf.createMesh(name).addPrimitive(primitive)).setExtras({
      ElementId: entry.id,
      ParentId: "x_t-generic-part:1",
      NodeType: "Face",
      SourceFormat: "X_T",
      SurfaceType: entry.surfaceType,
      ParseSource: entry.source,
    }));
    properties[entry.id] = {
      elementId: entry.id,
      displayProperties: {
        名称: name,
        类型: surfaceLabel(entry.surfaceType),
        来源: entry.source,
        三角面数: entry.mesh.triangleCount.toLocaleString("zh-CN"),
      },
    };
  });

  await mkdir(outputDir, { recursive: true });
  const binary = await new NodeIO().writeBinary(gltf);
  const triangleCount = meshes.reduce((total, entry) => total + entry.mesh.triangleCount, 0);
  const vertexCount = meshes.reduce((total, entry) => total + entry.mesh.positions.length / 3, 0);
  const familyCounts = {
    circles: document.circles.length,
    planes: document.planes.length,
    cylinders: document.cylinders.length,
    cones: document.cones.length,
    spheres: document.spheres.length,
    tori: document.tori.length,
    transforms: document.transforms.length,
  };
  await Promise.all([
    writeFile(path.join(outputDir, "geometry.glb"), binary),
    writeFile(path.join(outputDir, "hierarchy.json"), JSON.stringify({
      schemaVersion: 1,
      partial: losses.length > 0,
      root: {
        id: "x_t-generic-model:1",
        name: path.basename(sourcePath),
        type: "X_T 模型",
        metadataSource: "通用文本解析(校验门控)",
        children: [{
          id: "x_t-generic-part:1",
          name: "PART 1",
          type: "实体",
          meshIds: meshes.map((entry) => entry.id),
          children: [],
        }],
      },
    }, null, 2), "utf8"),
    writeFile(path.join(outputDir, "properties.json"), JSON.stringify({
      schemaVersion: 1,
      model: {
        sourceFormat: "X_T",
        sourceName: path.basename(sourcePath),
        converterScope: "自研通用文本解析(平面/圆柱/圆锥/球/圆边/圆环/变换,校验门控)",
        encodingClass: document.header.encodingClass,
        ...(document.header.identificationSchema ? { schema: document.header.identificationSchema } : {}),
        ...(document.header.application ? { application: document.header.application } : {}),
        header: document.header,
        familyCounts,
        units: "source-units-preserved",
        transforms: document.transforms,
        transformLinkage: "not-applied-owner-linkage-unverified",
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
    meshCount: meshes.length,
    triangleCount,
    vertexCount,
    familyCounts,
    ...(document.header.identificationSchema ? { schema: document.header.identificationSchema } : {}),
    encodingClass: document.header.encodingClass,
  };
}

const SURFACE_LABELS: Record<string, string> = {
  plane: "平面", cylinder: "圆柱面", cone: "圆锥面", sphere: "球面", torus: "圆环面", circle: "圆边",
};

function surfaceLabel(type: string): string {
  return SURFACE_LABELS[type] ?? type;
}

/** 只发布有诚实 extent 依据的几何：球自带范围；圆柱需要柱面记录+同轴圆边，或一对同轴圆边重构。 */
function collectMeshes(document: XtGenericDocument): GenericMesh[] {
  const meshes: GenericMesh[] = [];
  const usedCircleIds = new Set<number>();
  for (const sphere of document.spheres) {
    meshes.push({
      id: `x_t-generic-sphere:${sphere.entityId}`,
      mesh: tessellateSphere(sphere),
      source: "sphere-record",
      surfaceType: "sphere",
    });
  }
  for (const cylinder of document.cylinders) {
    const span = inferCylinderSpanFromCircles(cylinder, document.circles);
    if (!span) continue;
    markCircles(document, cylinder, usedCircleIds);
    meshes.push({
      id: `x_t-generic-cylinder:${cylinder.entityId}`,
      mesh: tessellateCylinderPatch(cylinder, span),
      source: "cylinder-record+coaxial-circles",
      surfaceType: "cylinder",
    });
  }
  const remaining = document.circles.filter((circle) => !usedCircleIds.has(circle.entityId));
  for (let first = 0; first < remaining.length; first += 1) {
    for (let second = first + 1; second < remaining.length; second += 1) {
      const reconstructed = buildCylinderFromCoaxialCircles(remaining[first]!, remaining[second]!);
      if (!reconstructed) continue;
      usedCircleIds.add(remaining[first]!.entityId);
      usedCircleIds.add(remaining[second]!.entityId);
      meshes.push({
        id: `x_t-generic-cylinder-r:${reconstructed.entityId}`,
        mesh: tessellateCylinderPatch(reconstructed, reconstructed.span),
        source: "reconstructed-from-coaxial-circles",
        surfaceType: "cylinder",
      });
    }
  }
  return meshes;
}

function markCircles(document: XtGenericDocument, cylinder: XtCylinderSurface, used: Set<number>): void {
  for (const circle of document.circles) {
    if (Math.abs(circle.radius - cylinder.radius) < 1e-7
      && Math.abs(circle.axis[0] * cylinder.axis[0] + circle.axis[1] * cylinder.axis[1] + circle.axis[2] * cylinder.axis[2]) > 1 - 1e-6) {
      used.add(circle.entityId);
    }
  }
}

function collectLosses(document: XtGenericDocument, meshes: GenericMesh[]): string[] {
  const losses: string[] = [];
  if (document.planes.length) losses.push("surface.plane:untrimmed-extent-unknown");
  if (document.cones.length) losses.push("surface.cone:axial-extent-unknown");
  if (document.tori.length) losses.push("surface.torus:arc-extent-unknown");
  if (document.header.encodingClass === "legacy-baseline") {
    losses.push("encoding.legacy-baseline:sch-901000-framing-unsupported");
  }
  losses.push("brep.trim", "entity.names", "entity.colors", "assembly.instance-linkage");
  return losses;
}

function collectApproximations(document: XtGenericDocument, meshes: GenericMesh[]): string[] {
  const approximations: string[] = [];
  if (meshes.some((entry) => entry.source === "reconstructed-from-coaxial-circles")) {
    approximations.push("surface.cylinder:reconstructed-from-coaxial-circle-pairs");
  }
  if (document.spheres.length > 0) approximations.push("surface.sphere:low-confidence-framing");
  approximations.push("geometry.tessellation:angular-64-segments");
  return approximations;
}
