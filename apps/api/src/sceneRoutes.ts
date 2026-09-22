import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PublishedSceneRecord, SceneSnapshot, SceneClientDependencyExpectation } from "@bim-studio/contracts";
import type { ObjectStore } from "./objects.js";
import { captureScenePublicationDependencies } from "./scenePublicationDependencyCapture.js";
import { registerScenePublicationDependencyRoutes } from "./scenePublicationDependencyRoutes.js";
import type { MetadataStore } from "./store.js";
import { createPublishedSceneBrowseRecord } from "./publishedSceneBundle.js";
import { scenePublicationJsonEqual } from "./scenePublicationStore.js";
import { CloudRenderControlError } from "./cloudRenderControl.js";
import { registerNativeSceneCandidateRoutes, type NativeSceneCandidateService } from "./nativeSceneCandidateRoutes.js";
import { registerSceneStandaloneExecutableRoutes } from "./sceneStandaloneExecutableRoutes.js";
import { registerThreeSceneViewerExecutableRoutes } from "./threeSceneViewerExecutableRoutes.js";

interface SceneRouteDependencies {
  store: MetadataStore;
  deliveryStorage?: { objects: ObjectStore; dataDir: string };
  nativeCandidates?: NativeSceneCandidateService;
  nativeExecutable?: string;
  threeSceneViewerBuilderScript?: string;
  beforeDiscardPublication?: (publication: PublishedSceneRecord) => Promise<void>;
  afterPublish?: (publication: PublishedSceneRecord) => Promise<void>;
}

