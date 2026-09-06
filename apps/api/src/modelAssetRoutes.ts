import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { supportedExtensions, type ModelRecord, type ProjectAssetRecord, type RvtConversionMode } from "@bim-studio/contracts";
import { assertParametricBindingReferences } from "@bim-studio/parametric-modeling-plugin";
import type { AppConfig } from "./config.js";
import type { ConversionQueue } from "./conversion.js";
import type { ObjectStore } from "./objects.js";
import { assertParametricModelLineage, parseParametricModelGeneration } from "./parametricModelMetadata.js";
import { discoverRevitInstallations, inspectRvtVersion, resolveRevitVersion } from "./revit.js";
import { cleanFileName, imageContentType, modelFormat, videoContentType } from "./routeFileTypes.js";
import { probeIndustrialFileStructure } from "./industrialFormatProbe.js";
import { inspectJtFile } from "./jtInspection.js";
import { inspectXtTextFile } from "./xtTextInspection.js";
import type { MetadataStore } from "./store.js";
import { resolveModelOptimizationOrigin } from "./modelOptimizationOrigin.js";
import { robotArchivePath } from "./robotUrdfValues.js";
import { RobotUploadLimitError, writeRobotUpload } from "./robotUpload.js";

interface ModelAssetRouteDependencies {
  store: MetadataStore;
  queue: ConversionQueue;
  objects: ObjectStore;
  dataDir: string;
  config: AppConfig;
}

