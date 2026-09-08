import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { MetadataStore } from "./store.js";
import { DataWritebackError, DataWritebackService } from "./dataWritebackService.js";
import { DataPostgresWritebackService } from "./dataPostgresWritebackService.js";

export async function registerDataWritebackRoutes(app: FastifyInstance, store: MetadataStore, config: AppConfig): Promise<void> {
  const service = new DataWritebackService({ outboundPolicy: config.directBindings, timeoutMs: config.directBindings.requestTimeoutMs, maxResponseBytes: Math.min(config.directBindings.maxResponseBytes, 256 * 1024) });
  const postgres = new DataPostgresWritebackService();
  app.route<{ Params: { projectId: string; datasetId: string; recordId: string }; Body: unknown }>({
    method: ["GET", "PATCH"], url: "/api/projects/:projectId/datasets/:datasetId/records/:recordId", bodyLimit: 160 * 1024,
    handler: async (request, reply) => {
      const user = request.systemUser;
      if (!user?.enabled) return reply.code(401).send({ message: "请先登录" });
      const { projectId, datasetId, recordId } = request.params;
      if (user.role !== "admin" && !user.projectIds.includes(projectId)) return reply.code(403).send({ message: "没有该项目的访问权限" });
      if (request.method === "PATCH" && user.role === "viewer") return reply.code(403).send({ message: "浏览者不能填报数据" });
      const dataset = store.listDatasets(projectId).find(item => item.id === datasetId && item.projectId === projectId);
      const connection = dataset && store.listDataConnections(projectId).find(item => item.id === dataset.connectionId && item.projectId === projectId);
      if (!dataset || !connection) return reply.code(404).send({ message: "填报数据集不存在" });
      reply.header("cache-control", "no-store");
      try {
        const target = dataset.writeback?.version === 2 ? postgres : service;
        return request.method === "GET" ? await target.read(connection, dataset, recordId) : await target.write(connection, dataset, recordId, request.body);
      } catch (error) {
        if (!(error instanceof DataWritebackError)) throw error;
        return reply.code(error.statusCode).send({ code: error.code, message: error.message, outcome: error.outcome, retryable: false, ...(error.issues ? { issues: error.issues } : {}) });
      }
    }
  });
}
