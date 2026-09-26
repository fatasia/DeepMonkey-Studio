import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversionQualityDraft, ModelFormat, ModelManifest, ModelRecord, ViewerKind } from "@bim-studio/contracts";
import type { AppConfig, CommandProviderConfig } from "./config.js";
import { createParasolidProbeRunner, type ParasolidProbeConfig, type ParasolidProbeReport, type ParasolidProbeRunner } from "./parasolidSchemaProbe.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { generateGlbLods, optimizeNativeGlb } from "./glbOptimizer.js";
import { convertIgesToGlb, convertStepToGlb } from "./stepConverter.js";
import { auditConverterOutput } from "./converterOutputAudit.js";
import { convertXtTextSubsetToGlb } from "./xtTextSubsetConverter.js";
import { runBuiltinJtWorker } from "./builtinJtWorkerExecutor.js";
import { writeXtTextInspectionArtifact, type XtTextInspectionResult } from "./xtTextInspection.js";
import { convertXtGenericTextToGlb, type XtGenericConversionResult } from "./xtGenericConverter.js";
import { buildXtGenericReadyQuality } from "./xtGenericQualityDraft.js";
import { convertParasolidGeometryToGlb } from "./parasolidGeometryConverter.js";
import { buildParasolidGeometryReadyQuality } from "./parasolidGeometryQualityDraft.js";
import { buildJtLod0ReadyQuality, buildXtRevolvedReadyQuality, sha256File } from "./conversionQualityDraft.js";
import { RobotSourceProvider } from "./RobotSourceProvider.js";
import { ConversionTaskService } from "./conversionTasks.js";
import { createModelConversionRegistration, submitModelConversion } from "./modelConversionAdapter.js";

export interface ConversionContext {
  model: ModelRecord;
  sourcePath: string;
  modelDir: string;
  signal?: AbortSignal;
  registerResourceExit?: ((exit: Promise<void>) => void) | undefined;
  workerLimits?: { timeoutMs: number; maxMemoryMb: number; maxCpuPercent: number };
  /** 转换成功(ready)时上报质量草稿；sourceHash 由执行器回填，转换器不得自行声称。 */
  reportQuality?: ((draft: ConversionQualityDraft) => void) | undefined;
}

export interface ConversionProvider {
  readonly supportsGeneralImport?: boolean;
  convert(context: ConversionContext): Promise<void>;
}

interface OutputCandidate {
  fileName: string;
  viewerKind: ViewerKind;
}

function assetUrl(projectId: string, modelId: string, fileName: string): string {
  return `/assets/projects/${projectId}/models/${modelId}/${fileName}`;
}

export class ConversionQueue {
  private readonly providers: Record<ModelFormat, ConversionProvider>;
  readonly tasks: ConversionTaskService;

  constructor(
    private readonly store: MetadataStore,
    config: AppConfig,
    objects: ObjectStore,
    tasks?: ConversionTaskService,
  ) {
    this.providers = createProviders(store, config, objects);
    this.tasks = tasks ?? new ConversionTaskService([], undefined, undefined, store);
    for (const format of Object.keys(this.providers) as ModelFormat[]) {
      this.tasks.register(createModelConversionRegistration(format, store, objects, config,
        (stagedStore, stagedObjects) => createProviders(stagedStore, config, stagedObjects)[format]));
    }
  }

  listImportFormats(): ModelFormat[] {
    return (Object.entries(this.providers) as [ModelFormat, ConversionProvider][]).filter(([,provider]) => provider.supportsGeneralImport !== false).map(([format]) => format);
  }

  async enqueue(context: ConversionContext): Promise<string> {
    return submitModelConversion(this.tasks, context);
  }
}