/** 模型转换与媒体资产共同维护本地临时文件和对象存储的一致生命周期。 */
export async function registerModelAssetRoutes(app: FastifyInstance, dependencies: ModelAssetRouteDependencies): Promise<void> {
  const { store, queue, objects, dataDir, config } = dependencies;

  app.post<{ Params: { projectId: string }; Querystring: { rvtConversionMode?: string; rvtRevitVersion?: string; optimizedFromModelId?: string } }>("/api/projects/:projectId/models", async (request, reply) => {
    const project = store.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ message: "项目不存在" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择模型文件" });
    const format = modelFormat(part.filename);
    if (!format) {
      part.file.resume();
      return reply.code(415).send({ message: `不支持该格式，仅支持 ${supportedExtensions.join(", ")}` });
    }
    let generation;
    let optimization: ModelRecord["optimization"];
    try {
      optimization = resolveModelOptimizationOrigin(request.query.optimizedFromModelId, project.models);
      if (optimization) {
        const sourceId = optimization.sourceModelId;
        const robotSource = project.models.find(model => model.id === sourceId)?.manifest?.robot;
        if (format !== (robotSource ? "zip" : "glb")) throw new Error(robotSource ? "机器人无损压缩结果必须保存为 ZIP" : "优化结果必须保存为 GLB");
      }
      generation = parseParametricModelGeneration(part.fields.generation);
      if (generation) {
        assertParametricModelLineage(generation, project.models);
        assertParametricBindingReferences(generation.definition, project);
      }
    } catch (reason) {
      part.file.resume();
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "参数化模型元数据无效" });
    }
    if (generation && format !== "step" && format !== "stp") {
      part.file.resume();
      return reply.code(400).send({ message: "参数化模型当前必须保存为 STEP/STP" });
    }
    const requestedMode = request.query.rvtConversionMode ?? "native-glb";
    if (format === "rvt" && requestedMode !== "ifc" && requestedMode !== "native-glb") {
      part.file.resume();
      return reply.code(400).send({ message: "RVT 转换模式必须是 ifc 或 native-glb" });
    }
    const rvtConversionMode = format === "rvt" ? requestedMode as RvtConversionMode : undefined;
    const modelId = randomUUID();
    const safeName = cleanFileName(part.filename);
    const modelDir = path.join(dataDir, "projects", project.id, "models", modelId);
    const sourceDir = path.join(modelDir, "source");
    const sourcePath = path.join(sourceDir, safeName);
    await mkdir(sourceDir, { recursive: true });
    try {
      if (format === "urdf" || format === "zip") await writeRobotUpload(part.file, sourcePath, format);
      else await pipeline(part.file, createWriteStream(sourcePath, { flags: "wx" }));
    } catch (reason) {
      if (reason instanceof RobotUploadLimitError) return reply.code(413).send({ message: reason.message });
      throw reason;
    }
    if ((format === "urdf" || format === "zip") && part.file.truncated) {
      await rm(sourcePath, { force: true });
      return reply.code(413).send({ message: "机器人文件上传被截断，请检查文件大小限制" });
    }
    let robotEntryPath: string | undefined;
    try {
      const field = part.fields.robotEntryPath;
      if (field !== undefined) {
        if (Array.isArray(field) || field.type !== "field" || typeof field.value !== "string" || (format !== "urdf" && format !== "zip")) throw new Error("robotEntryPath 仅允许为机器人包的单一文本入口");
        robotEntryPath = robotArchivePath(field.value);
        if (!/\.urdf$/i.test(robotEntryPath)) throw new Error("机器人入口必须是 URDF 文件");
      }
    } catch (reason) {
      await rm(sourcePath, { force: true });
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "机器人入口无效" });
    }
    let rvtSourceVersion: string | undefined;
    let rvtRevitVersion: string | undefined;
    if (format === "rvt") {
      rvtSourceVersion = await inspectRvtVersion(config.rvt, sourcePath);
      try {
        rvtRevitVersion = resolveRevitVersion(await discoverRevitInstallations(), request.query.rvtRevitVersion, rvtSourceVersion);
      } catch (reason) {
        await rm(modelDir, { recursive: true, force: true });
        return reply.code(400).send({ message: reason instanceof Error ? reason.message : "无法选择 Revit 版本" });
      }
    }
    await objects.putFile(`projects/${project.id}/models/${modelId}/source/${safeName}`, sourcePath);
    const now = new Date().toISOString();
    const model: ModelRecord = {
      id: modelId,
      projectId: project.id,
      name: safeName,
      format,
      ...(rvtConversionMode ? { rvtConversionMode } : {}),
      ...(rvtSourceVersion ? { rvtSourceVersion } : {}),
      ...(rvtRevitVersion ? { rvtRevitVersion } : {}),
      ...(robotEntryPath ? { robotEntryPath } : {}),
      size: part.file.bytesRead,
      status: "queued",
      progress: 0,
      message: rvtRevitVersion ? `等待 Revit ${rvtRevitVersion} 转换` : "等待转换",
      sourceUrl: `/assets/projects/${project.id}/models/${modelId}/source/${encodeURIComponent(safeName)}`,
      ...(generation ? { generation } : {}),
      ...(optimization ? { optimization } : {}),
      createdAt: now,
      updatedAt: now
    };
    await store.addModel(project.id, model);
    queue.enqueue({ model, sourcePath, modelDir });
    return reply.code(202).send(model);
  });

  app.patch<{ Params: { projectId: string; modelId: string }; Body: { name?: string } }>("/api/projects/:projectId/models/:modelId", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ message: "资源名称不能为空" });
    const project = store.getProject(request.params.projectId);
    if (!project?.models.some((item) => item.id === request.params.modelId)) return reply.code(404).send({ message: "模型不存在" });
    return store.updateModel(request.params.projectId, request.params.modelId, { name: name.slice(0, 180) });
  });

  app.get<{ Params: { projectId: string; modelId: string } }>("/api/projects/:projectId/models/:modelId/format-probe", async (request, reply) => {
    const model = store.getProject(request.params.projectId)?.models.find((item) => item.id === request.params.modelId);
    if (!model) return reply.code(404).send({ message: "模型不存在" });
    if (model.format !== "jt" && model.format !== "x_t" && model.format !== "x_b") {
      return reply.code(409).send({ message: "当前只为 JT、Parasolid X_T 和 X_B 提供安全结构探测，其他格式仍按能力目录处理" });
    }
    try {
      const sourcePath = resolveModelSourcePath(dataDir, model.projectId, model.id, model.sourceUrl);
      if (model.format === "jt") return await inspectJtFile(sourcePath);
      if (model.format === "x_t") return await inspectXtTextFile(sourcePath);
      return await probeIndustrialFileStructure(sourcePath, model.format);
    } catch (reason) {
      request.log.warn({ reason, modelId: model.id, format: model.format }, "industrial structure probe failed");
      return reply.code(422).send({ message: reason instanceof Error ? reason.message : "工业格式结构探测失败" });
    }
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/assets", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listAssets(request.params.projectId);
  });
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/assets/images", async (request, reply) => {
    const project = store.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ message: "项目不存在" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择图片" });
    const extension = path.extname(part.filename).toLowerCase();
    const mimeType = imageContentType(extension);
    if (!mimeType) {
      part.file.resume();
      return reply.code(415).send({ message: "图片仅支持 JPG、PNG、WEBP、GIF、SVG" });
    }
    return reply.code(201).send(await saveMediaAsset({ store, objects, dataDir }, project.id, part, "image", mimeType));
  });
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/assets/videos", async (request, reply) => {
    const project = store.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ message: "项目不存在" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择视频" });
    const extension = path.extname(part.filename).toLowerCase();
    const mimeType = videoContentType(extension);
    if (!mimeType) {
      part.file.resume();
      return reply.code(415).send({ message: "视频仅支持 MP4、WEBM、OGV、MOV" });
    }
    return reply.code(201).send(await saveMediaAsset({ store, objects, dataDir }, project.id, part, "video", mimeType));
  });
  app.patch<{ Params: { projectId: string; assetId: string }; Body: { name?: string } }>("/api/projects/:projectId/assets/:assetId", async (request, reply) => {
    const asset = store.listAssets(request.params.projectId).find((item) => item.id === request.params.assetId);
    if (!asset) return reply.code(404).send({ message: "资源不存在" });
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ message: "资源名称不能为空" });
    return store.saveAsset(request.params.projectId, { ...asset, name: name.slice(0, 180), updatedAt: new Date().toISOString() });
  });
  app.delete<{ Params: { projectId: string; assetId: string } }>("/api/projects/:projectId/assets/:assetId", async (request, reply) => {
    const removed = await store.removeAsset(request.params.projectId, request.params.assetId);
    if (!removed) return reply.code(404).send({ message: "资源不存在" });
    await objects.removePrefix(`projects/${request.params.projectId}/assets/${request.params.assetId}`);
    await rm(path.join(dataDir, "projects", request.params.projectId, "assets", request.params.assetId), { recursive: true, force: true });
    return reply.code(204).send();
  });
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/environment-maps", async (request, reply) => {
    const project = store.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ message: "项目不存在" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择环境贴图" });
    const extension = path.extname(part.filename).toLowerCase();
    if (![".hdr", ".exr", ".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
      part.file.resume();
      return reply.code(415).send({ message: "环境贴图仅支持 HDR、EXR、JPG、PNG、WEBP" });
    }
    const id = randomUUID();
    const safeName = cleanFileName(part.filename);
    const directory = path.join(dataDir, "projects", project.id, "environment-maps", id);
    const filePath = path.join(directory, safeName);
    await mkdir(directory, { recursive: true });
    await pipeline(part.file, createWriteStream(filePath, { flags: "wx" }));
    const key = `projects/${project.id}/environment-maps/${id}/${safeName}`;
    await objects.putFile(key, filePath);
    return reply.code(201).send({ name: safeName, url: `/assets/${key}` });
  });
  app.delete<{ Params: { projectId: string; modelId: string } }>("/api/projects/:projectId/models/:modelId", async (request, reply) => {
    const removed = await store.removeModel(request.params.projectId, request.params.modelId);
    if (!removed) return reply.code(404).send({ message: "模型不存在" });
    const modelDir = path.join(dataDir, "projects", request.params.projectId, "models", request.params.modelId);
    await objects.removePrefix(`projects/${request.params.projectId}/models/${request.params.modelId}`);
    await rm(modelDir, { recursive: true, force: true });
    return reply.code(204).send();
  });
}

