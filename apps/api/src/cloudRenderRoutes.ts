import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertPathSafeResourceId, type PublishedSceneRecord } from "@bim-studio/contracts";
import { HttpCloudRenderWorkerClient, type CloudRenderWorkerClient, type HttpCloudRenderWorkerClientOptions } from "@bim-studio/server-sdk";
import type { CloudRenderControlPlane } from "./cloudRenderControl.js";
import { CloudRenderControlError } from "./cloudRenderControl.js";
import type { MetadataStore } from "./store.js";

interface Dependencies {
  store: MetadataStore;
  control: CloudRenderControlPlane;
  createWorkerClient?: (options: HttpCloudRenderWorkerClientOptions) => Pick<CloudRenderWorkerClient, "health">;
}

type SceneParams = { sceneId: string };

export async function registerCloudRenderRoutes(app: FastifyInstance, dependencies: Dependencies): Promise<void> {
  const { store, control } = dependencies;
  const createWorkerClient = dependencies.createWorkerClient ?? ((options: HttpCloudRenderWorkerClientOptions) => new HttpCloudRenderWorkerClient(options));

  // 登录用户即可读：发布弹窗与场景开关用它判断可用性，避免把 admin 403 误判成“未配置”。
  app.get("/api/cloud-render/capability", async () => {
    return control.capability();
  });

  app.get("/api/admin/cloud-render", async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return control.overview(listPublishedScenes(store));
  });

  app.post<{ Body: { workerUrl?: unknown; workerToken?: unknown; publicOrigin?: unknown } }>("/api/admin/cloud-render/configuration/test", async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const workerUrl = requiredHttpUrl(request.body?.workerUrl, "Worker URL", reply);
    const publicOrigin = requiredHttpUrl(request.body?.publicOrigin, "Public Origin", reply, true);
    const workerToken = typeof request.body?.workerToken === "string" ? request.body.workerToken.trim() : "";
    if (!workerUrl || !publicOrigin) return reply;
    if (!workerToken) return reply.code(400).send({ message: "Worker Token 不能为空", code: "invalid_worker_token" });
    try {
      const worker = await createWorkerClient({ baseUrl: workerUrl, token: workerToken, timeoutMs: 5_000 }).health();
      return { ok: worker.status === "ready", worker, publicOrigin };
    } catch (reason) {
      return reply.code(502).send({ message: `GPU Worker 连接测试失败：${redactSecret(errorMessage(reason), workerToken)}`, code: "worker_test_failed" });
    }
  });

  app.patch<{ Params: SceneParams; Body: { enabled?: unknown } }>("/api/admin/cloud-render/scenes/:sceneId", async (request, reply) => {
    if (!requireAdmin(request, reply) || !validSceneId(request.params.sceneId, reply)) return reply;
    if (typeof request.body?.enabled !== "boolean") return reply.code(400).send({ message: "enabled 必须是布尔值", code: "invalid_request" });
    const publication = requirePublication(store, request.params.sceneId, reply);
    if (!publication) return reply;
    try { return await control.setEnabled(publication, request.body.enabled); }
    catch (reason) { return sendControlError(reply, reason); }
  });

  app.post<{ Params: SceneParams }>("/api/admin/cloud-render/scenes/:sceneId/sessions", async (request, reply) => {
    if (!requireAdmin(request, reply) || !validSceneId(request.params.sceneId, reply)) return reply;
    const publication = requirePublication(store, request.params.sceneId, reply);
    if (!publication) return reply;
    try { return reply.code(201).send(await control.startSession(publication, request.systemUser!.id)); }
    catch (reason) { return sendControlError(reply, reason); }
  });

  app.get<{ Params: SceneParams }>("/api/admin/cloud-render/scenes/:sceneId/sessions/current", async (request, reply) => {
    if (!requireAdmin(request, reply) || !validSceneId(request.params.sceneId, reply)) return reply;
    const publication = requirePublication(store, request.params.sceneId, reply);
    if (!publication) return reply;
    try {
      const session = await control.refreshSession(publication);
      return session ?? reply.code(404).send({ message: "该发布场景没有云渲染会话", code: "session_not_found" });
    } catch (reason) { return sendControlError(reply, reason); }
  });

  app.delete<{ Params: SceneParams }>("/api/admin/cloud-render/scenes/:sceneId/sessions/current", async (request, reply) => {
    if (!requireAdmin(request, reply) || !validSceneId(request.params.sceneId, reply)) return reply;
    const publication = requirePublication(store, request.params.sceneId, reply);
    if (!publication) return reply;
    try {
      const session = await control.stopSession(publication.sceneId);
      return session ? reply.code(204).send() : reply.code(404).send({ message: "该发布场景没有云渲染会话", code: "session_not_found" });
    } catch (reason) { return sendControlError(reply, reason); }
  });
}

function requiredHttpUrl(value: unknown, label: string, reply: FastifyReply, originOnly = false): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    void reply.code(400).send({ message: `${label} 不能为空`, code: "invalid_cloud_render_url" });
    return undefined;
  }
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || (originOnly && (parsed.pathname !== "/" || parsed.search))) throw new Error();
    return originOnly ? parsed.origin : parsed.toString().replace(/\/$/, "");
  } catch {
    void reply.code(400).send({ message: `${label} 必须是无凭据的完整 HTTP(S) 地址${originOnly ? "，且 Public Origin 不能包含路径或查询" : ""}`, code: "invalid_cloud_render_url" });
    return undefined;
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "[REDACTED]") : value;
}

function listPublishedScenes(store: MetadataStore): PublishedSceneRecord[] {
  return store.listProjects().flatMap((project) => store.listScenes(project.id)
    .flatMap((scene) => {
      const publication = store.getPublication(scene.id);
      return publication ? [publication] : [];
    }));
}

function requirePublication(store: MetadataStore, sceneId: string, reply: FastifyReply): PublishedSceneRecord | undefined {
  const publication = store.getPublication(sceneId);
  if (!publication) void reply.code(404).send({ message: "场景尚未发布，不能开启云渲染", code: "publication_not_found" });
  return publication;
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.systemUser?.role === "admin") return true;
  void reply.code(403).send({ message: "需要管理员权限", code: "admin_required" });
  return false;
}

function validSceneId(sceneId: string, reply: FastifyReply): boolean {
  try { assertPathSafeResourceId(sceneId, "sceneId"); return true; }
  catch (reason) {
    void reply.code(400).send({ message: reason instanceof Error ? reason.message : "sceneId 无效", code: "invalid_scene_id" });
    return false;
  }
}

function sendControlError(reply: FastifyReply, reason: unknown) {
  if (reason instanceof CloudRenderControlError) return reply.code(reason.statusCode).send({ message: reason.message, code: reason.code });
  return reply.code(500).send({ message: reason instanceof Error ? reason.message : String(reason), code: "cloud_render_control_error" });
}
