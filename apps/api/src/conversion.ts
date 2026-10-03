import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversionQualityDraft, ModelFormat, ModelManifest, ModelRecord, ViewerKind } from "@bim-studio/contracts";
import type { AppConfig, CommandProviderConfig } from "./config.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { optimizeNativeGlb } from "./glbOptimizer.js";
import { convertIgesToGlb, convertStepToGlb } from "./stepConverter.js";
import { auditConverterOutput } from "./converterOutputAudit.js";
import { runBuiltinJtWorker } from "./builtinJtWorkerExecutor.js";
import { buildJtLod0ReadyQuality } from "./conversionQualityDraft.js";
import { RobotSourceProvider } from "./RobotSourceProvider.js";
import { ConversionTaskService } from "./conversionTasks.js";
import { createModelConversionRegistration, submitModelConversion } from "./modelConversionAdapter.js";
import { buildCadCompatibilityProfile, detectColliderDerivativeEvidence, publishModelDeepAssetPackage } from "./deepAssetPackagePipeline.js";
import { createFileSystemDeepAssetPackageStore, type FileSystemDeepAssetPackageStore } from "./deepAssetPackageStore.js";
import { assetUrl, assetKey, availableOutputSidecars, createLodResources, createManifest, findOutput, optionalAsset, writeManifest, type OutputCandidate } from "./conversionManifest.js";
import { createParasolidProbeRuntime, industrialCadUnavailableMessage, XtTextSubsetProvider, XbStructureProvider } from "./conversionParasolidProviders.js";

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

export class ConversionQueue {
  private readonly providers: Record<ModelFormat, ConversionProvider>;
  readonly tasks: ConversionTaskService;

  constructor(
    private readonly store: MetadataStore,
    config: AppConfig,
    objects: ObjectStore,
    tasks?: ConversionTaskService,
  ) {
    const deepAssets = createFileSystemDeepAssetPackageStore(
      // 测试可能传部分 config；缺 dataDir 时退回 loadConfig 的默认语义，store 构造本身不触盘。
      path.join(config.dataDir ?? path.join(process.cwd(), "data"), "deep-asset-packages"),
      () => Promise.resolve(undefined),
    );
    this.deepAssets = deepAssets;
    this.providers = createProviders(store, config, objects, deepAssets);
    this.tasks = tasks ?? new ConversionTaskService([], undefined, undefined, store);
    for (const format of Object.keys(this.providers) as ModelFormat[]) {
      this.tasks.register(createModelConversionRegistration(format, store, objects, config,
        (stagedStore, stagedObjects) => createProviders(stagedStore, config, stagedObjects, deepAssets)[format]));
    }
  }

  private readonly deepAssets: FileSystemDeepAssetPackageStore;

  listImportFormats(): ModelFormat[] {
    return (Object.entries(this.providers) as [ModelFormat, ConversionProvider][]).filter(([,provider]) => provider.supportsGeneralImport !== false).map(([format]) => format);
  }

  async enqueue(context: ConversionContext): Promise<string> {
    return submitModelConversion(this.tasks, context);
  }
}

function createProviders(store: MetadataStore, config: AppConfig, objects: ObjectStore,
  deepAssets: FileSystemDeepAssetPackageStore): Record<ModelFormat, ConversionProvider> {
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
      step: new PreciseCadProvider(store, objects, "step", deepAssets),
      stp: new PreciseCadProvider(store, objects, "step", deepAssets),
      iges: new PreciseCadProvider(store, objects, "iges", deepAssets),
      igs: new PreciseCadProvider(store, objects, "iges", deepAssets),
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
    private readonly deepAssets: FileSystemDeepAssetPackageStore,
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
    // Deep Asset Package 生产与修订号 CAS 发布；发布被拒时结果为 undefined，几何照常交付。
    const sidecars = await availableOutputSidecars(outputDir);
    // D1：colliders facet 按证据分级——存在可消费派生物才标 partial，缺失保持 unverified。
    const colliderEvidence = await detectColliderDerivativeEvidence(outputDir);
    const published = await publishModelDeepAssetPackage({
      store: this.deepAssets,
      model,
      sourcePath,
      modelDir,
      importer: { id: `opencascade-${this.format}`, version: "1" },
      compatibility: buildCadCompatibilityProfile(this.format, `opencascade-${this.format}`, "1", { ...sidecars, colliderEvidence }),
    });
    const geometryUrl = assetUrl(model.projectId, model.id, "output/geometry.glb");
    const manifest = {
      ...createManifest(
        model,
        "gltf",
        geometryUrl,
        assetUrl(model.projectId, model.id, "output/hierarchy.json"),
        assetUrl(model.projectId, model.id, "output/properties.json"),
        lods
      ),
      ...(published ? { deepAssetPackage: published.reference } : {}),
    };
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
    // 质量声明基于已发布产物;UV/顶点色按转换器实测的解码情况动态出入损失与近似清单;
    // 源含 PMI 段时质量草稿按结构级清单标注(pmi:structure-only)。
    reportQuality?.(await buildJtLod0ReadyQuality({
      outputDir,
      meshCount: result.meshCount,
      triangleCount: result.triangleCount,
      instanceCount: result.instanceCount,
      tocEntryCount: inspection.toc.entryCount,
      assemblyNodeCount: inspection.assembly.nodeCount,
      decodedAttributes: result.decodedAttributes,
      pmiPresent: inspection.pmiPresent === true,
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
