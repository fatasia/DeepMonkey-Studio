import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelManifest, ModelRecord } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";
import { createParasolidProbeRunner, type ParasolidProbeConfig, type ParasolidProbeReport, type ParasolidProbeRunner } from "./parasolidSchemaProbe.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { auditConverterOutput } from "./converterOutputAudit.js";
import { convertXtTextSubsetToGlb } from "./xtTextSubsetConverter.js";
import { writeXtTextInspectionArtifact, type XtTextInspectionResult } from "./xtTextInspection.js";
import { convertXtGenericTextToGlb, type XtGenericConversionResult } from "./xtGenericConverter.js";
import { buildXtGenericReadyQuality } from "./xtGenericQualityDraft.js";
import { convertParasolidGeometryToGlb } from "./parasolidGeometryConverter.js";
import { buildParasolidGeometryReadyQuality } from "./parasolidGeometryQualityDraft.js";
import { buildXtRevolvedReadyQuality } from "./conversionQualityDraft.js";
import type { ConversionContext, ConversionProvider } from "./conversion.js";
import { assetUrl, assetKey, createLodResources, createManifest, writeManifest } from "./conversionManifest.js";

export interface ParasolidProbeRuntime {
  config: ParasolidProbeConfig;
  run: ParasolidProbeRunner;
}

export function createParasolidProbeRuntime(config: AppConfig): ParasolidProbeRuntime | undefined {
  const probe = config.parasolidProbe;
  if (!probe) return undefined;
  return { config: probe, run: createParasolidProbeRunner(probe) };
}

const BUILTIN_XT_RESEARCH_SCHEMA_KEY = "SCH_3000000_30000";
const BUILTIN_XT_RESEARCH_PROFILE_ID = "builtin:onshape-sch30000-r3";

