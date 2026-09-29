import type { FastifyInstance, FastifyReply } from "fastify";
import type { OntologyPackage } from "@bim-studio/contracts";
import { parseOntologyGraphQuery } from "@bim-studio/contracts";
import type { MetadataStore } from "../store.js";
import { OntologyPackageError, type OntologyPackageStore } from "../ontology/ontologyStore.js";
import { queryOntologyGraph } from "./ontologyGraphQuery.js";

interface OntologyGraphRouteDependencies {
  store: MetadataStore;
  ontology: OntologyPackageStore;
}

/**
 * H-C4-P1 图谱查询路由：POST graph（只读，viewer 可用）。
 * 权限纪律：图谱是已发布/草稿包的只读投影，不校验写角色；
 * 校验纪律：查询体走 parseOntologyGraphQuery（fail-closed），root 不存在 400，
 * 项目/包不存在 404——错误与 P0 本体路由同一形态（{ message }）。
 */
export async function registerOntologyGraphRoutes(app: FastifyInstance, dependencies: OntologyGraphRouteDependencies): Promise<void> {
  const { store, ontology } = dependencies;

  app.post("/api/projects/:projectId/ontology-packages/:packageId/graph", async (request, reply) => {
    const { projectId, packageId } = request.params as { projectId: string; packageId: string };
    if (!store.getProject(projectId)) {
      return reply.code(404).send({ message: "项目不存在" });
    }
    let pkg: OntologyPackage;
    try {
      pkg = await ontology.getPackage(projectId, packageId);
    } catch (error) {
      if (!(error instanceof OntologyPackageError)) throw error;
      return reply.code(404).send({ message: error.message });
    }
    const parsed = parseOntologyGraphQuery(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ message: parsed.errors.join("；") });
    }
    const startedAt = process.hrtime.bigint();
    try {
      const result = queryOntologyGraph(pkg, parsed.query);
      return {
        ...result,
        // 纳秒差转毫秒，保留 3 位小数——查询耗时可观测（剩余任务清单 P1 验收列）。
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return reply.code(400).send({ message: error.message });
    }
  });
}

/** 供路由测试与前端契约核对：图谱端点路径（单一来源）。 */
export const ONTOLOGY_GRAPH_ROUTE = "/api/projects/:projectId/ontology-packages/:packageId/graph" as const;

export type { OntologyGraphRouteDependencies };