function createProviders(store: MetadataStore, config: AppConfig, objects: ObjectStore): Record<ModelFormat, ConversionProvider> {
    const parasolidProbe = createParasolidProbeRuntime(config);
    return {
      ifc: new DirectProvider(store, objects, "ifc"),
      gltf: new DirectProvider(store, objects, "gltf"),
      glb: new DirectProvider(store, objects, "gltf"),
      fbx: new DirectProvider(store, objects, "fbx"),
      dxf: new DirectProvider(store, objects, "dxf"),
      obj: new DirectProvider(store, objects, "obj"),
      stl: new DirectProvider(store, objects, "stl"),
      "3mf": new DirectProvider(store, objects, "3mf"),
      dae: new DirectProvider(store, objects, "dae"),
      "3ds": new DirectProvider(store, objects, "3ds"),
      step: new PreciseCadProvider(store, objects, "step"),
      stp: new PreciseCadProvider(store, objects, "step"),
      iges: new PreciseCadProvider(store, objects, "iges"),
      igs: new PreciseCadProvider(store, objects, "iges"),
      dwg: config.dwg.command
        ? new CommandProvider(store, objects, config.dwg, [{ fileName: "model.dxf", viewerKind: "dxf" }])
        : new MissingProvider(store, "未找到 LibreDWG。请运行 tools/install-libredwg.ps1，或配置 DWG_CONVERTER_COMMAND。"),
      rvt: config.rvt.command
        ? new CommandProvider(store, objects, config.rvt, [])
        : new MissingProvider(store, "未配置 Revit Agent。请在安装 Revit 的 Windows 转换机上配置批处理程序。"),
      x_t: new XtTextSubsetProvider(store, objects, parasolidProbe),
      x_b: config.industrialCad.command
        ? new MissingProvider(store, industrialCadUnavailableMessage("Parasolid X_B"))
        : parasolidProbe
          ? new XbStructureProvider(store, objects, parasolidProbe)
          : new MissingProvider(store, industrialCadUnavailableMessage("Parasolid X_B")),
      jt: new JtStructureProvider(store, objects),
      // Three.js 0.185 的官方 USDLoader 同时解析 USDA、USDC 与 USDZ。
      // 原文件直接作为唯一运行资产，避免先预览源格式、再切换 GLB 造成对象标识漂移。
      usd: new DirectProvider(store, objects, "usd"),
      usda: new DirectProvider(store, objects, "usd"),
      usdc: new DirectProvider(store, objects, "usd"),
      usdz: new DirectProvider(store, objects, "usd"),
      urdf: new RobotSourceProvider(store, objects),
      zip: new RobotSourceProvider(store, objects),
    };
}

class PreciseCadProvider implements ConversionProvider {
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly format: "step" | "iges",
  ) {}

  async convert({ model, modelDir, sourcePath }: ConversionContext): Promise<void> {
    const label = this.format.toUpperCase();
    const outputDir = path.join(modelDir, "output");
    await mkdir(outputDir, { recursive: true });
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: `正在解析 ${label} 并生成轻量化 GLB`
    });
    const result = this.format === "step"
      ? await convertStepToGlb(sourcePath, outputDir)
      : await convertIgesToGlb(sourcePath, outputDir);
    const geometryPath = path.join(outputDir, "geometry.glb");
    await optimizeNativeGlb(geometryPath);
    const lods = await createLodResources(geometryPath, model);
    const geometryUrl = assetUrl(model.projectId, model.id, "output/geometry.glb");
    const manifest = createManifest(
      model,
      "gltf",
      geometryUrl,
      assetUrl(model.projectId, model.id, "output/hierarchy.json"),
      assetUrl(model.projectId, model.id, "output/properties.json"),
      lods
    );
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: `${label} 转换完成：${result.meshCount} 个网格，${result.triangleCount.toLocaleString("zh-CN")} 个三角面`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json")
    });
  }
}

