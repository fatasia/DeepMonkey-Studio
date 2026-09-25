import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SemanticModelRecord } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import { validateSemanticModel } from "./semanticModelService.js";

interface SemanticModelRouteDependencies {
  store: MetadataStore;
}

type SemanticModelBody = Partial<SemanticModelRecord> | undefined;

/** 语义模型 CRUD；校验规则由 contracts 与服务端共同执行。revision 由服务端控制：创建为 1，每次保存 +1。 */
export async function registerSemanticModelRoutes(app: FastifyInstance, dependencies: SemanticModelRouteDependencies): Promise<void> {
  const { store } = dependencies;
  const projectIdOf = (request: FastifyRequest) => (request.params as { projectId: string }).projectId;

  const upsert = async (request: FastifyRequest, reply: FastifyReply, mode: "create" | "update"): Promise<unknown> => {
    const projectId = projectIdOf(request);
    const body = request.body as SemanticModelBody;
    if (!store.getProject(projectId)) return reply.code(404).send({ message: "项目不存在" });

    const modelId = mode === "update" ? (request.params as { modelId: string }).modelId : undefined;
    const id = mode === "update" ? modelId : (body?.id || randomUUID());
    if (!id) return reply.code(400).send({ message: "语义模型 id 无效" });

    const existing = store.listSemanticModels(projectId).find((item) => item.id === id);
    if (mode === "update" && !existing) return reply.code(404).send({ message: "语义模型不存在" });

    const name = body?.name?.trim();
    if (!name) return reply.code(400).send({ message: "语义模型名称不能为空" });
    if (!body?.source?.kind || !body.source.id) return reply.code(400).send({ message: "语义模型必须指定数据集或管道来源" });
    if (store.listSemanticModels(projectId).some((item) => item.id !== id && item.name.trim() === name)) {
      return reply.code(409).send({ message: `语义模型名称“${name}”已被使用` });
    }

    const now = new Date().toISOString();
    const model: SemanticModelRecord = {
      id,
      name,
      ...(body.description?.trim() ? { description: body.description.trim() } : {}),
      source: body.source,
      metrics: body.metrics ?? [],
      dimensions: body.dimensions ?? [],
      parameters: body.parameters ?? [],
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const errors = validateSemanticModel(model, store, projectId);
    if (errors.length > 0) return reply.code(400).send({ message: errors.join("；") });

    try {
      const saved = await store.saveSemanticModel(projectId, model);
      return reply.code(existing ? 200 : 201).send(saved);
    } catch (reason) {
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "语义模型保存失败" });
    }
  };

  app.get("/api/projects/:projectId/semantic-models", async (request, reply) => {
    if (!store.getProject(projectIdOf(request))) return reply.code(404).send({ message: "项目不存在" });
    return store.listSemanticModels(projectIdOf(request));
  });

  app.post("/api/projects/:projectId/semantic-models", async (request, reply) => upsert(request, reply, "create"));

  app.put("/api/projects/:projectId/semantic-models/:modelId", async (request, reply) => upsert(request, reply, "update"));

  app.delete("/api/projects/:projectId/semantic-models/:modelId", async (request, reply) => {
    const projectId = projectIdOf(request);
    if (!store.getProject(projectId)) return reply.code(404).send({ message: "项目不存在" });
    const removed = await store.removeSemanticModel(projectId, (request.params as { modelId: string }).modelId);
    return removed ? reply.code(204).send() : reply.code(404).send({ message: "语义模型不存在" });
  });
}
