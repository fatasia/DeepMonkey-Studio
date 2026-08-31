import type { FastifyInstance } from "fastify";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import type { PprBopService } from "./pprBopService.js";

export async function registerPprBopRoutes(app: FastifyInstance, dependencies: { store: MetadataStore; service: PprBopService }): Promise<void> {
  const requireProject = (projectId: string) => {
    if (!dependencies.store.getProject(projectId)) throw new Error("项目不存在");
  };

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/ppr/bop-versions", async (request) => {
    requireProject(request.params.projectId);
    return dependencies.service.list(request.params.projectId);
  });

  app.post<{ Params: { projectId: string }; Body: PprBopVersionDraft }>("/api/projects/:projectId/ppr/bop-versions", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      return reply.code(201).send(await dependencies.service.create(request.params.projectId, request.body));
    } catch (error) {
      return reply.code(400).send({ message: compactError(error) });
    }
  });

  app.get<{ Params: { projectId: string; versionId: string } }>("/api/projects/:projectId/ppr/bop-versions/:versionId/analysis", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      return dependencies.service.analyze(request.params.projectId, request.params.versionId);
    } catch (error) {
      return reply.code(404).send({ message: compactError(error) });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { beforeVersionId?: string; afterVersionId?: string } }>("/api/projects/:projectId/ppr/bop-versions/compare", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      const beforeVersionId = requiredText(request.body?.beforeVersionId, "基线版本 ID");
      const afterVersionId = requiredText(request.body?.afterVersionId, "目标版本 ID");
      return dependencies.service.compare(request.params.projectId, beforeVersionId, afterVersionId);
    } catch (error) {
      return reply.code(400).send({ message: compactError(error) });
    }
  });
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, " ").slice(0, 500);
}