class DirectProvider implements ConversionProvider {
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly viewerKind: ViewerKind
  ) {}

  async convert({ model, modelDir, sourcePath }: ConversionContext): Promise<void> {
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 40,
      message: "正在生成模型清单"
    });
    let geometryUrl = model.sourceUrl;
    let lods: ModelManifest["lods"];
    if (model.format === "glb") {
      const outputDir = path.join(modelDir, "output");
      await mkdir(outputDir, { recursive: true });
      const geometryPath = path.join(outputDir, "geometry.glb");
      await copyFile(sourcePath, geometryPath);
      await optimizeNativeGlb(geometryPath);
      lods = await createLodResources(geometryPath, model);
      geometryUrl = assetUrl(model.projectId, model.id, "output/geometry.glb");
      await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    }
    const manifest = createManifest(model, this.viewerKind, geometryUrl, undefined, undefined, lods);
    await writeManifest(modelDir, manifest);
    await this.objects.putFile(assetKey(model.projectId, model.id, "manifest.json"), path.join(modelDir, "manifest.json"));
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: this.viewerKind === "ifc" ? "可查看（浏览器端转换为 Fragments）" : "可查看",
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json")
    });
  }
}

class MissingProvider implements ConversionProvider {
  readonly supportsGeneralImport = false;
  constructor(
    private readonly store: MetadataStore,
    private readonly message: string
  ) {}

  async convert({ model }: ConversionContext): Promise<void> {
    await this.store.updateModel(model.projectId, model.id, {
      status: "waiting_converter",
      progress: 0,
      message: this.message
    });
  }
}

class CommandProvider implements ConversionProvider {
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly provider: CommandProviderConfig,
    private readonly candidates: OutputCandidate[]
  ) {}

  async convert({ model, modelDir, sourcePath }: ConversionContext): Promise<void> {
    if (!this.provider.command) throw new Error("转换器命令未配置");
    const outputDir = path.join(modelDir, "output");
    await mkdir(outputDir, { recursive: true });
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: commandProgressMessage(model),
    });
    const args = this.provider.args.map((argument) =>
      argument
        .replaceAll("{input}", sourcePath)
        .replaceAll("{output}", outputDir)
        .replaceAll("{mode}", model.rvtConversionMode ?? "native-glb")
        .replaceAll("{revitVersion}", model.rvtRevitVersion ?? "")
        .replaceAll("{format}", model.format)
        .replaceAll("{quality}", "high")
        .replaceAll("{includePmi}", "true")
    );
    if (model.format === "rvt" && model.rvtRevitVersion && !args.includes("--revit-version")) args.push("--revit-version", model.rvtRevitVersion);
    await runCommand(this.provider.command, args, this.provider.cwd, this.provider.timeoutMs);
    let compressionMessage = "";
    let lods: ModelManifest["lods"];
    if (model.format === "rvt" && model.rvtConversionMode !== "ifc") {
      const glbPath = path.join(outputDir, "geometry.glb");
      try {
        const result = await optimizeNativeGlb(glbPath);
        if (result.compressed) {
          const ratio = Math.round((1 - result.optimizedBytes / result.originalBytes) * 100);
          compressionMessage = `，GLB 已压缩 ${ratio}%`;
        }
        lods = await createLodResources(glbPath, model);
      } catch (error) {
        console.warn("原生 GLB Draco 压缩失败，保留未压缩模型", error);
        compressionMessage = "，Draco 压缩失败并已保留兼容模型";
      }
    }
    const modeCandidates: OutputCandidate[] = model.format === "rvt"
      ? model.rvtConversionMode === "ifc"
        ? [{ fileName: "model.ifc", viewerKind: "ifc" }]
        : [{ fileName: "geometry.glb", viewerKind: "gltf" }]
      : this.candidates;
    const result = await findOutput(outputDir, modeCandidates);
    const outputAudit = result.fileName.endsWith(".glb")
      ? await auditConverterOutput(outputDir, model.format === "x_t" || model.format === "x_b" || model.format === "jt")
      : undefined;
    const geometryUrl = assetUrl(model.projectId, model.id, `output/${result.fileName}`);
    const hierarchyPath = path.join(outputDir, "hierarchy.json");
    const propertiesPath = path.join(outputDir, "properties.json");
    const hierarchyUrl = await optionalAsset(hierarchyPath, assetUrl(model.projectId, model.id, "output/hierarchy.json"));
    const propertiesUrl = await optionalAsset(propertiesPath, assetUrl(model.projectId, model.id, "output/properties.json"));
    const pmiUrl = await optionalAsset(path.join(outputDir, "pmi.json"), assetUrl(model.projectId, model.id, "output/pmi.json"));
    const inspectionUrl = await optionalAsset(path.join(outputDir, "inspection.json"), assetUrl(model.projectId, model.id, "output/inspection.json"));
    const manifest: ModelManifest = {
      ...createManifest(model, result.viewerKind, geometryUrl, hierarchyUrl, propertiesUrl, lods, pmiUrl),
      ...(inspectionUrl ? { inspectionUrl } : {}),
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: `${model.format === "dwg" ? "DWG 已转换为 DXF" : "转换完成"}${outputAudit ? `：${outputAudit.geometry.meshCount} 个网格，${outputAudit.geometry.triangleCount} 个三角面` : ""}${compressionMessage}`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json")
    });
  }
}