/** 场景草稿与发布路由保持在同一边界，确保替换线上版本前统一回收云渲染会话。 */
export async function registerSceneRoutes(app: FastifyInstance, dependencies: SceneRouteDependencies): Promise<void> {
  const { store, beforeDiscardPublication, afterPublish } = dependencies;
  await registerNativeSceneCandidateRoutes(app, dependencies.nativeCandidates);
  if (dependencies.deliveryStorage) await registerScenePublicationDependencyRoutes(app, { store, ...dependencies.deliveryStorage });
  if (dependencies.deliveryStorage && dependencies.nativeExecutable) await registerSceneStandaloneExecutableRoutes(app,
    { store, objects: dependencies.deliveryStorage.objects, nativeExecutable: dependencies.nativeExecutable });
  if (dependencies.threeSceneViewerBuilderScript) await registerThreeSceneViewerExecutableRoutes(app,
    { store, builderScript: dependencies.threeSceneViewerBuilderScript });

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
  app.post<{ Params: { projectId: string; sceneId: string }; Body?: { expectedSnapshot?: SceneSnapshot;
    clientTarget?: "three-webview" | "deep-native"; dependencyExpectation?: SceneClientDependencyExpectation; nativeCandidateId?: string } }>(
    "/api/projects/:projectId/scenes/:sceneId/publish",
    async (request, reply) => {
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const expectedSnapshot = request.body?.expectedSnapshot ?? source;
      if (request.body !== undefined && (!request.body?.expectedSnapshot || expectedSnapshot.schemaVersion !== 1)) {
        return reply.code(400).send({ message: "缺少有效的待发布快照" });
      }
      if (!scenePublicationJsonEqual(source, expectedSnapshot)) {
        return reply.code(409).send({ message: "场景已变化，请重新保存并检查后发布" });
      }
      const currentPublication = store.getPublication(source.id);
      if (request.body?.clientTarget !== undefined && !["three-webview", "deep-native"].includes(request.body.clientTarget)) {
        return reply.code(400).send({ message: "客户端目标无效" });
      }
      if (request.body?.clientTarget === "deep-native" && (!request.systemUser || !request.body.nativeCandidateId)) {
        return reply.code(400).send({ message: "Native 客户端发布需要本机窗口验证候选，请重新检查后发布" });
      }
      const cancellation = request.body?.clientTarget ? new AbortController() : undefined;
      const signal = cancellation ? AbortSignal.any([cancellation.signal, AbortSignal.timeout(120_000)]) : undefined;
      const abortRequest = () => cancellation?.abort();
      const closeReply = () => { if (!reply.raw.writableFinished) abortRequest(); };
      if (cancellation) {
        request.raw.once("aborted", abortRequest);
        reply.raw.once("close", closeReply);
        if (request.raw.aborted || reply.raw.destroyed) abortRequest();
      }
      let nativeLease: ReturnType<NativeSceneCandidateService["reserve"]> | undefined;
      try {
        let dependencyCapture;
        if (request.body?.clientTarget === "deep-native") {
          if (!dependencies.nativeCandidates) return reply.code(503).send({ message: "本机 Native 窗口验证未配置" });
          try {
            nativeLease = dependencies.nativeCandidates.reserve(request.body.nativeCandidateId!, request.systemUser!.id, source);
            if (!scenePublicationJsonEqual(nativeLease.value.expectedPublication, currentPublication)) {
              return reply.code(409).send({ message: "发布版本在 Native 验证后已变化，请重新验证" });
            }
            dependencyCapture = nativeLease.value.capture;
          } catch (reason) { return reply.code(409).send({ message: reason instanceof Error ? reason.message : "Native 候选已失效" }); }
        } else if (request.body?.clientTarget) {
          if (!dependencies.deliveryStorage) return reply.code(503).send({ message: "客户端资源存储未配置" });
          try {
            dependencyCapture = await captureScenePublicationDependencies({ store, ...dependencies.deliveryStorage, scene: source,
              ...(request.body.dependencyExpectation ? { expected: request.body.dependencyExpectation } : {}), ...(signal ? { signal } : {}) });
            signal?.throwIfAborted();
          } catch (reason) {
            return reply.code(409).send({ message: reason instanceof Error ? reason.message : "发布资源冻结失败" });
          }
        }
        signal?.throwIfAborted();
        if (currentPublication && beforeDiscardPublication) {
          try { await beforeDiscardPublication(currentPublication); }
          catch (reason) { return discardFailure(reply, reason); }
        }
        signal?.throwIfAborted();
        const result = await store.publishSceneSnapshot({
          projectId: source.projectId, sceneId: source.id, expectedSnapshot,
          expectedPublication: currentPublication, publishedAt: new Date().toISOString(),
          ...(dependencyCapture ? { dependencyCapture } : {}),
        }, signal ? { signal } : undefined);
        if (result.status === "scene-not-found") return reply.code(404).send({ message: "场景不存在" });
        if (result.status !== "published") return reply.code(409).send({ message: "场景或发布版本已变化，请重新检查后发布" });
        const saved = result.publication;
        nativeLease?.commit();
        if (afterPublish) {
          try { await afterPublish(saved); }
          catch (reason) { request.log.warn({ reason, sceneId: saved.sceneId }, "publication notification failed"); }
        }
        return reply.code(201).send(saved);
      } finally {
        nativeLease?.release();
        if (cancellation) {
          request.raw.removeListener("aborted", abortRequest);
          reply.raw.removeListener("close", closeReply);
        }
      }
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
    const candidates = store.listScenePublications(scene.id).filter(item => item.projectId === scene.projectId
      && item.publishedAt === decodeURIComponent(request.params.publishedAt));
    if (!candidates.length) return reply.code(404).send({ message: "发布版本不存在" });
    const historical = candidates[0]!;
    if (candidates.length !== 1 || historical.snapshot.projectId !== scene.projectId || historical.snapshot.id !== scene.id) {
      return reply.code(409).send({ message: "历史版本标识不唯一或与场景不符，无法恢复" });
    }
    const current = store.getPublication(scene.id);
    if (current && beforeDiscardPublication) {
      try { await beforeDiscardPublication(current); }
      catch (reason) { return discardFailure(reply, reason); }
    }
    const result = await store.restoreScenePublication({
      projectId: scene.projectId, sceneId: scene.id, expectedSnapshot: scene,
      expectedPublication: current, historicalPublication: historical, publishedAt: new Date().toISOString(),
    });
    if (result.status === "scene-not-found") return reply.code(404).send({ message: "场景不存在" });
    if (result.status !== "restored") return reply.code(409).send({ message: "草稿、发布版本或历史记录已变化，请重新检查后恢复" });
    return reply.code(201).send(result.publication);
  });
  app.delete<{ Params: { projectId: string; sceneId: string } }>(
    "/api/projects/:projectId/scenes/:sceneId/publish",
    async (request, reply) => {
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const publication = store.getPublication(source.id);
      if (!publication) return reply.code(404).send({ message: "场景尚未发布" });
      if (publication.projectId !== source.projectId) return reply.code(409).send({ message: "发布版本与项目不符，无法撤回" });
      if (beforeDiscardPublication) {
        try { await beforeDiscardPublication(publication); }
        catch (reason) { return discardFailure(reply, reason); }
      }
      const result = await store.discardScene({ projectId: source.projectId, sceneId: source.id,
        expectedSnapshot: source, expectedPublication: publication, action: "unpublish" });
      if (result.status === "scene-not-found" || result.status === "not-published") return reply.code(404).send({ message: "场景不存在或尚未发布" });
      if (result.status !== "discarded") return reply.code(409).send({ message: "场景或发布版本已变化，请重新检查后撤回" });
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
      const source = store.getScene(request.params.projectId, request.params.sceneId);
      if (!source) return reply.code(404).send({ message: "场景不存在" });
      const publication = store.getPublication(source.id);
      if (publication && publication.projectId !== source.projectId) return reply.code(409).send({ message: "发布版本与项目不符，无法删除" });
      if (publication && beforeDiscardPublication) {
        try { await beforeDiscardPublication(publication); }
        catch (reason) { return discardFailure(reply, reason); }
      }
      const result = await store.discardScene({ projectId: source.projectId, sceneId: source.id,
        expectedSnapshot: source, expectedPublication: publication, action: "delete" });
      if (result.status === "scene-not-found") return reply.code(404).send({ message: "场景不存在" });
      if (result.status !== "discarded") return reply.code(409).send({ message: "场景或发布版本已变化，请重新检查后删除" });
      return reply.code(204).send();
    }
  );
}

function discardFailure(reply: FastifyReply, reason: unknown): FastifyReply {
  return reply.code(reason instanceof CloudRenderControlError ? reason.statusCode : 502).send({
    message: reason instanceof Error ? reason.message : "无法停止云渲染会话",
    ...(reason instanceof CloudRenderControlError ? { code: reason.code } : {}),
  });
}