export class XtTextSubsetProvider implements ConversionProvider {
  readonly supportsGeneralImport = false;
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly probe?: ParasolidProbeRuntime,
  ) {}

  /**
   * 三档决策树（同一 Provider 内部 fallback，不新建 Provider）：
   * 1. 命中已签署 V24.1 旋转体子集 → 原样走受控旋转体路径（行为逐字节不变）。
   * 2. 子集解析拒绝且 inspection 几何未解析 → 先尝试自研通用文本解析降级档：
   *    - 发布出 ≥1 个可审计网格 → ready(visual-complete)，losses 如实来自 xt-reader；
   *    - 0 个可发布面片（含 legacy-baseline 编码）→ 保持 waiting_converter，
   *      inspection 附 generic-parse 实体 census，绝不 ready 空几何。
   * 3. 通用降级也失败或未命中面片，且部署方配置了 schema catalog + 探针 CLI →
   *    第三档 schema-aware（parasolid-core 权威解码）：节点类型计数与
   *    face/loop/edge/vertex 拓扑计数入 inspection.genericParse.schemaAware；
   *    R1 起 `--geometry` 额外请求逐面三角网格 —— 发布 ≥1 个面 → ready
   *    (visual-complete, MVP 三角化, losses 含不支持族/trim 近似)；
   *    0 个面或探针未提供 geometry → 维持 waiting_converter + 证据。
   *    探针未配置或失败时完全回落到既有语义。
   */
  async convert({ model, modelDir, sourcePath, reportQuality }: ConversionContext): Promise<void> {
    const outputDir = path.join(modelDir, "output");
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: "正在读取 X_T 版本、文件头和可验证几何能力",
    });
    const inspection = await writeXtTextInspectionArtifact(sourcePath, outputDir);
    const inspectionUrl = assetUrl(model.projectId, model.id, "output/inspection.json");
    // The builtin probe is inspection-only until independent real geometry
    // establishes this exact key's visual-complete profile. Legacy catalog
    // remains the only schema-aware geometry publication path.
    if (this.probe && inspection.status === "invalid") {
      const builtin = await this.runBuiltinResearchProbe(sourcePath, inspection.schema);
      if (builtin) {
        const recognizedInspection = inspection.status === "invalid"
          ? { ...inspection, status: "structure-read" as const, schema: builtin.schemaKey, issues: [] }
          : inspection;
        await this.publishSchemaAwareWaiting(model, modelDir, outputDir, inspectionUrl, recognizedInspection, builtin);
        return;
      }
    }
    if (!inspection.geometryParsed) {
      const fallback = await this.tryGenericFallback(sourcePath, outputDir, inspection);
      if (fallback.result && fallback.result.meshCount > 0) {
        await this.publishGenericReady(model, modelDir, outputDir, inspectionUrl, fallback.result, reportQuality);
        return;
      }
      if (fallback.error) {
        const schemaAware = inspection.status === "invalid" ? undefined : await this.runSchemaAwareProbe(sourcePath);
        if (schemaAware) {
          const geometryPublished = await this.tryPublishSchemaAwareGeometry(
            model, modelDir, outputDir, sourcePath, inspectionUrl, schemaAware, reportQuality, fallback.error,
          );
          if (geometryPublished) return;
          await this.publishSchemaAwareWaiting(model, modelDir, outputDir, inspectionUrl, inspection, schemaAware, fallback.error);
          return;
        }
        await this.publishUnconverted(model, modelDir, inspectionUrl, inspection, fallback.error);
        return;
      }
      const schemaAware = inspection.status === "invalid" ? undefined : await this.runSchemaAwareProbe(sourcePath);
      if (schemaAware) {
        const geometryPublished = await this.tryPublishSchemaAwareGeometry(
          model, modelDir, outputDir, sourcePath, inspectionUrl, schemaAware, reportQuality,
        );
        if (geometryPublished) return;
        await this.publishSchemaAwareWaiting(model, modelDir, outputDir, inspectionUrl, inspection, schemaAware);
        return;
      }
      await this.publishGenericWaiting(model, modelDir, outputDir, inspectionUrl, inspection, fallback);
      return;
    }
    const result = await convertXtTextSubsetToGlb(sourcePath, outputDir);
    const geometryPath = path.join(outputDir, "geometry.glb");
    await auditConverterOutput(outputDir, true);
    const lods = await createLodResources(geometryPath, model);
    const manifest: ModelManifest = {
      ...createManifest(
        model,
        "gltf",
        assetUrl(model.projectId, model.id, "output/geometry.glb"),
        assetUrl(model.projectId, model.id, "output/hierarchy.json"),
        assetUrl(model.projectId, model.id, "output/properties.json"),
        lods,
      ),
      inspectionUrl,
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    // 质量声明基于已发布产物：转换器先把 sidecar 与 GLB 写完再计算证据哈希。
    reportQuality?.(await buildXtRevolvedReadyQuality({
      outputDir,
      meshCount: result.meshCount,
      triangleCount: result.triangleCount,
      bodyCount: result.bodyCount,
      faceCount: result.faceCount,
    }));
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: `X_T 旋转体转换完成：${result.faceCount} 个面，${result.triangleCount.toLocaleString("zh-CN")} 个三角面`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
    });
  }

  /** 精确 key 的内置研发读取：只落 inspection，合成输入不进入 ready。 */
  private async runBuiltinResearchProbe(sourcePath: string, inspectedKey?: string): Promise<ParasolidProbeReport | undefined> {
    const probe = this.probe;
    if (!probe || (inspectedKey && inspectedKey !== BUILTIN_XT_RESEARCH_SCHEMA_KEY)) return undefined;
    try {
      const run = createParasolidProbeRunner({ command: probe.config.command,
        ...(probe.config.args ? { args: probe.config.args } : {}), builtinProfile: true });
      const report = await run({ filePath: sourcePath, brep: true, geometry: true });
      if (report.sourceFormat !== "x_t" || report.schemaKey !== BUILTIN_XT_RESEARCH_SCHEMA_KEY
        || report.catalog?.schemaId !== BUILTIN_XT_RESEARCH_PROFILE_ID) return undefined;
      return report;
    } catch {
      // Unmatched key, invalid header/topology and older CLI all retain their
      // existing inspect/fallback decision. No synthetic geometry publication.
      return undefined;
    }
  }

  /**
   * 第三档 schema-aware：仅当部署方配置了 schema catalog（探针 CLI 存在）时启用。
   * R1 起同时请求 `--geometry` 三角网格；任何失败都收敛为 undefined，
   * 完全回落到既有语义，不影响原决策树。
   */
  private async runSchemaAwareProbe(sourcePath: string): Promise<ParasolidProbeReport | undefined> {
    const probe = this.probe;
    if (!probe?.config.schemaCatalog) return undefined;
    try {
      return await probe.run({ filePath: sourcePath, brep: true, geometry: true });
    } catch (error) {
      console.warn("ps-schema-probe schema-aware 请求失败，维持既有等待语义", error);
      return undefined;
    }
  }

  /**
   * schema-aware 几何发布（R1 MVP）：探针发布 ≥1 个面 → GLB + audit/LOD/quality 链，
   * 状态 ready(visual-complete)。返回 false 时调用方维持既有 waiting 语义。
   */
  private async tryPublishSchemaAwareGeometry(
    model: ModelRecord,
    modelDir: string,
    outputDir: string,
    sourcePath: string,
    inspectionUrl: string,
    schemaAware: ParasolidProbeReport,
    reportQuality: ConversionContext["reportQuality"],
    genericError?: string,
  ): Promise<boolean> {
    if (schemaAware.catalog?.schemaId === BUILTIN_XT_RESEARCH_PROFILE_ID) return false;
    if (!schemaAware.geometry?.faces?.length) return false;
    await publishParasolidGeometryReady({
      store: this.store,
      objects: this.objects,
      model,
      modelDir,
      outputDir,
      sourcePath,
      report: schemaAware,
      reportQuality,
      format: "x_t",
      inspectionUrl,
      inspectionExtras: {
        geometryParsed: true,
        genericParse: {
          scope: "record-anchor-census-may-include-false-positives",
          ...(genericError ? { genericError } : {}),
          schemaAware: parasolidSchemaAwareEvidence(schemaAware),
        },
      },
    });
    return true;
  }

  /**
   * schema-aware 等待发布：权威结构证据入 inspection，状态保持 waiting_converter。
   * 几何 GLB 发布需要 B-Rep 三角化（R1），本期刻意不产出 geometry.glb。
   */
  private async publishSchemaAwareWaiting(
    model: ModelRecord,
    modelDir: string,
    outputDir: string,
    inspectionUrl: string,
    inspection: XtTextInspectionResult,
    schemaAware: ParasolidProbeReport,
    genericError?: string,
  ): Promise<void> {
    const inspectionWithEvidence = {
      ...inspection,
      genericParse: {
        scope: "record-anchor-census-may-include-false-positives",
        ...(genericError ? { genericError } : {}),
        schemaAware: parasolidSchemaAwareEvidence(schemaAware),
      },
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "inspection.json"), JSON.stringify(inspectionWithEvidence, null, 2), "utf8");
    const manifest: ModelManifest = {
      schemaVersion: 1,
      modelId: model.id,
      sourceName: model.name,
      sourceFormat: "x_t",
      inspectionUrl,
      createdAt: new Date().toISOString(),
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    await this.store.updateModel(model.projectId, model.id, {
      status: "waiting_converter",
      progress: 40,
      message: schemaAwareWaitingMessage(schemaAware, genericError),
    });
  }

  /** 通用降级档：任何失败都收敛为结果对象，不把异常抛回原失败语义之外。 */
  private async tryGenericFallback(
    sourcePath: string,
    outputDir: string,
    inspection: XtTextInspectionResult,
  ): Promise<{ result?: XtGenericConversionResult; error?: string; census?: Record<string, number> }> {
    try {
      const result = await convertXtGenericTextToGlb(sourcePath, outputDir);
      if (result.meshCount === 0) {
        // 绝不 ready 空几何：撤掉通用转换器生成的空 GLB，census 留在 inspection 证据里。
        await rm(path.join(outputDir, "geometry.glb"), { force: true });
        const census = await genericParseCensus(sourcePath);
        return { ...(census ? { census } : {}) };
      }
      return { result };
    } catch (error) {
      const genericReason = error instanceof Error ? error.message : String(error);
      return { error: mergeFailureReasons(inspection, genericReason) };
    }
  }

  private async publishGenericReady(
    model: ModelRecord,
    modelDir: string,
    outputDir: string,
    inspectionUrl: string,
    result: XtGenericConversionResult,
    reportQuality: ConversionContext["reportQuality"],
  ): Promise<void> {
    await auditConverterOutput(outputDir, true);
    const lods = await createLodResources(path.join(outputDir, "geometry.glb"), model);
    const manifest: ModelManifest = {
      ...createManifest(
        model,
        "gltf",
        assetUrl(model.projectId, model.id, "output/geometry.glb"),
        assetUrl(model.projectId, model.id, "output/hierarchy.json"),
        assetUrl(model.projectId, model.id, "output/properties.json"),
        lods,
      ),
      inspectionUrl,
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    reportQuality?.(await buildXtGenericReadyQuality({ outputDir, ...result }));
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: `X_T 通用解析完成（降级档）：${result.meshCount} 个网格，${result.triangleCount.toLocaleString("zh-CN")} 个三角面，${result.losses.length} 项如实损失`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
    });
  }

  private async publishGenericWaiting(
    model: ModelRecord,
    modelDir: string,
    outputDir: string,
    inspectionUrl: string,
    inspection: XtTextInspectionResult,
    fallback: { census?: Record<string, number> },
  ): Promise<void> {
    // census 只存在于通用降级等待分支：V24.1 子集路径的 inspection 内容保持不变。
    const inspectionWithCensus = {
      ...inspection,
      genericParse: {
        scope: "record-anchor-census-may-include-false-positives",
        ...(fallback.census ? { census: fallback.census } : {}),
      },
    };
    await writeFile(path.join(outputDir, "inspection.json"), JSON.stringify(inspectionWithCensus, null, 2), "utf8");
    const manifest: ModelManifest = {
      schemaVersion: 1,
      modelId: model.id,
      sourceName: model.name,
      sourceFormat: "x_t",
      inspectionUrl,
      createdAt: new Date().toISOString(),
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    const censusSummary = fallback.census
      ? Object.entries(fallback.census).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([classId, count]) => `class ${classId} ×${count}`).join("、")
      : "无记录锚点";
    await this.store.updateModel(model.projectId, model.id, {
      status: "waiting_converter",
      progress: 40,
      message: `X_T ${inspection.schema ?? "未知 schema"} 头部已读取；通用解析未命中可发布几何（${censusSummary}）`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
    });
  }

  /** 通用降级也失败：维持原 failed/waiting 语义，错误信息合并两个解析器的原因。 */
  private async publishUnconverted(
    model: ModelRecord,
    modelDir: string,
    inspectionUrl: string,
    inspection: XtTextInspectionResult,
    mergedReason: string,
  ): Promise<void> {
    const manifest: ModelManifest = {
      schemaVersion: 1,
      modelId: model.id,
      sourceName: model.name,
      sourceFormat: "x_t",
      inspectionUrl,
      createdAt: new Date().toISOString(),
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    const invalid = inspection.status === "invalid";
    await this.store.updateModel(model.projectId, model.id, {
      status: invalid ? "failed" : "waiting_converter",
      progress: invalid ? 100 : 40,
      message: invalid
        ? `X_T 文件结构无效：${mergedReason}`
        : `X_T ${inspection.schema ?? "未知 schema"} 头部已读取；未生成几何：${mergedReason}`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
    });
  }
}

