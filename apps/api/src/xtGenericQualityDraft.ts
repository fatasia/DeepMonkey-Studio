import path from "node:path";
import type { ConversionQualityDraft } from "@bim-studio/contracts";
import { buildReadyQualityChecks } from "./conversionQualityDraft.js";
import type { XtGenericConversionResult } from "./xtGenericConverter.js";

export interface XtGenericQualityInput extends XtGenericConversionResult {
  outputDir: string;
}

/**
 * X_T 通用文本解析(降级档)的 ready 质量草稿。
 * 损失逐条来自 xt-reader / 转换器的真实返回:未发布几何的曲面族、trim、名称、
 * 颜色与装配挂接如实列出;metrics 记录实体族命中数与实际发布网格数,不虚构覆盖范围。
 */
export async function buildXtGenericReadyQuality(input: XtGenericQualityInput): Promise<ConversionQualityDraft> {
  return {
    schemaVersion: 1,
    profileId: "builtin-x-t-generic-visual-complete",
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
      engine: "builtin-xt-generic",
      workerVersion: "1.0.0",
      meshCount: input.meshCount,
      triangleCount: input.triangleCount,
      entityCounts: { ...input.familyCounts, publishedMeshes: input.meshCount },
    },
  };
}
