import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import {
  assertPathSafeResourceId,
  supportedExtensions,
  type DataConnectionRecord,
  type DataDatasetRecord,
  type ModelFormat,
  type ModelRecord,
  type ProjectAssetRecord,
  type RvtConversionMode,
  type PublishedSceneRecord,
  type SceneSnapshot
} from "@bim-studio/contracts";
import { compileFormula } from "@bim-studio/data-runtime";
import { executeRowScript } from "@bim-studio/data-runtime/script";
import type { AppConfig } from "./config.js";
import { demoSensorRows, previewDataset } from "./dataIntegration.js";
import type { ConversionQueue } from "./conversion.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { discoverRevitInstallations, getRevitRuntimeInfo, inspectRvtVersion, resolveRevitVersion } from "./revit.js";

interface RouteDependencies {
  store: MetadataStore;
  queue: ConversionQueue;
  objects: ObjectStore;
  dataDir: string;
  config: AppConfig;
}

function cleanFileName(fileName: string): string {
  const normalized = path.basename(fileName).normalize("NFKC");
  return normalized.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180) || "model";
}

function modelFormat(fileName: string): ModelFormat | undefined {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  return supportedExtensions.find((item) => item === extension);
}

export async function registerRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  const { store, queue, objects, dataDir, config } = dependencies;

  app.addHook("preValidation", async (request, reply) => {
    const params = request.params;
    if (!params || typeof params !== "object" || !("projectId" in params)) return;
    try {
      assertPathSafeResourceId((params as { projectId?: unknown }).projectId, "projectId");
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "projectId 无效" });
    }
  });

  app.get("/health", async () => ({ status: "ok", service: "bim-studio-api" }));
  app.get("/api/revit/installations", async () => getRevitRuntimeInfo());

  app.post<{ Body: { sourceUrl?: string; playback?: "hls" | "webrtc" } }>("/api/live-monitor/resolve", async (request, reply) => {
    const sourceUrl = request.body?.sourceUrl?.trim();
    if (!sourceUrl || !isSupportedLiveSource(sourceUrl)) return reply.code(400).send({ message: "监控地址支持 RTSP、RTMP、SRT、HLS、WHEP、RTP 与 MPEG-TS" });
    const streamPath = `bim-${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)}`;
    const controlBase = (process.env.MEDIA_GATEWAY_CONTROL_URL ?? "http://127.0.0.1:9997").replace(/\/$/, "");
    const addUrl = `${controlBase}/v3/config/paths/add/${encodeURIComponent(streamPath)}`;
    const response = await fetch(addUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: sourceUrl, sourceOnDemand: true }), signal: AbortSignal.timeout(5_000) }).catch((reason) => { throw new Error(`实时监控服务不可用：${reason instanceof Error ? reason.message : String(reason)}`); });
    if (!response.ok && response.status !== 400) throw new Error(`实时监控服务配置失败：HTTP ${response.status}`);
    if (response.status === 400) {
      const patchResponse = await fetch(`${controlBase}/v3/config/paths/patch/${encodeURIComponent(streamPath)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: sourceUrl, sourceOnDemand: true }), signal: AbortSignal.timeout(5_000) });
      if (!patchResponse.ok) throw new Error(`实时监控服务更新失败：HTTP ${patchResponse.status}`);
    }
    const host = request.hostname || "127.0.0.1";
    const hlsBase = (process.env.MEDIA_GATEWAY_HLS_URL ?? `https://${host}:8888`).replace(/\/$/, "");
    const webRtcBase = (process.env.MEDIA_GATEWAY_WEBRTC_URL ?? `https://${host}:8889`).replace(/\/$/, "");
    return { path: streamPath, hlsUrl: `${hlsBase}/${streamPath}/index.m3u8`, webRtcUrl: `${webRtcBase}/${streamPath}` };
  });
  app.get("/api/demo/sensors", async () => ({ items: await demoSensorRows(config), generatedAt: new Date().toISOString() }));

  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const key = decodeURIComponent(request.params["*"]);
    if (!key || key.split(/[\\/]/).includes("..") || !await objects.stat(key)) {
      return reply.code(404).send({ message: "文件不存在" });
    }
    const acceptsGzip = request.headers["accept-encoding"]?.includes("gzip") ?? false;
    const gzipKey = `${key}.gz`;
    const useGzip = acceptsGzip && key.toLowerCase().endsWith(".json") && await objects.stat(gzipKey);
    const result = await objects.read(useGzip ? gzipKey : key);
    void result.completed.catch((error) => request.log.error(error));
    if (useGzip) reply.header("Content-Encoding", "gzip").header("Vary", "Accept-Encoding");
    return reply.type(contentType(key)).send(result.stream);
  });

  app.get("/api/projects", async (request) => {
    const projects = store.listProjects();
    return request.systemUser?.role === "admin" ? projects : projects.filter((project) => request.systemUser?.projectIds.includes(project.id));
  });
  app.post<{ Body: { name?: string; description?: string } }>("/api/projects", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ message: "项目名称不能为空" });
    return reply.code(201).send(await store.createProject(name, request.body.description?.trim() ?? ""));
  });
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
    const project = store.getProject(request.params.projectId);
    return project ?? reply.code(404).send({ message: "项目不存在" });
  });
  app.patch<{ Params: { projectId: string }; Body: { name?: string; description?: string } }>("/api/projects/:projectId", async (request, reply) => {
    const current = store.getProject(request.params.projectId);
    if (!current) return reply.code(404).send({ message: "项目不存在" });
    const name = request.body?.name?.trim();
    if (request.body?.name !== undefined && !name) return reply.code(400).send({ message: "项目名称不能为空" });
    return store.updateProject(request.params.projectId, {
      ...(name ? { name } : {}),
      ...(request.body?.description !== undefined ? { description: request.body.description.trim() } : {})
    });
  });
  app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
    const removed = await store.removeProject(request.params.projectId);
    if (!removed) return reply.code(404).send({ message: "项目不存在" });
    await objects.removePrefix(`projects/${request.params.projectId}`);
    await rm(path.join(dataDir, "projects", request.params.projectId), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/data-connections", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listDataConnections(request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: Partial<DataConnectionRecord> }>("/api/projects/:projectId/data-connections", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const name = request.body.name?.trim();
    if (!name || !request.body.type) return reply.code(400).send({ message: "连接名称和类型不能为空" });
    const now = new Date().toISOString();
    const connection: DataConnectionRecord = { id: request.body.id || randomUUID(), projectId: request.params.projectId, name, type: request.body.type, enabled: request.body.enabled !== false, config: request.body.config ?? {}, createdAt: request.body.createdAt ?? now, updatedAt: now };
    return reply.code(201).send(await store.saveDataConnection(request.params.projectId, connection));
  });
  app.delete<{ Params: { projectId: string; connectionId: string } }>("/api/projects/:projectId/data-connections/:connectionId", async (request, reply) => {
    return await store.removeDataConnection(request.params.projectId, request.params.connectionId) ? reply.code(204).send() : reply.code(404).send({ message: "数据连接不存在" });
  });
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/datasets", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listDatasets(request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: Partial<DataDatasetRecord> }>("/api/projects/:projectId/datasets", async (request, reply) => {
    const name = request.body.name?.trim();
    if (!name || !request.body.connectionId) return reply.code(400).send({ message: "数据集名称和连接不能为空" });
    const computedFields = request.body.computedFields ?? [];
    const computedKeys = computedFields.map((field) => field.key.trim());
    if (computedKeys.some((key) => !key) || new Set(computedKeys).size !== computedKeys.length) return reply.code(400).send({ message: "计算字段名不能为空或重复" });
    try {
      for (const field of computedFields) {
        if (field.mode === "script") await executeRowScript(field.formula, []);
        else compileFormula(field.formula);
      }
    } catch (reason) {
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "计算字段公式无效" });
    }
    const now = new Date().toISOString();
    const dataset: DataDatasetRecord = { id: request.body.id || randomUUID(), projectId: request.params.projectId, connectionId: request.body.connectionId, name, ...(request.body.query !== undefined ? { query: request.body.query } : {}), ...(request.body.sourceKey !== undefined ? { sourceKey: request.body.sourceKey } : {}), refreshSeconds: Math.max(0, Number(request.body.refreshSeconds ?? 10)), fields: request.body.fields ?? [], ...(computedFields.length ? { computedFields: computedFields.map((field) => ({ ...field, key: field.key.trim(), label: field.label.trim() || field.key.trim(), formula: field.formula.trim() })) } : {}), createdAt: request.body.createdAt ?? now, updatedAt: now };
    return reply.code(201).send(await store.saveDataset(request.params.projectId, dataset));
  });
  app.get<{ Params: { projectId: string; datasetId: string } }>("/api/projects/:projectId/datasets/:datasetId/preview", async (request, reply) => {
    const dataset = store.listDatasets(request.params.projectId).find((item) => item.id === request.params.datasetId);
    if (!dataset) return reply.code(404).send({ message: "数据集不存在" });
    const connection = store.listDataConnections(request.params.projectId).find((item) => item.id === dataset.connectionId);
    if (!connection) return reply.code(404).send({ message: "数据连接不存在" });
    return previewDataset(config, connection, dataset);
  });
  app.delete<{ Params: { projectId: string; datasetId: string } }>("/api/projects/:projectId/datasets/:datasetId", async (request, reply) => {
    return await store.removeDataset(request.params.projectId, request.params.datasetId) ? reply.code(204).send() : reply.code(404).send({ message: "数据集不存在" });
  });

  app.post<{ Params: { projectId: string }; Querystring: { rvtConversionMode?: string; rvtRevitVersion?: string } }>("/api/projects/:projectId/models", async (request, reply) => {
    const project = store.getProject(request.params.projectId);
    if (!project) return reply.code(404).send({ message: "项目不存在" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择模型文件" });
    const format = modelFormat(part.filename);
    if (!format) {
      part.file.resume();
      return reply.code(415).send({ message: `不支持该格式，仅支持 ${supportedExtensions.join(", ")}` });
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
    await pipeline(part.file, createWriteStream(sourcePath, { flags: "wx" }));
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
      size: part.file.bytesRead,
      status: "queued",
      progress: 0,
      message: rvtRevitVersion ? `等待 Revit ${rvtRevitVersion} 转换` : "等待转换",
      sourceUrl: `/assets/projects/${project.id}/models/${modelId}/source/${encodeURIComponent(safeName)}`,
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
    const id = randomUUID();
    const safeName = cleanFileName(part.filename);
    const directory = path.join(dataDir, "projects", project.id, "assets", id);
    const filePath = path.join(directory, safeName);
    await mkdir(directory, { recursive: true });
    await pipeline(part.file, createWriteStream(filePath, { flags: "wx" }));
    const key = `projects/${project.id}/assets/${id}/${safeName}`;
    await objects.putFile(key, filePath);
    const now = new Date().toISOString();
    const asset: ProjectAssetRecord = { id, projectId: project.id, kind: "image", name: safeName, fileName: safeName, mimeType, size: part.file.bytesRead, url: `/assets/${key}`, createdAt: now, updatedAt: now };
    return reply.code(201).send(await store.saveAsset(project.id, asset));
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
    const id = randomUUID();
    const safeName = cleanFileName(part.filename);
    const directory = path.join(dataDir, "projects", project.id, "assets", id);
    const filePath = path.join(directory, safeName);
    await mkdir(directory, { recursive: true });
    await pipeline(part.file, createWriteStream(filePath, { flags: "wx" }));
    const key = `projects/${project.id}/assets/${id}/${safeName}`;
    await objects.putFile(key, filePath);
    const now = new Date().toISOString();
    const asset: ProjectAssetRecord = { id, projectId: project.id, kind: "video", name: safeName, fileName: safeName, mimeType, size: part.file.bytesRead, url: `/assets/${key}`, createdAt: now, updatedAt: now };
    return reply.code(201).send(await store.saveAsset(project.id, asset));
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

  app.delete<{ Params: { projectId: string; modelId: string } }>(
    "/api/projects/:projectId/models/:modelId",
    async (request, reply) => {
      const removed = await store.removeModel(request.params.projectId, request.params.modelId);
      if (!removed) return reply.code(404).send({ message: "模型不存在" });
      const modelDir = path.join(dataDir, "projects", request.params.projectId, "models", request.params.modelId);
      await objects.removePrefix(`projects/${request.params.projectId}/models/${request.params.modelId}`);
      await rm(modelDir, { recursive: true, force: true });
      return reply.code(204).send();
    }
  );

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/scenes", async (request) =>
    store.listScenes(request.params.projectId)
  );
  app.get<{ Params: { projectId: string; sceneId: string } }>(
    "/api/projects/:projectId/scenes/:sceneId",
    async (request, reply) => {
      const scene = store.getScene(request.params.projectId, request.params.sceneId);
      return scene ?? reply.code(404).send({ message: "场景不存在" });
    }
  );
  app.put<{ Params: { projectId: string; sceneId: string }; Body: SceneSnapshot }>(
    "/api/projects/:projectId/scenes/:sceneId",
    async (request, reply) => {
      if (!request.body || request.body.schemaVersion !== 1) {
        return reply.code(400).send({ message: "场景格式无效" });
      }
      const existing = store.getScene(request.params.projectId, request.params.sceneId);
      const now = new Date().toISOString();
      const publishedAt = request.body.publishedAt ?? existing?.publishedAt;
      const scene: SceneSnapshot = {
        ...request.body,
        id: request.params.sceneId,
        projectId: request.params.projectId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(publishedAt ? { publishedAt } : {})
      };
      return store.saveScene(scene);
    }
  );
  app.post<{ Params: { projectId: string }; Body: SceneSnapshot }>(
    "/api/projects/:projectId/scenes/import",
    async (request, reply) => {
      if (!request.body || request.body.schemaVersion !== 1) {
        return reply.code(400).send({ message: "场景格式无效" });
      }
      const now = new Date().toISOString();
      const { publishedAt: _publishedAt, ...importedBody } = request.body;
      const scene: SceneSnapshot = {
        ...importedBody,
        id: randomUUID(),
        projectId: request.params.projectId,
        createdAt: now,
        updatedAt: now
      };
      return reply.code(201).send(await store.saveScene(scene));
    }
  );
  app.post<{ Params: { projectId: string; sceneId: string }; Body?: { name?: string } }>(
    "/api/projects/:projectId/scenes/:sceneId/copy",
    async (request, reply) => {
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const now = new Date().toISOString();
      const requestedName = request.body?.name?.trim();
      const { publishedAt: _publishedAt, ...sourceBody } = source;
      const copy: SceneSnapshot = {
        ...structuredClone(sourceBody),
        id: randomUUID(),
        name: requestedName || `${source.name} - 副本`,
        createdAt: now,
        updatedAt: now
      };
      return reply.code(201).send(await store.saveScene(copy));
    }
  );
  app.patch<{ Params: { projectId: string; sceneId: string }; Body: { name?: string } }>(
    "/api/projects/:projectId/scenes/:sceneId",
    async (request, reply) => {
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const name = request.body?.name?.trim();
      if (!name) return reply.code(400).send({ message: "场景名称不能为空" });
      return store.saveScene({ ...source, name, updatedAt: new Date().toISOString() });
    }
  );
  app.post<{ Params: { projectId: string; sceneId: string } }>(
    "/api/projects/:projectId/scenes/:sceneId/publish",
    async (request, reply) => {
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const publishedAt = new Date().toISOString();
      const publishedScene: SceneSnapshot = { ...source, publishedAt, updatedAt: publishedAt };
      await store.saveScene(publishedScene);
      const publication: PublishedSceneRecord = {
        sceneId: publishedScene.id,
        projectId: publishedScene.projectId,
        name: publishedScene.name,
        snapshot: structuredClone(publishedScene),
        publishedAt
      };
      return reply.code(201).send(await store.savePublication(publication));
    }
  );
  app.get<{ Params: { sceneId: string } }>("/api/public/scenes/:sceneId", async (request, reply) => {
    const publication = store.getPublication(request.params.sceneId);
    return publication ?? reply.code(404).send({ message: "场景尚未发布或已删除" });
  });
  app.delete<{ Params: { projectId: string; sceneId: string } }>(
    "/api/projects/:projectId/scenes/:sceneId/publish",
    async (request, reply) => {
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const removed = await store.removePublication(source.id);
      if (!removed) return reply.code(404).send({ message: "场景尚未发布" });
      return reply.code(204).send();
    }
  );
  app.get<{ Params: { sceneId: string } }>("/api/scenes/:sceneId/browse", async (request, reply) => {
    const scene = store.getSceneById(request.params.sceneId);
    if (!scene) return reply.code(404).send({ message: "场景不存在" });
    const project = store.getProject(scene.projectId);
    if (!project) return reply.code(404).send({ message: "场景所属项目不存在" });
    return { scene, project };
  });
  app.delete<{ Params: { projectId: string; sceneId: string } }>(
    "/api/projects/:projectId/scenes/:sceneId",
    async (request, reply) => {
      const removed = await store.removeScene(request.params.projectId, request.params.sceneId);
      if (!removed) return reply.code(404).send({ message: "场景不存在" });
      return reply.code(204).send();
    }
  );
}

function contentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const imageType = imageContentType(extension);
  if (imageType) return imageType;
  const videoType = videoContentType(extension);
  if (videoType) return videoType;
  if (extension === ".json" || extension === ".gltf") return "application/json; charset=utf-8";
  if (extension === ".glb") return "model/gltf-binary";
  if (extension === ".ifc") return "application/x-step";
  if (extension === ".fbx") return "application/octet-stream";
  if (extension === ".dxf") return "application/dxf";
  if (extension === ".dwg") return "application/acad";
  if (extension === ".step" || extension === ".stp") return "model/step";
  if (extension === ".rvt") return "application/octet-stream";
  return "application/octet-stream";
}

function imageContentType(extension: string): string | undefined {
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" } as Record<string, string>)[extension];
}

function videoContentType(extension: string): string | undefined {
  return ({ ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime" } as Record<string, string>)[extension];
}

function isSupportedLiveSource(value: string): boolean {
  return /^(rtsps?|rtmps?|srt|wheps?|https?|udp\+mpegts|udp\+rtp):\/\//i.test(value);
}