interface ParasolidProbeRuntime {
  config: ParasolidProbeConfig;
  run: ParasolidProbeRunner;
}

function createParasolidProbeRuntime(config: AppConfig): ParasolidProbeRuntime | undefined {
  const probe = config.parasolidProbe;
  if (!probe) return undefined;
  return { config: probe, run: createParasolidProbeRunner(probe) };
}

class XtTextSubsetProvider implements ConversionProvider {
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
    // R1 MVP:探针发布 ≥1 面即发布 GLB(visual-complete);否则维持等待语义。
    geometryPublication: geometryPublished ? "published:brep-triangulation-mvp" : "waiting-brep-triangulation-r1",
  };
}

function schemaAwareTopologySummary(report: ParasolidProbeReport): string {
  const brep = report.brep;
  if (!brep) return report.census ? `${report.census.recordCount} 节点` : "无 census";
  return `${report.census?.recordCount ?? 0} 节点、bodies=${brep.bodies}/faces=${brep.faces}/loops=${brep.loops}/edges=${brep.edges}/vertices=${brep.vertices}`;
}

function schemaAwareWaitingMessage(report: ParasolidProbeReport, genericError?: string): string {
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

class JtStructureProvider implements ConversionProvider {
  readonly supportsGeneralImport = false;
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
  ) {}

  async convert({ model, modelDir, sourcePath, signal, registerResourceExit, workerLimits, reportQuality }: ConversionContext): Promise<void> {
    const outputDir = path.join(modelDir, "output");
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: "正在读取 JT 目录、装配层级、属性和材质",
    });
    const { inspection, result } = await runBuiltinJtWorker({ sourcePath, outputDir, sourceName: model.name }, { signal, registerResourceExit, limits: workerLimits });
    const inspectionUrl = assetUrl(model.projectId, model.id, "output/inspection.json");
    const sidecarManifest: ModelManifest = {
      schemaVersion: 1,
      modelId: model.id,
      sourceName: model.name,
      sourceFormat: "jt",
      hierarchyUrl: assetUrl(model.projectId, model.id, "output/hierarchy.json"),
      propertiesUrl: assetUrl(model.projectId, model.id, "output/properties.json"),
      inspectionUrl,
      createdAt: new Date().toISOString(),
    };
    if (!result) {
      await writeManifest(modelDir, sidecarManifest);
      await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
      await this.store.updateModel(model.projectId, model.id, {
        status: "waiting_converter",
        progress: 40,
        message: `JT ${inspection.header.majorVersion}.${inspection.header.minorVersion} 结构已读取：${inspection.toc.entryCount} 个段、${inspection.assembly.nodeCount} 个节点；未发现可发布的 LOD0 三角网格`,
        manifest: sidecarManifest,
        manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
      });
      return;
    }
    await auditConverterOutput(outputDir, true);
    const manifest: ModelManifest = {
      ...createManifest(
        model,
        "gltf",
        assetUrl(model.projectId, model.id, "output/geometry.glb"),
        sidecarManifest.hierarchyUrl,
        sidecarManifest.propertiesUrl,
      ),
      inspectionUrl,
    };
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    // 质量声明基于已发布产物;UV/顶点色按转换器实测的解码情况动态出入损失与近似清单。
    reportQuality?.(await buildJtLod0ReadyQuality({
      outputDir,
      meshCount: result.meshCount,
      triangleCount: result.triangleCount,
      instanceCount: result.instanceCount,
      tocEntryCount: inspection.toc.entryCount,
      assemblyNodeCount: inspection.assembly.nodeCount,
      decodedAttributes: result.decodedAttributes,
    }));
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: `JT LOD0 转换完成：${result.meshCount} 个网格、${result.instanceCount} 个装配实例、${result.triangleCount.toLocaleString("zh-CN")} 个三角面，可查看并选择构件`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
    });
  }
}

