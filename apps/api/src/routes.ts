import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import {
  supportedExtensions,
  type ModelFormat,
  type ModelRecord,
  type RvtConversionMode,
  type PublishedSceneRecord,
  type SceneSnapshot
} from "@bim-studio/contracts";
import type { ConversionQueue } from "./conversion.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";

interface RouteDependencies {
  store: MetadataStore;
  queue: ConversionQueue;
  objects: ObjectStore;
  dataDir: string;
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
  const { store, queue, objects, dataDir } = dependencies;

  app.get("/health", async () => ({ status: "ok", service: "bim-studio-api" }));

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

  app.get("/api/projects", async () => store.listProjects());
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

  app.post<{ Params: { projectId: string }; Querystring: { rvtConversionMode?: string } }>("/api/projects/:projectId/models", async (request, reply) => {
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
    await objects.putFile(`projects/${project.id}/models/${modelId}/source/${safeName}`, sourcePath);
    const now = new Date().toISOString();
    const model: ModelRecord = {
      id: modelId,
      projectId: project.id,
      name: safeName,
      format,
      ...(rvtConversionMode ? { rvtConversionMode } : {}),
      size: part.file.bytesRead,
      status: "queued",
      progress: 0,
      message: "等待转换",
      sourceUrl: `/assets/projects/${project.id}/models/${modelId}/source/${encodeURIComponent(safeName)}`,
      createdAt: now,
      updatedAt: now
    };
    await store.addModel(project.id, model);
    queue.enqueue({ model, sourcePath, modelDir });
    return reply.code(202).send(model);
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
