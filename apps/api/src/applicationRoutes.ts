import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  assertApplicationDocument,
  type ApplicationDocument,
  type ApplicationPublicationPointer,
  type PublishedApplicationRecord
} from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";

type ProjectParams = { projectId: string };
type ApplicationParams = ProjectParams & { applicationId: string };
type PublicationParams = ApplicationParams & { publicationId: string };

function requireProject(store: MetadataStore, projectId: string, reply: FastifyReply): boolean {
  if (store.getProject(projectId)) return true;
  void reply.code(404).send({ message: "项目不存在" });
  return false;
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
    const existing = store.getApplicationById(body.metadata.id);
    if (existing) {
      return reply.code(409).send({ message: "应用 ID 已存在", currentRevision: existing.metadata.revision });
    }
    const now = new Date().toISOString();
    const application: ApplicationDocument = {
      ...structuredClone(body),
      metadata: {
        ...structuredClone(body.metadata),
        projectId: request.params.projectId,
        revision: 1,
        createdAt: now,
        updatedAt: now
      }
    };
    return reply.code(201).send(await store.saveApplication(application));
  });

  app.get<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    const application = store.getApplication(request.params.projectId, request.params.applicationId);
    return application ?? reply.code(404).send({ message: "应用不存在" });
  });

  app.put<{ Params: ApplicationParams; Body: unknown }>("/api/projects/:projectId/applications/:applicationId", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    const current = store.getApplication(request.params.projectId, request.params.applicationId);
    if (!current) return reply.code(404).send({ message: "应用不存在" });
    const body = validateDocument(request.body, reply);
    if (!body) return reply;
    if (body.metadata.revision !== current.metadata.revision) {
      return reply.code(409).send({ message: "应用已被其他修改更新", currentRevision: current.metadata.revision });
    }
    const application: ApplicationDocument = {
      ...structuredClone(body),
      metadata: {
        ...structuredClone(body.metadata),
        id: request.params.applicationId,
        projectId: request.params.projectId,
        revision: current.metadata.revision + 1,
        createdAt: current.metadata.createdAt,
        updatedAt: new Date().toISOString()
      }
    };
    return store.saveApplication(application);
  });

  app.delete<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    const current = store.getApplication(request.params.projectId, request.params.applicationId);
    if (!current) return reply.code(404).send({ message: "应用不存在" });
    if (store.getApplicationPublicationPointer(request.params.applicationId)) {
      return reply.code(409).send({ message: "请先撤回应用发布版本" });
    }
    await store.removeApplication(request.params.projectId, request.params.applicationId);
    return reply.code(204).send();
  });

  app.post<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId/publish", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    const current = store.getApplication(request.params.projectId, request.params.applicationId);
    if (!current) return reply.code(404).send({ message: "应用不存在" });
    const publishedAt = new Date().toISOString();
    const record: PublishedApplicationRecord = {
      id: randomUUID(),
      applicationId: current.metadata.id,
      projectId: current.metadata.projectId,
      applicationRevision: current.metadata.revision,
      document: structuredClone(current),
      publishedAt
    };
    const saved = await store.savePublishedApplication(record);
    const pointer: ApplicationPublicationPointer = {
      applicationId: current.metadata.id,
      projectId: current.metadata.projectId,
      activePublicationId: saved.id,
      updatedAt: publishedAt
    };
    await store.saveApplicationPublicationPointer(pointer);
    return reply.code(201).send(saved);
  });

  app.delete<{ Params: ApplicationParams }>("/api/projects/:projectId/applications/:applicationId/publish", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    const current = store.getApplication(request.params.projectId, request.params.applicationId);
    if (!current) return reply.code(404).send({ message: "应用不存在" });
    const pointer = store.getApplicationPublicationPointer(request.params.applicationId);
    if (!pointer || pointer.projectId !== request.params.projectId) {
      return reply.code(404).send({ message: "应用尚未发布" });
    }
    await store.removeApplicationPublicationPointer(request.params.applicationId);
    return reply.code(204).send();
  });

  app.get<{ Params: { applicationId: string } }>("/api/public/applications/:applicationId", async (request, reply) => {
    const pointer = store.getApplicationPublicationPointer(request.params.applicationId);
    if (!pointer) return reply.code(404).send({ message: "应用尚未发布或已撤回" });
    const record = store.getPublishedApplication(pointer.activePublicationId);
    if (!record || record.applicationId !== request.params.applicationId) {
      return reply.code(404).send({ message: "应用尚未发布或已撤回" });
    }
    return record;
  });

  app.get<{ Params: PublicationParams }>("/api/public/applications/:applicationId/revisions/:publicationId", async (request, reply) => {
    const record = store.getPublishedApplication(request.params.publicationId);
    if (!record || record.applicationId !== request.params.applicationId || record.id !== request.params.publicationId) {
      return reply.code(404).send({ message: "应用发布版本不存在" });
    }
    return record;
  });
}
