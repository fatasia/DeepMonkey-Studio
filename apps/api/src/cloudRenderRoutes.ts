import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertPathSafeResourceId, type PublishedSceneRecord } from "@bim-studio/contracts";
import type { CloudRenderControlPlane } from "./cloudRenderControl.js";
import { CloudRenderControlError } from "./cloudRenderControl.js";
import type { MetadataStore } from "./store.js";

interface Dependencies {
  store: MetadataStore;
  control: CloudRenderControlPlane;
}

type SceneParams = { sceneId: string };

export async function registerCloudRenderRoutes(app: FastifyInstance, dependencies: Dependencies): Promise<void> {
  const { store, control } = dependencies;

  app.get("/api/admin/cloud-render", async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return control.overview(listPublishedScenes(store));
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