/** inspection 附加证据：通用解析的记录锚点 census（可能含误报，仅用于观察）。 */
async function genericParseCensus(sourcePath: string): Promise<Record<string, number> | undefined> {
  try {
    const { parseXtTextDocument } = await import("@bim-studio/xt-reader");
    const { readFile } = await import("node:fs/promises");
    return parseXtTextDocument(await readFile(sourcePath)).census;
  } catch {
    return undefined;
  }
}

function mergeFailureReasons(inspection: XtTextInspectionResult, genericReason: string): string {
  const subsetReason = inspection.geometry.reason;
  return subsetReason === genericReason ? subsetReason : `${subsetReason}；通用解析：${genericReason}`;
}

/** inspection 附加证据：ps-schema-probe 权威解码结果（census + B-Rep 拓扑 + 可选几何）。 */
function parasolidSchemaAwareEvidence(report: ParasolidProbeReport): Record<string, unknown> {
  const geometry = report.geometry;
  const geometryPublished = (geometry?.faces?.length ?? 0) > 0;
  const researchBuiltin = report.catalog?.schemaId === BUILTIN_XT_RESEARCH_PROFILE_ID;
  return {
    source: report.tool,
    probeVersion: report.version,
    mode: report.mode,
    schemaKey: report.schemaKey,
    modellerVersion: report.modellerVersion,
    ...(report.catalog ? { catalog: report.catalog } : {}),
    ...(report.census ? {
      recordCount: report.census.recordCount,
      nodeTypeCounts: report.census.nodeTypeCounts,
    } : {}),
    ...(report.brep ? { brep: report.brep } : {}),
    ...(geometry ? {
      geometry: {
        stats: geometry.stats,
        losses: geometry.losses,
        approximations: geometry.approximations,
        budgetExceeded: geometry.budgetExceeded,
        skippedCount: geometry.skipped.length,
      },
    } : {}),
    geometryPublication: researchBuiltin ? "waiting-independent-real-evidence"
      : geometryPublished ? "published:brep-triangulation-mvp" : "waiting-brep-triangulation-r1",
  };
}

