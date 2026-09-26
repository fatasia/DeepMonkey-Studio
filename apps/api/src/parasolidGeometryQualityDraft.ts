import path from "node:path";
import type { ConversionQualityDraft } from "@bim-studio/contracts";
import { buildReadyQualityChecks } from "./conversionQualityDraft.js";
import type { ParasolidGeometryConversionResult } from "./parasolidGeometryConverter.js";

export interface ParasolidGeometryQualityInput extends ParasolidGeometryConversionResult {
  outputDir: string;
}

/**
 * Parasolid schema-aware 几何发布(R1 MVP 三角化)的 ready 质量草稿。
 * tier=visual-complete;损失逐条来自探针 geometry 导出与转换器实测:
 * 不支持曲面族、trim 近似、名称/颜色/装配未解码如实列出;不虚构覆盖范围。
 */
export async function buildParasolidGeometryReadyQuality(
  input: ParasolidGeometryQualityInput,
): Promise<ConversionQualityDraft> {
  return {
    schemaVersion: 1,
    profileId: "builtin-parasolid-schema-geometry",
    tier: "visual-complete",
    checks: await buildReadyQualityChecks({
      geometry: path.join(input.outputDir, "geometry.glb"),
      structure: path.join(input.outputDir, "hierarchy.json"),
      identity: path.join(input.outputDir, "properties.json"),
      coordinates: path.join(input.outputDir, "inspection.json"),
      // GLB 自包含、无外部引用;依赖维度以几何制品自身哈希作证据。
      dependencies: path.join(input.outputDir, "geometry.glb"),
    }),
    losses: [...input.losses],
    approximations: [...input.approximations],
    metrics: {
      engine: "builtin-parasolid-schema-geometry",
      workerVersion: "1.0.0",
      meshCount: input.meshCount,
      triangleCount: input.triangleCount,
      entityCounts: {
        bodies: input.bodies,
        facesTotal: input.facesTotal,
        facesPublished: input.facesPublished,
        facesSkipped: input.facesSkipped,
        ...input.surfaceKindCounts,
      },
    },
  };
}
