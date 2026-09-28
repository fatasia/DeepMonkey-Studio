import type { FastifyInstance } from "fastify";
import type { ProvenanceLedgerStore } from "./provenanceLedger.js";

/**
 * H-C3 档案室路由（用户可感知载体）：实验档案列表 + 三跳链查询。
 * 只读面（浏览者可查）；无写操作故无审计事件——档案写入只在 verdict 产生处，
 * 查询不改状态。未命中由返回体 matched=false 如实呈现（不伪造链）。
 */
export async function registerProvenanceRoutes(
  app: FastifyInstance,
  dependencies: {
    store: Pick<import("../store.js").MetadataStore, "getProject">;
    ledger: ProvenanceLedgerStore;
  },
): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>(
    "/api/projects/:projectId/ai/provenance",
    async (request, reply) => {
      if (!await projectExists(dependencies.store, request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      const limit = parseLimit(request.query.limit);
      if (limit === null) return reply.code(400).send({ message: "limit 必须是 1 至 100 的整数" });
      const { chains, integrity } = await dependencies.ledger.listChains(request.params.projectId, limit ?? 20);
      return { chains, integrity };
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: Record<string, string | undefined> }>(
    "/api/projects/:projectId/ai/provenance/trace",
    async (request, reply) => {
      if (!await projectExists(dependencies.store, request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      const query = request.query;
      const limit = parseLimit(query.limit);
      if (limit === null) return reply.code(400).send({ message: "limit 必须是 1 至 100 的整数" });
      const trace = await dependencies.ledger.trace(request.params.projectId, {
        ...(query.resultFingerprint ? { resultFingerprint: query.resultFingerprint } : {}),
        ...(query.proposalFingerprint ? { proposalFingerprint: query.proposalFingerprint } : {}),
        ...(query.since ? { since: query.since } : {}),
        ...(query.until ? { until: query.until } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return trace;
    },
  );
}

/** undefined = 未提供（用默认）；null = 非法（路由回 400）。 */
function parseLimit(value: string | undefined): number | null | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

async function projectExists(store: Pick<import("../store.js").MetadataStore, "getProject">, projectId: string): Promise<boolean> {
  return Boolean(await store.getProject(projectId));
}