function schemaAwareTopologySummary(report: ParasolidProbeReport): string {
  const brep = report.brep;
  if (!brep) return report.census ? `${report.census.recordCount} 节点` : "无 census";
  return `${report.census?.recordCount ?? 0} 节点、bodies=${brep.bodies}/faces=${brep.faces}/loops=${brep.loops}/edges=${brep.edges}/vertices=${brep.vertices}`;
}

function schemaAwareWaitingMessage(report: ParasolidProbeReport, genericError?: string): string {
  if (report.catalog?.schemaId === BUILTIN_XT_RESEARCH_PROFILE_ID) {
    return `X_T ${report.schemaKey} 内置研发解析已读取：${schemaAwareTopologySummary(report)}；仅有自产几何验证，缺独立真实样本，保持检查档且不发布 GLB`;
  }
  const suffix = genericError ? `；通用解析失败：${genericError}` : "";
  return `X_T ${report.schemaKey} 权威结构已读取（ps-schema-probe schema-aware）：${schemaAwareTopologySummary(report)}${suffix}；几何三角化待内置离散化（R1），暂不发布几何`;
}

interface ParasolidGeometryPublishDeps {
  store: MetadataStore;
  objects: ObjectStore;
  model: ModelRecord;
  modelDir: string;
  outputDir: string;
  sourcePath: string;
  report: ParasolidProbeReport;
  reportQuality?: ConversionContext["reportQuality"];
  format: "x_t" | "x_b";
  inspectionUrl: string;
  /** 追加进 inspection.json 的档位证据(X_T: genericParse;X_B: schemaAware)。 */
  inspectionExtras: Record<string, unknown>;
}