function industrialCadUnavailableMessage(format: string): string {
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
class XbStructureProvider implements ConversionProvider {
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

function commandProgressMessage(model: ModelRecord): string {
  if (model.format === "dwg") return "LibreDWG 正在转换为 DXF";
  if (model.format === "rvt") {
    const version = model.rvtRevitVersion ? ` ${model.rvtRevitVersion}` : "";
    return model.rvtConversionMode === "ifc"
      ? `Revit${version} 正在导出 IFC`
      : `Revit${version} 正在生成原生 GLB`;
  }
  return `工业转换器正在解析 ${model.format.toUpperCase()}，生成几何、装配层级与属性`;
}

function assetKey(projectId: string, modelId: string, fileName: string): string {
  return `projects/${projectId}/models/${modelId}/${fileName}`.replace(/\/$/, "");
}

async function findOutput(outputDir: string, candidates: OutputCandidate[]): Promise<OutputCandidate> {
  for (const candidate of candidates) {
    try {
      await access(path.join(outputDir, candidate.fileName));
      return candidate;
    } catch {
      // Try the next supported converter output.
    }
  }
  throw new Error(`转换器未生成受支持的产物：${candidates.map((item) => item.fileName).join(", ")}`);
}

function createManifest(
  model: ModelRecord,
  viewerKind: ViewerKind,
  geometryUrl: string,
  hierarchyUrl?: string,
  propertiesUrl?: string,
  lods?: ModelManifest["lods"],
  pmiUrl?: string
): ModelManifest {
  return {
    schemaVersion: 1,
    modelId: model.id,
    sourceName: model.name,
    sourceFormat: model.format,
    viewerKind,
    geometryUrl,
    ...(hierarchyUrl ? { hierarchyUrl } : {}),
    ...(propertiesUrl ? { propertiesUrl } : {}),
    ...(pmiUrl ? { pmiUrl } : {}),
    ...(lods?.length ? { lods } : {}),
    createdAt: new Date().toISOString()
  };
}

async function createLodResources(filePath: string, model: ModelRecord): Promise<ModelManifest["lods"]> {
  try {
    const generated = await generateGlbLods(filePath);
    return generated.map(({ fileName, level, ratio }) => ({
      level,
      ratio,
      url: assetUrl(model.projectId, model.id, `output/${fileName}`)
    }));
  } catch (error) {
    console.warn("LOD 生成失败，保留完整精度模型", error);
    return [];
  }
}

async function optionalAsset(filePath: string, url: string): Promise<string | undefined> {
  try {
    await access(filePath);
    return url;
  } catch {
    return undefined;
  }
}

async function writeManifest(modelDir: string, manifest: ModelManifest): Promise<void> {
  await writeFile(path.join(modelDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

const DEFAULT_CONVERTER_TIMEOUT_MS = 30 * 60 * 1_000;

function runCommand(command: string, args: string[], cwd: string, configuredTimeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && (configuredTimeoutMs ?? 0) > 0
      ? configuredTimeoutMs!
      : DEFAULT_CONVERTER_TIMEOUT_MS;
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`转换器运行超时（${Math.ceil(timeoutMs / 1_000)} 秒）`)));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      if (code === 0) finish(resolve);
      else finish(() => reject(new Error(`转换器退出码 ${String(code)}：${stderr.trim() || "无错误输出"}`)));
    });
  });
}
