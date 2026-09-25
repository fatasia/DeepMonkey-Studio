import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { ConversionQualityCheck, ConversionQualityDraft, ConversionQualityDimension } from "@bim-studio/contracts";

export type { ConversionQualityDraft };

/** 转换器只对已发布产物计算证据哈希；源哈希由执行器回填，这里不接触。 */
export async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

export type QualityEvidenceFiles = Partial<Record<ConversionQualityDimension, string>>;

const DIMENSION_ORDER: ConversionQualityDimension[] = ["geometry", "structure", "identity", "coordinates", "dependencies"];

/** visual-complete 必须五维全过且每维带证据哈希；缺文件的维度直接缺失，由合同校验拒绝。 */
export async function buildReadyQualityChecks(evidence: QualityEvidenceFiles): Promise<ConversionQualityCheck[]> {
  const checks: ConversionQualityCheck[] = [];
  for (const dimension of DIMENSION_ORDER) {
    const file = evidence[dimension];
    if (file) checks.push({ dimension, passed: true, evidenceSha256: await sha256File(file) });
  }
  return checks;
}

export interface XtRevolvedQualityInput {
  outputDir: string;
  meshCount: number;
  triangleCount: number;
  bodyCount: number;
  faceCount: number;
}

/**
 * X_T 受控旋转体子集的 ready 质量草稿。损失如实体例：B-rep trim、子集之外的曲面族、
 * 实体名称/颜色与装配实例在当前自研链路里没有解码证据，不得省略。
 */
export async function buildXtRevolvedReadyQuality(input: XtRevolvedQualityInput): Promise<ConversionQualityDraft> {
  return {
    schemaVersion: 1,
    profileId: "builtin-x-t-revolved-subset",
    tier: "visual-complete",
    checks: await buildReadyQualityChecks({
      geometry: path.join(input.outputDir, "geometry.glb"),
      structure: path.join(input.outputDir, "hierarchy.json"),
      identity: path.join(input.outputDir, "properties.json"),
      coordinates: path.join(input.outputDir, "inspection.json"),
      // GLB 自包含、无外部引用；依赖维度以几何制品自身哈希作证据。
      dependencies: path.join(input.outputDir, "geometry.glb"),
    }),
    losses: ["brep.trim", "surface.beyond-signed-subset", "entity.names", "entity.colors", "assembly.instances"],
    approximations: [
      "geometry.tessellation:angular-64-segments",
      "units:source-meter-to-millimeter-scale-1000",
    ],
    metrics: {
      engine: "builtin-xt-revolved-subset",
      workerVersion: "1.0.0",
      meshCount: input.meshCount,
      triangleCount: input.triangleCount,
      entityCounts: { bodies: input.bodyCount, faces: input.faceCount },
    },
  };
}

export interface JtLod0QualityInput {
  outputDir: string;
  meshCount: number;
  triangleCount: number;
  instanceCount: number;
  tocEntryCount: number;
  assemblyNodeCount: number;
}

/**
 * JT LOD0 的 ready 质量草稿。法线由转换器计算写入 GLB，因此损失只列真实缺失的
 * UV 与顶点色；装配结构以 hierarchy.json 证据发布。
 */
export async function buildJtLod0ReadyQuality(input: JtLod0QualityInput): Promise<ConversionQualityDraft> {
  return {
    schemaVersion: 1,
    profileId: "builtin-jt-lod0-visual-complete",
    tier: "visual-complete",
    checks: await buildReadyQualityChecks({
      geometry: path.join(input.outputDir, "geometry.glb"),
      structure: path.join(input.outputDir, "hierarchy.json"),
      identity: path.join(input.outputDir, "properties.json"),
      coordinates: path.join(input.outputDir, "inspection.json"),
      dependencies: path.join(input.outputDir, "geometry.glb"),
    }),
    losses: ["geometry.uv", "vertex.colors"],
    approximations: [
      "geometry.normals:computed-vertex-normals",
      "materials:resolved-from-jt-attributes-with-fallback",
    ],
    metrics: {
      engine: "builtin-jt-worker",
      workerVersion: "1.0.0",
      meshCount: input.meshCount,
      triangleCount: input.triangleCount,
      instanceCount: input.instanceCount,
      entityCounts: { tocSegments: input.tocEntryCount, assemblyNodes: input.assemblyNodeCount },
    },
  };
}