/**
 * X_T/X_B 共用的 schema-aware 几何发布(R1 MVP 三角化):
 * faces → GLB → audit/LOD/quality 链 → ready(visual-complete)。
 * 调用方必须先确认 report.geometry.faces 非空;任何一步失败都抛错,
 * 由外层任务执行器按转换失败语义收敛(不发布半成品)。
 */
async function publishParasolidGeometryReady(deps: ParasolidGeometryPublishDeps): Promise<void> {
  const { store, objects, model, modelDir, outputDir, sourcePath, report, format } = deps;
  const geometry = report.geometry!;
  const result = await convertParasolidGeometryToGlb({
    geometry,
    sourcePath,
    outputDir,
    schemaKey: report.schemaKey,
    modellerVersion: report.modellerVersion,
  });
  await auditConverterOutput(outputDir, true);
  const lods = await createLodResources(path.join(outputDir, "geometry.glb"), model);
  const geometryUrl = assetUrl(model.projectId, model.id, "output/geometry.glb");
  const manifest: ModelManifest = {
    ...createManifest(
      model,
      "gltf",
      geometryUrl,
      assetUrl(model.projectId, model.id, "output/hierarchy.json"),
      assetUrl(model.projectId, model.id, "output/properties.json"),
      lods,
    ),
    inspectionUrl: deps.inspectionUrl,
  };
  // inspection 覆盖写:base inspection + 档位证据(geometryPublication 已指向发布)。
  const baseInspection = await readOptionalJson(path.join(outputDir, "inspection.json"));
  const inspection = { ...baseInspection, ...deps.inspectionExtras };
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "inspection.json"), JSON.stringify(inspection, null, 2), "utf8");
  await writeManifest(modelDir, manifest);
  await objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
  deps.reportQuality?.(await buildParasolidGeometryReadyQuality({ outputDir, ...result }));
  await store.updateModel(model.projectId, model.id, {
    status: "ready",
    progress: 100,
    message: `${format.toUpperCase()} 权威 B-Rep 几何已发布（schema-aware MVP 三角化）：${result.facesPublished}/${result.facesTotal} 面、${result.triangleCount.toLocaleString("zh-CN")} 个三角面${result.losses.length ? `，${result.losses.length} 项如实损失` : ""}`,
    manifest,
    manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
  });
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function industrialCadUnavailableMessage(format: string): string {
  return `${format} 内置离线解析 profile 尚未就绪；当前仅保留源文件，未生成可发布几何。`;
}

