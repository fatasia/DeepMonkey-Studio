import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "./store.js";
import type { PprBopService } from "./pprBopService.js";
import type { OperationsService } from "./operations.js";
import { assessStudyChangeImpact } from "./studyChangeImpact.js";

export async function registerPprBopRoutes(app: FastifyInstance, dependencies: { store: MetadataStore; service: PprBopService; operations?: OperationsService }): Promise<void> {
  const requireProject = (projectId: string) => {
    if (!dependencies.store.getProject(projectId)) throw new Error("项目不存在");
  };

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/ppr/bop-versions", async (request) => {
    requireProject(request.params.projectId);
    return dependencies.service.list(request.params.projectId);
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/projects/:projectId/ppr/bop-versions", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      return reply.code(201).send(await dependencies.service.create(request.params.projectId, request.body));
    } catch (error) {
      return reply.code(400).send({ message: compactError(error) });
    }
  });

  app.get<{
    Params: { projectId: string; versionId: string };
    Querystring: { variantId?: string };
  }>("/api/projects/:projectId/ppr/bop-versions/:versionId/analysis", async (request, reply) => {
    requireProject(request.params.projectId);
    let variantId: string | undefined;
    try {
      variantId = optionalText(request.query.variantId, "分析变体 ID");
    } catch (error) {
      return reply.code(400).send({ message: compactError(error) });
    }
    try {
      return dependencies.service.analyze(request.params.projectId, request.params.versionId, variantId);
    } catch (error) {
      return reply.code(404).send({ message: compactError(error) });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { beforeVersionId?: string; afterVersionId?: string; activeVariantId?: string } }>("/api/projects/:projectId/ppr/bop-versions/compare", async (request, reply) => {
    requireProject(request.params.projectId);
    try {
      const beforeVersionId = requiredText(request.body?.beforeVersionId, "基线版本 ID");
      const afterVersionId = requiredText(request.body?.afterVersionId, "目标版本 ID");
      const activeVariantId = optionalText(request.body?.activeVariantId, "分析变体 ID");
      const comparison = dependencies.service.compare(request.params.projectId, beforeVersionId, afterVersionId, activeVariantId);
      const { before, after } = dependencies.service.comparisonVersions(request.params.projectId, beforeVersionId, afterVersionId);
      const studies = dependencies.operations?.snapshot(request.params.projectId).studies ?? [];
      const bindings = studies.flatMap((study) => study.pprBinding && study.pprBinding.planId === before.planId ? [{ studyId: study.id, ...study.pprBinding }] : []);
      const project = dependencies.operations ? dependencies.store.getProject(request.params.projectId) : undefined;
      const assetHeads = project?.models?.flatMap((model) => model.manifest?.deepAssetPackage
        ? [{ modelId: model.id, snapshot: { packageId: model.manifest.deepAssetPackage.packageId, revision: model.manifest.deepAssetPackage.revision, sourceHash: model.manifest.deepAssetPackage.sourceHash } }] : []) ?? [];
      const studyImpact = assessStudyChangeImpact({ studies, bindings, before, after, comparison, assetHeads });
      return { ...comparison, studyImpact };
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

function optionalText(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > 120) throw new Error(`${label}不能超过 120 个字符`);
  return text;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, " ").slice(0, 500);
}
