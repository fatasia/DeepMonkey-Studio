import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConversionArtifactKind, ConversionQualityDraft, ImportSourceFormat, ModelFormat, ModelRecord } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";
import type { ConversionContext, ConversionProvider } from "./conversion.js";
import type { ConversionTaskService, ConverterExecutionContext, ConverterPluginRegistration } from "./conversionTasks.js";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import { auditGlbGeometry } from "./converterOutputAudit.js";
import { verifyConversionSource } from "./conversionSourceCache.js";
import { isKeyWithinPrefix } from "./conversionTaskValidation.js";

const pluginId = (format: ModelFormat) => `bim.model-import.${format}`;
const outputLimit = 4 * 1024 * 1024 * 1024;

export async function submitModelConversion(service: ConversionTaskService, context: ConversionContext): Promise<string> {
  const { model, sourcePath } = context;
  const task = await service.submitDurable({
    projectId: model.projectId, modelId: model.id, pluginId: pluginId(model.format),
    input: { objectKey: sourceKey(model), fileName: path.basename(sourcePath), format: model.format,
      size: (await stat(sourcePath)).size, sha256: await hash(sourcePath) },
  });
  return task.id;
}

export function createModelConversionRegistration(
  format: ModelFormat, store: MetadataStore, objects: ObjectStore, config: AppConfig,
  provider: (store: MetadataStore, objects: ObjectStore) => ConversionProvider,
): ConverterPluginRegistration {
  const limits = { timeoutMs: 30 * 60 * 1000, maxInputBytes: 2 * 1024 * 1024 * 1024, maxOutputBytes: outputLimit, maxMemoryMb: 16384, maxCpuPercent: 100 };
  return {
    manifest: {
      contractVersion: 1, id: pluginId(format), name: `${format === "x_t" ? "X_T" : format.toUpperCase()} 模型导入`,
      version: "1.0.0", execution: "server-worker", inputFormats: [format],
      outputs: [
        { kind: "geometry", format: "glb", required: false }, { kind: "geometry", format: "ifc", required: false },
        { kind: "geometry", format: "dxf", required: false }, { kind: "hierarchy", format: "json", required: false },
        { kind: "properties", format: "json", required: false }, { kind: "pmi", format: "json", required: false },
        { kind: "lod", format: "glb", required: false, multiple: true }, { kind: "log", format: "json", required: false, multiple: true },
        { kind: "log", format: "binary", required: false, multiple: true },
      ],
      configurationSchema: { type: "object", additionalProperties: false },
      capabilities: ["filesystem.read-input", "filesystem.write-output"],
      limits,
    },
    execute: async context => {
      const model = store.getProject(context.task.projectId)?.models.find(item => item.id === context.task.modelId);
      if (!model || model.format !== format || sourceKey(model) !== context.task.input.objectKey) throw new Error("转换任务与模型来源不一致");
      if (Object.keys(context.task.configuration).length) throw new Error("模型导入不接受额外执行配置");
      const modelDir = path.join(config.dataDir, "projects", model.projectId, "models", model.id);
      const sourcePath = path.join(config.dataDir, ...sourceKey(model).split("/"));
      await verifyConversionSource(objects, context.task, sourcePath, context.signal);
      context.signal.throwIfAborted();
      const sourceFormat: ImportSourceFormat | undefined = format === "x_t" || format === "x_b" ? "parasolid" : format === "jt" || format === "rvt" ? format : undefined;
      if (sourceFormat) context.reportSourceBundle({ schemaVersion: 1, sourceName: context.task.input.fileName,
        sourceFormat, contentHash: context.task.input.sha256!, bundledPath: context.task.input.objectKey,
        licenseReference: model.libraryOrigin?.license ?? "user-provided-local-only" });
      const attemptDir = path.join(modelDir, "attempts", context.task.id);
      await mkdir(path.dirname(attemptDir), { recursive: true });
      await mkdir(attemptDir, { recursive: false });
      const prefix = `projects/${model.projectId}/models/${model.id}`;
      const attemptPrefix = `${prefix}/attempts/${context.task.id}`;
      const remap = (value: unknown): any => {
        if (typeof value === "string") return value.startsWith(`/assets/${prefix}/`) && !value.startsWith(`/assets/${attemptPrefix}/`) && value !== model.sourceUrl
          ? value.replace(`/assets/${prefix}/`, `/assets/${attemptPrefix}/`) : value;
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
        return value;
      };
      let updates: Partial<ModelRecord> = {};
      const stagedStore = new Proxy(store, { get(target, key) {
        if (key === "updateModel") return async (projectId: string, modelId: string, patch: Partial<ModelRecord>) => {
          context.signal.throwIfAborted();
          if (projectId !== model.projectId || modelId !== model.id) throw new Error("转换器不能修改其他模型");
          updates = { ...updates, ...remap(patch) };
          if (patch.progress !== undefined) context.reportProgress(patch.progress, patch.message ?? "正在转换");
          return { ...model, ...updates };
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      const stagedObjects = await attemptObjects(objects, context, prefix, attemptPrefix, attemptDir, remap);
      let qualityDraft: ConversionQualityDraft | undefined;
      await provider(stagedStore, stagedObjects).convert({ model, sourcePath, modelDir: attemptDir,
        signal: context.signal, registerResourceExit: context.registerResourceExit, workerLimits: limits,
        reportQuality: draft => { qualityDraft = draft; } });
      context.signal.throwIfAborted();
      if (updates.status === "failed") throw new Error(updates.message ?? "模型转换失败");
      if (updates.status !== "ready" && updates.status !== "waiting_converter") throw new Error("转换器未返回最终模型状态");
      if (sourceFormat && updates.status === "waiting_converter") context.reportQuality({
        schemaVersion: 1, profileId: `builtin-${format}-inspection`, tier: "inspect", sourceHash: context.task.input.sha256!,
        checks: [{ dimension: "geometry", passed: false, reason: updates.message ?? "未生成可发布几何" }],
        losses: ["geometry.missing"], approximations: [],
      });
      // ready 模型只接受转换器如实申报的质量草稿；源哈希必须绑定已核验的输入。
      if (updates.status === "ready" && qualityDraft && sourceFormat) {
        context.reportQuality({ ...qualityDraft, sourceHash: context.task.input.sha256! });
      }
      for (const file of await files(attemptDir)) {
        context.signal.throwIfAborted();
        const relative = path.relative(attemptDir, file).split(path.sep).join("/");
        // Publish only bytes present in the authoritative object store, including
        // provider sidecars that were not included in its own upload calls.
        await stagedObjects.putFile(`${prefix}/${relative}`, file);
        if (relative === "manifest.json" && updates.manifest && !isDeepStrictEqual(JSON.parse(await readFile(file, "utf8")), updates.manifest)) {
          throw new Error("转换清单文件与待提交模型清单不一致");
        }
        const { kind, format: outputFormat } = artifactKind(relative);
        const geometry = outputFormat === "glb" ? await auditGlbGeometry(file) : undefined;
        context.publishArtifact({ kind, format: outputFormat, objectKey: `${context.outputPrefix}${relative}`,
          size: (await stat(file)).size, sha256: await hash(file), ...(geometry ? { metadata: { ...geometry } } : {}) });
      }
      if (updates.manifest && !await stat(path.join(attemptDir, "manifest.json")).then(info => info.isFile(), () => false)) throw new Error("转换器未生成模型清单文件");
      context.stageModelUpdate(updates);
    },
  };
}

function artifactKind(relative: string): { kind: ConversionArtifactKind; format: string } {
  const name = path.posix.basename(relative);
  if (name === "geometry.glb") return { kind: "geometry", format: "glb" };
  if (name === "model.ifc" || name === "model.dxf") return { kind: "geometry", format: name.slice(6) };
  if (name.endsWith(".glb")) return { kind: "lod", format: "glb" };
  for (const kind of ["hierarchy", "properties", "pmi"] as const) if (name === `${kind}.json`) return { kind, format: "json" };
  return { kind: "log", format: name.endsWith(".json") ? "json" : "binary" };
}

export async function attemptObjects(objects: ObjectStore, context: ConverterExecutionContext, prefix: string, attemptPrefix: string,
  attemptDir: string, remap: (value: unknown) => unknown): Promise<ObjectStore> {
  const canonicalRoot = await realpath(attemptDir);
  const sizes = new Map<string, number>();
  let writtenBytes = 0;
  const put = async (key: string, filePath: string) => {
    context.signal.throwIfAborted();
    if (key.includes("\\") || !isKeyWithinPrefix(key, `${prefix}/`) || key.startsWith(`${prefix}/source/`)) throw new Error("转换产物路径越界");
    const relative = path.relative(attemptDir, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("转换产物不在 attempt 目录");
    if (relative.split(path.sep).join("/") !== key.slice(prefix.length + 1)) throw new Error("转换产物对象键与本地路径不一致");
    const canonicalRelative = path.relative(canonicalRoot, await realpath(filePath));
    if (!canonicalRelative || canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) throw new Error("转换产物真实路径越界");
    let current = path.resolve(attemptDir);
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("转换产物不能包含符号链接或 junction");
    }
    if (await realpath(attemptDir) !== canonicalRoot) throw new Error("attempt 根目录身份已变化");
    if (relative === "manifest.json") await writeFile(filePath, JSON.stringify(remap(JSON.parse(await readFile(filePath, "utf8"))), null, 2));
    const bytes = (await stat(filePath)).size;
    const nextBytes = writtenBytes - (sizes.get(relative) ?? 0) + bytes;
    if (nextBytes > outputLimit) throw new Error("转换产物超过大小限制");
    await objects.putFile(`${attemptPrefix}/${key.slice(prefix.length + 1)}`, filePath);
    writtenBytes = nextBytes;
    sizes.set(relative, bytes);
    context.signal.throwIfAborted();
  };
  return new Proxy(objects, { get(target, key) {
    if (key === "putFile" || key === "putFileIfMissing") return put;
    if (key === "syncDirectory") return async (root: string, directory: string) => {
      for (const file of await files(directory)) await put(`${root}/${path.relative(directory, file).split(path.sep).join("/")}`, file);
    };
    if (key === "removePrefix") return async () => { throw new Error("转换器不能删除已有产物"); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}

function sourceKey(model: ModelRecord): string {
  const prefix = `/assets/projects/${model.projectId}/models/${model.id}/source/`;
  if (!model.sourceUrl.startsWith(prefix)) throw new Error("模型来源路径无效");
  const name = decodeURIComponent(model.sourceUrl.slice(prefix.length));
  if (!name || /[\\/\u0000-\u001f]/.test(name) || name === "." || name === "..") throw new Error("模型来源文件名无效");
  return `projects/${model.projectId}/models/${model.id}/source/${name}`;
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("转换产物不能包含符号链接");
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
async function hash(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
