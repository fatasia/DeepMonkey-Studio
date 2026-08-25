import { spawn } from "node:child_process";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelFormat, ModelManifest, ModelRecord, ViewerKind } from "@bim-studio/contracts";
import type { AppConfig, CommandProviderConfig } from "./config.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { generateGlbLods, optimizeNativeGlb } from "./glbOptimizer.js";
import { convertStepToGlb } from "./stepConverter.js";

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
    this.providers = {
      ifc: new DirectProvider(store, objects, "ifc"),
      gltf: new DirectProvider(store, objects, "gltf"),
      glb: new DirectProvider(store, objects, "gltf"),
      fbx: new DirectProvider(store, objects, "fbx"),
      dxf: new DirectProvider(store, objects, "dxf"),
      step: new StepProvider(store, objects),
      stp: new StepProvider(store, objects),
      dwg: config.dwg.command
        ? new CommandProvider(store, objects, config.dwg, [{ fileName: "model.dxf", viewerKind: "dxf" }])
        : new MissingProvider(store, "未找到 LibreDWG。请运行 tools/install-libredwg.ps1，或配置 DWG_CONVERTER_COMMAND。"),
      rvt: config.rvt.command
        ? new CommandProvider(store, objects, config.rvt, [])
        : new MissingProvider(store, "未配置 Revit Agent。请在安装 Revit 的 Windows 转换机上配置批处理程序。")
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

class StepProvider implements ConversionProvider {
  constructor(
    private readonly store: MetadataStore,
    private readonly objects: ObjectStore
  ) {}

  async convert({ model, modelDir, sourcePath }: ConversionContext): Promise<void> {
    const outputDir = path.join(modelDir, "output");
    await mkdir(outputDir, { recursive: true });
    await this.store.updateModel(model.projectId, model.id, {
      status: "processing",
      progress: 10,
      message: "正在解析 STEP 并生成轻量化 GLB"
    });
    const result = await convertStepToGlb(sourcePath, outputDir);
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
      message: `STEP 转换完成：${result.meshCount} 个网格，${result.triangleCount.toLocaleString("zh-CN")} 个三角面`,
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
      message: model.format === "dwg"
        ? "LibreDWG 正在转换为 DXF"
        : model.rvtConversionMode === "ifc" ? `Revit ${model.rvtRevitVersion ?? ""} 正在导出 IFC`.replace("  ", " ") : `Revit ${model.rvtRevitVersion ?? ""} 正在生成原生 GLB`.replace("  ", " ")
    });
    const args = this.provider.args.map((argument) =>
      argument
        .replaceAll("{input}", sourcePath)
        .replaceAll("{output}", outputDir)
        .replaceAll("{mode}", model.rvtConversionMode ?? "native-glb")
        .replaceAll("{revitVersion}", model.rvtRevitVersion ?? "")
    );
    if (model.format === "rvt" && model.rvtRevitVersion && !args.includes("--revit-version")) args.push("--revit-version", model.rvtRevitVersion);
    await runCommand(this.provider.command, args, this.provider.cwd);
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
    const geometryUrl = assetUrl(model.projectId, model.id, `output/${result.fileName}`);
    const hierarchyPath = path.join(outputDir, "hierarchy.json");
    const propertiesPath = path.join(outputDir, "properties.json");
    const hierarchyUrl = await optionalAsset(hierarchyPath, assetUrl(model.projectId, model.id, "output/hierarchy.json"));
    const propertiesUrl = await optionalAsset(propertiesPath, assetUrl(model.projectId, model.id, "output/properties.json"));
    const manifest = createManifest(model, result.viewerKind, geometryUrl, hierarchyUrl, propertiesUrl, lods);
    await writeManifest(modelDir, manifest);
    await this.objects.syncDirectory(assetKey(model.projectId, model.id, ""), modelDir);
    await this.store.updateModel(model.projectId, model.id, {
      status: "ready",
      progress: 100,
      message: `${model.format === "dwg" ? "DWG 已转换为 DXF" : "转换完成"}${compressionMessage}`,
      manifest,
      manifestUrl: assetUrl(model.projectId, model.id, "manifest.json")
    });
  }
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
  lods?: ModelManifest["lods"]
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

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`转换器退出码 ${String(code)}：${stderr.trim() || "无错误输出"}`));
    });
  });
}
