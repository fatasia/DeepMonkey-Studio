import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  assertApplicationDocument,
  assertPathSafeResourceId,
  type ApplicationDocument
} from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";

type ProjectParams = { projectId: string };
type ApplicationParams = ProjectParams & { applicationId: string };
type PublicationParams = ApplicationParams & { publicationId: string };

function requireProject(store: MetadataStore, projectId: string, reply: FastifyReply): boolean {
  if (!validateResourceId(projectId, "projectId", reply)) return false;
  if (store.getProject(projectId)) return true;
  void reply.code(404).send({ message: "项目不存在" });
  return false;
}

function validateResourceId(value: string, label: string, reply: FastifyReply): boolean {
  try {
    assertPathSafeResourceId(value, label);
    return true;
  } catch (error) {
    void reply.code(400).send({ message: error instanceof Error ? error.message : `${label} 无效` });
    return false;
  }
}

function validateDocument(value: unknown, reply: FastifyReply): ApplicationDocument | undefined {
  try {
    assertApplicationDocument(value);
    return value;
  } catch (error) {
    void reply.code(400).send({ message: error instanceof Error ? error.message : "应用格式无效" });
    return undefined;
  }
}

export async function registerApplicationRoutes(app: FastifyInstance, store: MetadataStore): Promise<void> {
  app.get<{ Params: ProjectParams }>("/api/projects/:projectId/applications", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    return store.listApplications(request.params.projectId);
  });

  app.post<{ Params: ProjectParams; Body: unknown }>("/api/projects/:projectId/applications", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    const body = validateDocument(request.body, reply);
    if (!body) return reply;
    const result = await store.createApplicationDraft(request.params.projectId, body, new Date().toISOString());
    if (result.status === "project-not-found") return reply.code(404).send({ message: "项目不存在" });
    if (result.status === "conflict") {
      return reply.code(409).send({ message: "应用 ID 已存在", currentRevision: result.reservation.currentRevision });
    }
    return reply.code(201).send(result.application);
  });

  app.get<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    if (!validateResourceId(request.params.applicationId, "applicationId", reply)) return reply;
    const application = store.getApplication(request.params.projectId, request.params.applicationId);
    return application ?? reply.code(404).send({ message: "应用不存在" });
  });

  app.put<{ Params: ApplicationParams; Body: unknown }>("/api/projects/:projectId/applications/:applicationId", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    if (!validateResourceId(request.params.applicationId, "applicationId", reply)) return reply;
    const body = validateDocument(request.body, reply);
    if (!body) return reply;
    const result = await store.updateApplicationDraft(
      request.params.projectId,
      request.params.applicationId,
      body,
      new Date().toISOString()
    );
    if (result.status === "project-not-found") return reply.code(404).send({ message: "项目不存在" });
    if (result.status === "application-not-found") return reply.code(404).send({ message: "应用不存在" });
    if (result.status === "revision-conflict") {
      return reply.code(409).send({ message: "应用已被其他修改更新", currentRevision: result.currentRevision });
    }
    return result.application;
  });

  app.delete<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    if (!validateResourceId(request.params.applicationId, "applicationId", reply)) return reply;
    const result = await store.deleteApplicationDraft(request.params.projectId, request.params.applicationId);
    if (result.status === "project-not-found") return reply.code(404).send({ message: "项目不存在" });
    if (result.status === "application-not-found") return reply.code(404).send({ message: "应用不存在" });
    if (result.status === "active-publication") return reply.code(409).send({ message: "请先撤回应用发布版本" });
    return reply.code(204).send();
  });

  app.post<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId/publish", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    if (!validateResourceId(request.params.applicationId, "applicationId", reply)) return reply;
    const publishedAt = new Date().toISOString();
    const result = await store.publishApplication(
      request.params.projectId,
      request.params.applicationId,
      randomUUID(),
      publishedAt
    );
    if (result.status === "project-not-found") return reply.code(404).send({ message: "项目不存在" });
    if (result.status === "application-not-found") return reply.code(404).send({ message: "应用不存在" });
    return reply.code(201).send(result.publication);
  });

  app.delete<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId/publish", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    if (!validateResourceId(request.params.applicationId, "applicationId", reply)) return reply;
    const result = await store.unpublishApplication(request.params.projectId, request.params.applicationId);
    if (result.status === "project-not-found") return reply.code(404).send({ message: "项目不存在" });
    if (result.status === "application-not-found") return reply.code(404).send({ message: "应用不存在" });
    if (result.status === "not-published") return reply.code(404).send({ message: "应用尚未发布" });
    return reply.code(204).send();
  });

  app.get<{ Params: { applicationId: string } }>("/api/public/applications/:applicationId", async (request, reply) => {
    if (!validateResourceId(request.params.applicationId, "applicationId", reply)) return reply;
    const pointer = store.getApplicationPublicationPointer(request.params.applicationId);
    if (!pointer) return reply.code(404).send({ message: "应用尚未发布或已撤回" });
    const record = store.getPublishedApplication(pointer.activePublicationId);
    if (!store.getProject(pointer.projectId)
      || !store.getApplication(pointer.projectId, request.params.applicationId)
      || !record
      || record.applicationId !== request.params.applicationId
      || record.projectId !== pointer.projectId) {
      return reply.code(404).send({ message: "应用尚未发布或已撤回" });
    }
    return record;
  });

  app.get<{ Params: PublicationParams }>("/api/public/applications/:applicationId/revisions/:publicationId", async (request, reply) => {
    if (!validateResourceId(request.params.applicationId, "applicationId", reply)) return reply;
    const record = store.getPublishedApplication(request.params.publicationId);
    if (!record
      || !store.getProject(record.projectId)
      || record.applicationId !== request.params.applicationId
      || record.id !== request.params.publicationId) {
      return reply.code(404).send({ message: "应用发布版本不存在" });
    }
    return record;
  });
}
