import { spawn } from "node:child_process";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelFormat, ModelManifest, ModelRecord, ViewerKind } from "@bim-studio/contracts";
import type { AppConfig, CommandProviderConfig } from "./config.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { generateGlbLods, optimizeNativeGlb } from "./glbOptimizer.js";
import { convertIgesToGlb, convertStepToGlb } from "./stepConverter.js";
import { auditConverterOutput } from "./converterOutputAudit.js";
import { convertXtTextSubsetToGlb } from "./xtTextSubsetConverter.js";
import { writeJtInspectionArtifacts } from "./jtInspection.js";
import { convertJtLod0ToGlb } from "./jtGlbConverter.js";
import { writeXtTextInspectionArtifact } from "./xtTextInspection.js";
import { RobotSourceProvider } from "./RobotSourceProvider.js";

interface ConversionContext {
  model: ModelRecord;
  sourcePath: string;
  modelDir: string;
}

interface ConversionProvider {
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
  private readonly pending: ConversionContext[] = [];
  private running = false;
  private readonly providers: Record<ModelFormat, ConversionProvider>;

  constructor(
    private readonly store: MetadataStore,
    config: AppConfig,
    objects: ObjectStore
  ) {
    const industrialCadProvider = config.industrialCad.command
      ? new CommandProvider(store, objects, config.industrialCad, [{ fileName: "geometry.glb", viewerKind: "gltf" }])
      : undefined;
    this.providers = {
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
      x_t: new XtTextSubsetProvider(store, objects, industrialCadProvider),
      x_b: industrialCadProvider
        ? industrialCadProvider
        : new MissingProvider(store, industrialCadUnavailableMessage("Parasolid X_B")),
      jt: new JtStructureProvider(store, objects, industrialCadProvider),
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

  enqueue(context: ConversionContext): void {
    this.pending.push(context);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const context = this.pending.shift();
        if (!context) continue;
        try {
          await this.providers[context.model.format].convert(context);
        } catch (error) {
          await this.store.updateModel(context.model.projectId, context.model.id, {
            status: "failed",
            progress: 100,
            message: error instanceof Error ? error.message : "转换失败"
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
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

class XtTextSubsetProvider implements ConversionProvider {
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly fallback?: ConversionProvider,
  ) {}

  async convert({ model, modelDir, sourcePath }: ConversionContext): Promise<void> {
    const outputDir = path.join(modelDir, "output");
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: "正在读取 X_T 版本、文件头和可验证几何能力",
    });
    const inspection = await writeXtTextInspectionArtifact(sourcePath, outputDir);
    const inspectionUrl = assetUrl(model.projectId, model.id, "output/inspection.json");
    if (!inspection.geometryParsed) {
      if (inspection.status !== "invalid" && this.fallback) {
        await this.store.updateModel(model.projectId, model.id, {
          status: "processing",
          progress: 40,
          message: "X_T 文件结构已验证，正在转交工业转换器生成可交互几何",
        });
        await this.fallback.convert({ model, modelDir, sourcePath });
        return;
      }
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
          ? `X_T 文件结构无效：${inspection.geometry.reason}`
          : `X_T ${inspection.schema ?? "未知 schema"} 头部已读取；未生成几何：${inspection.geometry.reason}`,
        manifest,
        manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
      });
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
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: `X_T 旋转体转换完成：${result.faceCount} 个面，${result.triangleCount.toLocaleString("zh-CN")} 个三角面`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json"),
    });
  }
}

class JtStructureProvider implements ConversionProvider {
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore,
    private readonly fallback?: ConversionProvider,
  ) {}

  async convert({ model, modelDir, sourcePath }: ConversionContext): Promise<void> {
    const outputDir = path.join(modelDir, "output");
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: "正在读取 JT 目录、装配层级、属性和材质",
    });
    const { inspection, document } = await writeJtInspectionArtifacts(sourcePath, outputDir);
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
    const result = await convertJtLod0ToGlb(document, outputDir, model.name, inspection.materials);
    if (!result) {
      if (this.fallback) {
        await this.store.updateModel(model.projectId, model.id, {
          status: "processing",
          progress: 40,
          message: "JT 装配结构已读取，正在转交工业转换器生成可交互几何",
        });
        await this.fallback.convert({ model, modelDir, sourcePath });
        return;
      }
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
  return `未配置 ${format} 工业转换器。请配置 INDUSTRIAL_CAD_CONVERTER_COMMAND；正式环境建议使用 HOOPS Exchange、CAD Exchanger 或 Siemens 组件。`;
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