function resolveModelSourcePath(dataDir: string, projectId: string, modelId: string, sourceUrl: string): string {
  const encodedName = sourceUrl.split("/").at(-1);
  if (!encodedName) throw new Error("模型源文件地址缺少文件名");
  const fileName = decodeURIComponent(encodedName);
  if (!fileName || path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new Error("模型源文件名无效");
  }
  return path.join(dataDir, "projects", projectId, "models", modelId, "source", fileName);
}

async function saveMediaAsset(
  dependencies: Pick<ModelAssetRouteDependencies, "store" | "objects" | "dataDir">,
  projectId: string,
  part: MultipartFile,
  kind: "image" | "video",
  mimeType: string
): Promise<ProjectAssetRecord> {
  const id = randomUUID();
  const safeName = cleanFileName(part.filename);
  const directory = path.join(dependencies.dataDir, "projects", projectId, "assets", id);
  const filePath = path.join(directory, safeName);
  await mkdir(directory, { recursive: true });
  await pipeline(part.file, createWriteStream(filePath, { flags: "wx" }));
  const key = `projects/${projectId}/assets/${id}/${safeName}`;
  await dependencies.objects.putFile(key, filePath);
  const now = new Date().toISOString();
  const asset: ProjectAssetRecord = { id, projectId, kind, name: safeName, fileName: safeName, mimeType, size: part.file.bytesRead, url: `/assets/${key}`, createdAt: now, updatedAt: now };
  return dependencies.store.saveAsset(projectId, asset);
}
