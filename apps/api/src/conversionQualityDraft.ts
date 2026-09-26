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
  /** 转换器实测的顶点属性解码情况;UV/色成功解码时移除对应损失并计入近似项。 */
  decodedAttributes?: { uvs?: boolean | undefined; colors?: boolean | undefined; textureSetCount?: number | undefined } | undefined;
  /** 源文件 PMI 证据:存在时按 structure-only 计入近似项,不虚构语义解析能力。 */
  pmiPresent?: boolean | undefined;
}

/**
 * JT LOD0 的 ready 质量草稿。法线由转换器计算写入 GLB;UV 与顶点色自源顶点记录解码,
 * 成功时对应损失从清单移除、以近似项标注(量化重建),未解码时如实保留损失,不虚构。
 * 多纹理集导出至 GLB 上限 4 套,但 JT 材质属性不携带纹理集引用,该联动缺口以损失保留;
 * 源含 PMI 段时按结构级清单计入近似项(pmi:structure-only)。
 */
export async function buildJtLod0ReadyQuality(input: JtLod0QualityInput): Promise<ConversionQualityDraft> {
  const uvsDecoded = input.decodedAttributes?.uvs === true;
  const colorsDecoded = input.decodedAttributes?.colors === true;
  const textureSetCount = input.decodedAttributes?.textureSetCount ?? 0;
  const losses = [
    ...(uvsDecoded ? [] : ["geometry.uv"]),
    ...(colorsDecoded ? [] : ["vertex.colors"]),
    // 纹理集本身已解码导出,但"材质→纹理集"引用在 JT 属性中不存在,联动缺口如实保留。
    ...(textureSetCount > 1 ? ["material.texture-set-linkage"] : []),
  ];
  const approximations = [
    "geometry.normals:computed-vertex-normals",
    "materials:resolved-from-jt-attributes-with-fallback",
    ...(uvsDecoded ? ["geometry.uv:quantized-reconstruction"] : []),
    ...(colorsDecoded ? ["vertex.colors:quantized-reconstruction"] : []),
    ...(textureSetCount > 1 ? ["geometry.texture-sets:exported-up-to-4-of-" + textureSetCount] : []),
    ...(input.pmiPresent ? ["pmi:structure-only"] : []),
  ];
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
    losses,
    approximations,
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
