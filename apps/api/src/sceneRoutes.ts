import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import { createPublishedSceneBrowseRecord } from "./publishedSceneBundle.js";

interface SceneRouteDependencies {
  store: MetadataStore;
  beforeDiscardPublication?: (publication: PublishedSceneRecord) => Promise<void>;
  afterPublish?: (publication: PublishedSceneRecord) => Promise<void>;
}

/** 场景草稿与发布路由保持在同一边界，确保替换线上版本前统一回收云渲染会话。 */
export async function registerSceneRoutes(app: FastifyInstance, dependencies: SceneRouteDependencies): Promise<void> {
  const { store, beforeDiscardPublication, afterPublish } = dependencies;

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
      const currentPublication = store.getPublication(source.id);
      if (currentPublication && beforeDiscardPublication) {
        try { await beforeDiscardPublication(currentPublication); }
        catch (reason) { return reply.code(502).send({ message: reason instanceof Error ? reason.message : "无法停止旧云渲染会话" }); }
      }
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
      const saved = await store.savePublication(publication);
      if (afterPublish) {
        try { await afterPublish(saved); }
        catch (reason) { request.log.warn({ reason, sceneId: saved.sceneId }, "publication notification failed"); }
      }
      return reply.code(201).send(saved);
    }
  );
  app.get<{ Params: { sceneId: string } }>("/api/public/scenes/:sceneId", async (request, reply) => {
    const publication = store.getPublication(request.params.sceneId);
    return publication ?? reply.code(404).send({ message: "场景尚未发布或已删除" });
  });
  app.get<{ Params: { sceneId: string } }>("/api/public/scenes/:sceneId/browse", async (request, reply) => {
    const publication = store.getPublication(request.params.sceneId);
    if (!publication) return reply.code(404).send({ message: "场景尚未发布或已删除" });
    const project = store.getProject(publication.projectId);
    if (!project) return reply.code(404).send({ message: "发布场景所属项目不存在" });
    return createPublishedSceneBrowseRecord(publication, project);
  });
  app.get<{ Params: { projectId: string; sceneId: string } }>("/api/projects/:projectId/scenes/:sceneId/publications", async (request, reply) => {
    const scene = store.getScene(request.params.projectId, request.params.sceneId);
    if (!scene) return reply.code(404).send({ message: "场景不存在" });
    return store.listScenePublications(scene.id);
  });
  app.post<{ Params: { projectId: string; sceneId: string; publishedAt: string } }>("/api/projects/:projectId/scenes/:sceneId/publications/:publishedAt/restore", async (request, reply) => {
    const scene = store.getScene(request.params.projectId, request.params.sceneId);
    if (!scene) return reply.code(404).send({ message: "场景不存在" });
    const historical = store.listScenePublications(scene.id).find((item) => item.publishedAt === decodeURIComponent(request.params.publishedAt));
    if (!historical) return reply.code(404).send({ message: "发布版本不存在" });
    const current = store.getPublication(scene.id);
    if (current && beforeDiscardPublication) {
      try { await beforeDiscardPublication(current); }
      catch (reason) { return reply.code(502).send({ message: reason instanceof Error ? reason.message : "无法停止旧云渲染会话" }); }
    }
    const publishedAt = new Date().toISOString();
    const restored: PublishedSceneRecord = { ...historical, snapshot: { ...structuredClone(historical.snapshot), publishedAt, updatedAt: publishedAt }, publishedAt };
    const saved = await store.savePublication(restored);
    // 恢复历史发布版本不能覆盖当前草稿；这里只同步发布元数据，公开地址继续读取历史快照。
    await store.saveScene({
      ...scene,
      publishedAt,
      publicationMode: restored.snapshot.publicationMode ?? "webgl",
      publicationPerformance: restored.snapshot.publicationPerformance ?? "standard",
      publicationToolbarVisible: restored.snapshot.publicationToolbarVisible !== false
    });
    return reply.code(201).send(saved);
  });
  app.delete<{ Params: { projectId: string; sceneId: string } }>(
    "/api/projects/:projectId/scenes/:sceneId/publish",
    async (request, reply) => {
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const publication = store.getPublication(source.id);
      if (!publication) return reply.code(404).send({ message: "场景尚未发布" });
      if (beforeDiscardPublication) {
        try { await beforeDiscardPublication(publication); }
        catch (reason) { return reply.code(502).send({ message: reason instanceof Error ? reason.message : "无法停止云渲染会话" }); }
      }
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
      const publication = store.getPublication(request.params.sceneId);
      if (publication && beforeDiscardPublication) {
        try { await beforeDiscardPublication(publication); }
        catch (reason) { return reply.code(502).send({ message: reason instanceof Error ? reason.message : "无法停止云渲染会话" }); }
      }
      const removed = await store.removeScene(request.params.projectId, request.params.sceneId);
      if (!removed) return reply.code(404).send({ message: "场景不存在" });
      return reply.code(204).send();
    }
  );
}