/**
 * X_B 结构证据 Provider（2026-09-26 定案,R1 扩展）：仅在未配置外部工业转换器命令且
 * 探针 CLI 存在时启用。把"X_B 完全黑盒"升级为"结构可检、几何可发布(MVP)":
 * - census（未配置 catalog）：二进制头验证 + schema key;
 * - schema-aware（配置 catalog）：全节点计数 + 权威 B-Rep 拓扑;
 * - R1:`--geometry` 发布 ≥1 个面 → GLB + audit/LOD/quality 链,ready(visual-complete);
 *   0 个面/探针失败 → 维持 waiting_converter 既有语义,不发布半成品。
 */
export class XbStructureProvider implements ConversionProvider {
  readonly supportsGeneralImport = false;
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly probe: ParasolidProbeRuntime,
  ) {}

  async convert({ model, modelDir, sourcePath, reportQuality }: ConversionContext): Promise<void> {
    const outputDir = path.join(modelDir, "output");
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: "正在读取 X_B 结构头与 schema-aware 解码能力",
    });
    const schemaCatalog = this.probe.config.schemaCatalog;
    let report: ParasolidProbeReport;
    try {
      report = await this.probe.run({ filePath: sourcePath, brep: Boolean(schemaCatalog), geometry: Boolean(schemaCatalog) });
    } catch (error) {
      console.warn("ps-schema-probe X_B census 失败，回落到既有阻断语义", error);
      await this.store.updateModel(model.projectId, model.id, {
        status: "waiting_converter",
        progress: 0,
        message: industrialCadUnavailableMessage("Parasolid X_B"),
      });
      return;
    }
    if (schemaCatalog && report.geometry?.faces?.length) {
      await mkdir(outputDir, { recursive: true });
      await publishParasolidGeometryReady({
        store: this.store,
        objects: this.objects,
        model,
        modelDir,
        outputDir,
        sourcePath,
        report,
        reportQuality,
        format: "x_b",
        inspectionUrl: assetUrl(model.projectId, model.id, "output/inspection.json"),
        inspectionExtras: {
          status: "structure-read",
          recognizedFormat: "parasolid-x_b",
          inspectionScope: "header-structure-and-schema-aware-geometry-mvp",
          geometryParsed: true,
          sourceBytes: report.fileSize,
          schema: report.schemaKey,
          modellerVersion: report.modellerVersion,
          schemaAware: parasolidSchemaAwareEvidence(report),
        },
      });
      return;
    }
    const brep = report.brep;
    const inspection = {
      status: "structure-read",
      recognizedFormat: "parasolid-x_b",
      inspectionScope: schemaCatalog ? "header-structure-and-schema-aware-census" : "header-structure-census",
      geometryParsed: false,
      sourceBytes: report.fileSize,
      schema: report.schemaKey,
      modellerVersion: report.modellerVersion,
      header: {
        schemaKey: report.schemaKey,
        modellerVersion: report.modellerVersion,
        fileSize: report.fileSize,
      },
      topology: {
        bodies: brep
          ? { status: "decoded", count: brep.bodies }
          : { status: "not-decoded", reason: "未配置 schema catalog；仅完成二进制头验证，不推断 body 数量" },
        faces: brep
          ? { status: "decoded", count: brep.faces }
          : { status: "not-decoded", reason: "未配置 schema catalog；未读取通用 face 拓扑" },
        shells: brep
          ? { status: "decoded", count: brep.shells }
          : { status: "not-decoded", reason: "未配置 schema catalog；未读取 shell 关系" },
        assembly: { status: "not-decoded", reason: "X_B 装配实例与变换绑定尚无独立证据，不推断" },
      },
      metadata: {
        header: "decoded",
        entityNames: "not-decoded",
        colors: "not-decoded",
        properties: "not-decoded",
        reason: "实体名称、颜色与属性绑定需要版本对应 schema 与映射证据；当前仅返回结构头元数据",
      },
      geometry: {
        status: "not-decoded",
        reason: "B-Rep 三角化（离散化）未实现（R1）；结构证据来自 ps-schema-probe",
      },
      schemaAware: parasolidSchemaAwareEvidence(report),
      issues: [] as Array<{ code: string; message: string }>,
      limitations: [
        "结构识别与权威拓扑计数不等于可浏览或可转换；几何发布需要 B-Rep 三角化（R1）",
        "实体名称、颜色、PMI 与装配挂接未解码",
        "schema catalog 为部署方自备版权件，未配置时仅提供 census 头验证",
      ],
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "inspection.json"), JSON.stringify(inspection, null, 2), "utf8");
    const inspectionUrl = assetUrl(model.projectId, model.id, "output/inspection.json");
    const manifest: ModelManifest = {
      schemaVersion: 1,
      modelId: model.id,
      sourceName: model.name,
      sourceFormat: "x_b",
      inspectionUrl,
      createdAt: new Date().toISOString(),
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    await this.store.updateModel(model.projectId, model.id, {
      status: "waiting_converter",
      progress: 40,
      message: schemaCatalog
        ? `X_B ${report.schemaKey} 权威结构已读取（ps-schema-probe schema-aware）：${schemaAwareTopologySummary(report)}；几何三角化待内置离散化（R1）`
        : `X_B ${report.schemaKey} 头部结构已读取（ps-schema-probe census）；trim/几何解码需要部署方 schema catalog 与三角化（R1）`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
    });
  }
}
