import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  assertPathSafeResourceId,
  assertDataWritebackConfig,
  type DataConnectionRecord,
  type DataDatasetRecord,
  type DataEndpointDefinition,
  type DataEndpointSaveResult,
  type DataPipelineDefinition,
  type PublishedSceneRecord,
} from "@bim-studio/contracts";
import { compileFormula } from "@bim-studio/data-runtime";
import { validateDataPipeline } from "@bim-studio/data-runtime/pipeline";
import { executeRowScript } from "@bim-studio/data-runtime/script";
import type { AppConfig } from "./config.js";
import { createDataApiKey, dataApiKeyHint, hashDataApiKey } from "./dataEndpointAuth.js";
import {
  demoSensorRows,
  hasBuiltInDataConnector,
  hasWritableDataConnector,
  listConnectorDiagnostics,
  previewDataset,
  writeDataPoint,
  type DataPointWriteRequest,
} from "./dataIntegration.js";
import { dataConnectionErrorMessage } from "./dataIntegrationHelpers.js";
import { createSqlConnectionProbe } from "./dataConnectionProbe.js";
import { previewPipeline } from "./dataPipelineService.js";
import type { ConversionQueue } from "./conversion.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";
import { getRevitRuntimeInfo } from "./revit.js";
import { assetContentEncoding, contentType } from "./routeFileTypes.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { registerAssetLibraryRoutes } from "./assetLibraryRoutes.js";
import { registerSemanticModelRoutes } from "./semanticModelRoutes.js";
import { registerDataWritebackRoutes } from "./dataWritebackRoutes.js";

interface RouteDependencies {
  store: MetadataStore;
  queue: ConversionQueue;
  objects: ObjectStore;
  dataDir: string;
  config: AppConfig;
  beforeDiscardPublication?: (publication: PublishedSceneRecord) => Promise<void>;
  afterPublish?: (publication: PublishedSceneRecord) => Promise<void>;
}

export async function registerRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  const { store, queue, objects, dataDir, config, beforeDiscardPublication, afterPublish } = dependencies;

  app.addHook("preValidation", async (request, reply) => {
    const params = request.params;
    if (!params || typeof params !== "object" || !("projectId" in params)) return;
    try {
      assertPathSafeResourceId((params as { projectId?: unknown }).projectId, "projectId");
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "projectId 无效" });
    }
  });

  app.get("/health", async () => ({ status: "ok", service: "bim-studio-api" }));
  app.get("/api/node-red/health", async () => {
    const baseUrl = String(process.env.NODE_RED_URL || "http://127.0.0.1:1880").replace(/\/$/, "");
    const checkedAt = new Date().toISOString();
    const startedAt = performance.now();
    const manifest = await nodeRedManifest();
    try {
      const response = await fetch(`${baseUrl}/node-red/`, { signal: AbortSignal.timeout(1_500), redirect: "manual" });
      await response.body?.cancel().catch(() => undefined);
      const online = response.status >= 200 && response.status < 500;
      return {
        online,
        status: online ? "online" : "offline",
        statusCode: response.status,
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt,
        editorPath: "/node-red/",
        runtimeVersion: manifest.runtimeVersion,
        declaredNodes: manifest.declaredNodes,
        ...(online ? {} : { message: `Node-RED 返回 HTTP ${response.status}` }),
      };
    } catch (reason) {
      return {
        online: false,
        status: "offline",
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt,
        editorPath: "/node-red/",
        runtimeVersion: manifest.runtimeVersion,
        declaredNodes: manifest.declaredNodes,
        message: reason instanceof Error ? reason.message : String(reason),
      };
    }
  });
  app.get("/api/revit/installations", async () => getRevitRuntimeInfo());

  app.post<{ Body: { sourceUrl?: string; playback?: "hls" | "webrtc" } }>("/api/live-monitor/resolve", async (request, reply) => {
    const sourceUrl = request.body?.sourceUrl?.trim();
    if (!sourceUrl || !isSupportedLiveSource(sourceUrl)) return reply.code(400).send({ message: "监控地址支持 RTSP、RTMP、SRT、HLS、WHEP、RTP 与 MPEG-TS" });
    const streamPath = `bim-${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)}`;
    const controlBase = (process.env.MEDIA_GATEWAY_CONTROL_URL ?? "http://127.0.0.1:9997").replace(/\/$/, "");
    const addUrl = `${controlBase}/v3/config/paths/add/${encodeURIComponent(streamPath)}`;
    const response = await fetch(addUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: sourceUrl, sourceOnDemand: true }),
      signal: AbortSignal.timeout(5_000),
    }).catch((reason) => {
      throw new Error(`实时监控服务不可用：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    if (!response.ok && response.status !== 400) throw new Error(`实时监控服务配置失败：HTTP ${response.status}`);
    if (response.status === 400) {
      const patchResponse = await fetch(`${controlBase}/v3/config/paths/patch/${encodeURIComponent(streamPath)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: sourceUrl, sourceOnDemand: true }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!patchResponse.ok) throw new Error(`实时监控服务更新失败：HTTP ${patchResponse.status}`);
    }
    const host = request.hostname || "127.0.0.1";
    const hlsBase = (process.env.MEDIA_GATEWAY_HLS_URL ?? `https://${host}:8888`).replace(/\/$/, "");
    const webRtcBase = (process.env.MEDIA_GATEWAY_WEBRTC_URL ?? `https://${host}:8889`).replace(/\/$/, "");
    return { path: streamPath, hlsUrl: `${hlsBase}/${streamPath}/index.m3u8`, webRtcUrl: `${webRtcBase}/${streamPath}` };
  });
  app.get("/api/demo/sensors", async () => ({ items: await demoSensorRows(config), generatedAt: new Date().toISOString() }));

  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const key = decodeURIComponent(request.params["*"]);
    if (!key || key.split(/[\\/]/).includes("..") || !(await objects.stat(key))) {
      return reply.code(404).send({ message: "文件不存在" });
    }
    const acceptsGzip = request.headers["accept-encoding"]?.includes("gzip") ?? false;
    const gzipKey = `${key}.gz`;
    const useGzip = acceptsGzip && key.toLowerCase().endsWith(".json") && (await objects.stat(gzipKey));
    const responseKey = useGzip ? gzipKey : key;
    const result = await objects.read(responseKey);
    void result.completed.catch((error) => request.log.error(error));
    const contentEncoding = assetContentEncoding(responseKey);
    if (contentEncoding) reply.header("Content-Encoding", contentEncoding).header("Vary", "Accept-Encoding");
    if (/^projects\/[^/]+\/unity\/[^/]+\/[^/]+\//.test(key) && !key.toLowerCase().endsWith("index.html")) {
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
    }
    return reply.type(contentType(key)).send(result.stream);
  });

  app.get("/api/projects", async (request) => {
    const projects = store.listProjects();
    return request.systemUser?.role === "admin" ? projects : projects.filter((project) => request.systemUser?.projectIds.includes(project.id));
  });
  app.post<{ Body: { name?: string; description?: string } }>("/api/projects", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ message: "项目名称不能为空" });
    return reply.code(201).send(await store.createProject(name, request.body.description?.trim() ?? ""));
  });
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
    const project = store.getProject(request.params.projectId);
    return project ?? reply.code(404).send({ message: "项目不存在" });
  });
  app.patch<{ Params: { projectId: string }; Body: { name?: string; description?: string } }>("/api/projects/:projectId", async (request, reply) => {
    const current = store.getProject(request.params.projectId);
    if (!current) return reply.code(404).send({ message: "项目不存在" });
    const name = request.body?.name?.trim();
    if (request.body?.name !== undefined && !name) return reply.code(400).send({ message: "项目名称不能为空" });
    return store.updateProject(request.params.projectId, {
      ...(name ? { name } : {}),
      ...(request.body?.description !== undefined ? { description: request.body.description.trim() } : {}),
    });
  });
  app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
    const removed = await store.removeProject(request.params.projectId);
    if (!removed) return reply.code(404).send({ message: "项目不存在" });
    await objects.removePrefix(`projects/${request.params.projectId}`);
    await rm(path.join(dataDir, "projects", request.params.projectId), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/data-connections", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listDataConnections(request.params.projectId);
  });
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/data-connections/diagnostics", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return listConnectorDiagnostics(request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: Partial<DataConnectionRecord> }>("/api/projects/:projectId/data-connections", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    if (request.systemUser?.role !== "admin" && store.listDatasets(request.params.projectId).some(dataset => dataset.writeback && dataset.connectionId === request.body.id)) return reply.code(403).send({ message: "只有管理员可以修改填报目标连接" });
    const name = request.body.name?.trim();
    if (!name || !request.body.type) return reply.code(400).send({ message: "连接名称和类型不能为空" });
    if (!hasBuiltInDataConnector(request.body.type)) return reply.code(501).send({ message: `${request.body.type} 连接器尚未内置；当前版本不能创建或测试该连接` });
    const now = new Date().toISOString();
    const connection: DataConnectionRecord = {
      id: request.body.id || randomUUID(),
      projectId: request.params.projectId,
      name,
      type: request.body.type,
      enabled: request.body.enabled !== false,
      config: request.body.config ?? {},
      createdAt: request.body.createdAt ?? now,
      updatedAt: now,
    };
    return reply.code(201).send(await store.saveDataConnection(request.params.projectId, connection));
  });
  app.post<{ Params: { projectId: string; connectionId: string }; Body: { datasetId?: string } }>(
    "/api/projects/:projectId/data-connections/:connectionId/test",
    async (request, reply) => {
      const connection = store.listDataConnections(request.params.projectId).find((item) => item.id === request.params.connectionId);
      if (!connection) return reply.code(404).send({ message: "数据连接不存在" });
      if (!hasBuiltInDataConnector(connection.type)) return reply.code(501).send({ message: `${connection.type} 连接器尚未内置；当前版本不能执行连接测试` });
      const dataset = request.body?.datasetId
        ? store.listDatasets(request.params.projectId).find((item) => item.id === request.body?.datasetId && item.connectionId === connection.id)
        : store.listDatasets(request.params.projectId).find((item) => item.connectionId === connection.id);
      const probeSourceKey = connection.type === "bacnet" ? "8,1,85" : connection.type === "s7" ? "DB1,REAL0" : connection.type === "ethernet-ip" ? "Tag1" : "";
      const sqlProbe = dataset ? undefined : createSqlConnectionProbe(connection, request.params.projectId);
      if (!dataset && !sqlProbe && !["simulation", "bacnet", "s7", "ethernet-ip", "serial"].includes(connection.type))
        return reply.code(400).send({ message: "请先为该连接创建一个数据集，再执行真实连接测试" });
      const probe =
        dataset ??
        sqlProbe ??
        ({
          id: `probe:${connection.id}`,
          projectId: request.params.projectId,
          connectionId: connection.id,
          name: "连接探针",
          sourceKey: probeSourceKey,
          refreshSeconds: 0,
          fields: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        } satisfies DataDatasetRecord);
      const startedAt = performance.now();
      try {
        const preview = await previewDataset(config, connection, probe);
        return {
          ok: true,
          status: "healthy",
          durationMs: Math.round(preview.durationMs),
          rowCount: preview.rows.length,
          fieldCount: preview.fields.length,
          checkedAt: new Date().toISOString(),
        };
      } catch (reason) {
        return {
          ok: false,
          status: "offline",
          durationMs: Math.round(performance.now() - startedAt),
          rowCount: 0,
          fieldCount: 0,
          checkedAt: new Date().toISOString(),
          message: dataConnectionErrorMessage(reason, connection.type),
        };
      }
    },
  );
  app.post<{ Params: { projectId: string; connectionId: string }; Body: DataPointWriteRequest }>(
    "/api/projects/:projectId/data-connections/:connectionId/write",
    async (request, reply) => {
      if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      const connection = store.listDataConnections(request.params.projectId).find((item) => item.id === request.params.connectionId);
      if (!connection) return reply.code(404).send({ message: "数据连接不存在" });
      if (!hasBuiltInDataConnector(connection.type)) return reply.code(501).send({ message: `${connection.type} 连接器尚未内置；当前版本不能写入数据点` });
      if (!hasWritableDataConnector(connection.type)) return reply.code(405).send({ message: `${connection.type} 连接器当前仅支持读取，不能执行下行写入` });
      if (!request.body?.address?.trim() || !("value" in (request.body ?? {}))) return reply.code(400).send({ message: "写入请求必须包含 address 和 value" });
      try {
        return reply.code(202).send(await writeDataPoint(connection, request.body));
      } catch (reason) {
        return reply.code(502).send({ message: reason instanceof Error ? reason.message : String(reason), code: "data_point_write_failed" });
      }
    },
  );
  app.delete<{ Params: { projectId: string; connectionId: string } }>("/api/projects/:projectId/data-connections/:connectionId", async (request, reply) => {
    const datasetIds = new Set(
      store
        .listDatasets(request.params.projectId)
        .filter((dataset) => dataset.connectionId === request.params.connectionId)
        .map((dataset) => dataset.id),
    );
    const dependentPipeline = store
      .listDataPipelines(request.params.projectId)
      .find((pipeline) => pipeline.nodes.some((node) => node.type === "source" && datasetIds.has(node.datasetId)));
    if (dependentPipeline) return reply.code(409).send({ message: `连接仍被流水线“${dependentPipeline.name}”使用` });
    return (await store.removeDataConnection(request.params.projectId, request.params.connectionId)) ? reply.code(204).send() : reply.code(404).send({ message: "数据连接不存在" });
  });
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/datasets", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listDatasets(request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: Partial<DataDatasetRecord> }>("/api/projects/:projectId/datasets", async (request, reply) => {
    const existing = store.listDatasets(request.params.projectId).find(dataset => dataset.id === request.body.id);
    const writeback = request.body.writeback === undefined ? existing?.writeback : request.body.writeback;
    if (JSON.stringify(writeback) !== JSON.stringify(existing?.writeback) || (existing?.writeback && request.body.connectionId !== existing.connectionId)) {
      if (request.systemUser?.role !== "admin") return reply.code(403).send({ message: "只有管理员可以配置填报目标" });
    }
    if (writeback !== undefined && writeback !== null) {
      try { assertDataWritebackConfig(writeback); } catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : "填报配置无效" }); }
      const connection = store.listDataConnections(request.params.projectId).find(item => item.id === request.body.connectionId);
      if (!connection?.enabled || connection.type !== "http") return reply.code(400).send({ message: "填报需要已启用的 HTTP 连接" });
    }
    const name = request.body.name?.trim();
    if (!name || !request.body.connectionId) return reply.code(400).send({ message: "数据集名称和连接不能为空" });
    const computedFields = request.body.computedFields ?? [];
    const computedKeys = computedFields.map((field) => field.key.trim());
    if (computedKeys.some((key) => !key) || new Set(computedKeys).size !== computedKeys.length) return reply.code(400).send({ message: "计算字段名不能为空或重复" });
    try {
      for (const field of computedFields) {
        if (field.mode === "script") await executeRowScript(field.formula, []);
        else compileFormula(field.formula);
      }
    } catch (reason) {
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "计算字段公式无效" });
    }
    const now = new Date().toISOString();
    const dataset: DataDatasetRecord = {
      id: request.body.id || randomUUID(),
      projectId: request.params.projectId,
      connectionId: request.body.connectionId,
      name,
      ...(request.body.query !== undefined ? { query: request.body.query } : {}),
      ...(request.body.sourceKey !== undefined ? { sourceKey: request.body.sourceKey } : {}),
      refreshSeconds: Math.max(0, Number(request.body.refreshSeconds ?? 10)),
      fields: request.body.fields ?? [],
      ...(writeback ? { writeback } : {}),
      ...(computedFields.length
        ? { computedFields: computedFields.map((field) => ({ ...field, key: field.key.trim(), label: field.label.trim() || field.key.trim(), formula: field.formula.trim() })) }
        : {}),
      createdAt: request.body.createdAt ?? now,
      updatedAt: now,
    };
    return reply.code(201).send(await store.saveDataset(request.params.projectId, dataset));
  });
  app.get<{ Params: { projectId: string; datasetId: string } }>("/api/projects/:projectId/datasets/:datasetId/preview", async (request, reply) => {
    const dataset = store.listDatasets(request.params.projectId).find((item) => item.id === request.params.datasetId);
    if (!dataset) return reply.code(404).send({ message: "数据集不存在" });
    const connection = store.listDataConnections(request.params.projectId).find((item) => item.id === dataset.connectionId);
    if (!connection) return reply.code(404).send({ message: "数据连接不存在" });
    return previewDataset(config, connection, dataset);
  });
  app.delete<{ Params: { projectId: string; datasetId: string } }>("/api/projects/:projectId/datasets/:datasetId", async (request, reply) => {
    const dependentPipeline = store
      .listDataPipelines(request.params.projectId)
      .find((pipeline) => pipeline.nodes.some((node) => node.type === "source" && node.datasetId === request.params.datasetId));
    if (dependentPipeline) return reply.code(409).send({ message: `数据集仍被流水线“${dependentPipeline.name}”使用` });
    const dependentSemanticModel = store
      .listSemanticModels(request.params.projectId)
      .find((model) => model.source.kind === "dataset" && model.source.id === request.params.datasetId);
    if (dependentSemanticModel) return reply.code(409).send({ message: `数据集仍被语义模型“${dependentSemanticModel.name}”使用` });
    return (await store.removeDataset(request.params.projectId, request.params.datasetId)) ? reply.code(204).send() : reply.code(404).send({ message: "数据集不存在" });
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/data-pipelines", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listDataPipelines(request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: Partial<DataPipelineDefinition> }>("/api/projects/:projectId/data-pipelines", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const name = request.body.name?.trim();
    if (!name) return reply.code(400).send({ message: "流水线名称不能为空" });
    const nodes = request.body.nodes ?? [];
    const edges = request.body.edges ?? [];
    try {
      validateDataPipeline({ nodes, edges });
      for (const node of nodes) if (node.type === "script") await executeRowScript(node.source, []);
    } catch (reason) {
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "流水线无效" });
    }
    const now = new Date().toISOString();
    const definition: DataPipelineDefinition = {
      id: request.body.id || randomUUID(),
      projectId: request.params.projectId,
      name,
      nodes,
      edges,
      createdAt: request.body.createdAt ?? now,
      updatedAt: now,
    };
    try {
      return reply.code(201).send(await store.saveDataPipeline(request.params.projectId, definition));
    } catch (reason) {
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "流水线保存失败" });
    }
  });
  app.get<{ Params: { projectId: string; pipelineId: string }; Querystring: { throughNodeId?: string } }>("/api/projects/:projectId/data-pipelines/:pipelineId/preview", async (request, reply) => {
    const definition = store.listDataPipelines(request.params.projectId).find((item) => item.id === request.params.pipelineId);
    if (!definition) return reply.code(404).send({ message: "流水线不存在" });
    try {
      return await previewPipeline(config, store, definition, request.query.throughNodeId?.trim() || undefined);
    } catch (reason) {
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "流水线运行失败" });
    }
  });
  app.delete<{ Params: { projectId: string; pipelineId: string } }>("/api/projects/:projectId/data-pipelines/:pipelineId", async (request, reply) => {
    const dependentEndpoint = store.listDataEndpoints(request.params.projectId).find((endpoint) => endpoint.pipelineId === request.params.pipelineId);
    if (dependentEndpoint) return reply.code(409).send({ message: `流水线仍被接口“${dependentEndpoint.name}”使用` });
    const dependentSemanticModel = store
      .listSemanticModels(request.params.projectId)
      .find((model) => model.source.kind === "pipeline" && model.source.id === request.params.pipelineId);
    if (dependentSemanticModel) return reply.code(409).send({ message: `流水线仍被语义模型“${dependentSemanticModel.name}”使用` });
    return (await store.removeDataPipeline(request.params.projectId, request.params.pipelineId)) ? reply.code(204).send() : reply.code(404).send({ message: "流水线不存在" });
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/data-endpoints", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return store.listDataEndpoints(request.params.projectId);
  });
  app.post<{ Params: { projectId: string }; Body: Partial<DataEndpointDefinition> & { rotateKey?: boolean } }>(
    "/api/projects/:projectId/data-endpoints",
    async (request, reply) => {
      if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      const name = request.body.name?.trim();
      const slug = request.body.slug?.trim().toLowerCase();
      if (!name || !slug || !request.body.kind || !request.body.pipelineId) return reply.code(400).send({ message: "接口名称、类型、路径和流水线不能为空" });
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) return reply.code(400).send({ message: "接口路径仅支持小写字母、数字、短横线和下划线，最长 64 位" });
      if (!store.listDataPipelines(request.params.projectId).some((pipeline) => pipeline.id === request.body.pipelineId))
        return reply.code(400).send({ message: "接口引用的流水线不存在" });
      const id = request.body.id || randomUUID();
      const existing = store.listDataEndpoints(request.params.projectId).find((endpoint) => endpoint.id === id);
      if (store.listDataEndpoints(request.params.projectId).some((endpoint) => endpoint.id !== id && endpoint.kind === request.body.kind && endpoint.slug === slug))
        return reply.code(409).send({ message: "同类型接口路径不能重复" });
      const createKey = !existing || request.body.rotateKey === true || !store.getDataEndpointSecretHash(id);
      const apiKey = createKey ? createDataApiKey() : undefined;
      const now = new Date().toISOString();
      const endpoint: DataEndpointDefinition = {
        id,
        projectId: request.params.projectId,
        name,
        kind: request.body.kind,
        slug,
        pipelineId: request.body.pipelineId,
        enabled: request.body.enabled !== false,
        apiKeyHint: apiKey ? dataApiKeyHint(apiKey) : (existing?.apiKeyHint ?? "••••••"),
        ...(request.body.kind === "rest"
          ? { method: request.body.method === "POST" ? "POST" : "GET" }
          : { channel: request.body.channel?.trim() || slug, intervalMs: Math.max(1_000, Math.min(60_000, Number(request.body.intervalMs ?? 5_000))) }),
        requestsPerMinute: Math.max(1, Math.min(600, Math.floor(Number(request.body.requestsPerMinute ?? 60)))),
        createdAt: existing?.createdAt ?? request.body.createdAt ?? now,
        updatedAt: now,
      };
      try {
        const saved = await store.saveDataEndpoint(request.params.projectId, endpoint, apiKey ? hashDataApiKey(apiKey) : undefined);
        const result: DataEndpointSaveResult = { endpoint: saved, ...(apiKey ? { apiKey } : {}) };
        return reply.code(existing ? 200 : 201).send(result);
      } catch (reason) {
        return reply.code(400).send({ message: reason instanceof Error ? reason.message : "接口保存失败" });
      }
    },
  );
  app.post<{ Params: { projectId: string; endpointId: string } }>("/api/projects/:projectId/data-endpoints/:endpointId/test", async (request, reply) => {
    const endpoint = store.listDataEndpoints(request.params.projectId).find((item) => item.id === request.params.endpointId);
    if (!endpoint) return reply.code(404).send({ message: "接口不存在" });
    const definition = store.listDataPipelines(request.params.projectId).find((pipeline) => pipeline.id === endpoint.pipelineId);
    if (!definition) return reply.code(409).send({ message: "接口引用的流水线不存在" });
    try {
      return await previewPipeline(config, store, definition);
    } catch (reason) {
      return reply.code(400).send({ message: reason instanceof Error ? reason.message : "接口测试失败" });
    }
  });
  app.delete<{ Params: { projectId: string; endpointId: string } }>("/api/projects/:projectId/data-endpoints/:endpointId", async (request, reply) => {
    return (await store.removeDataEndpoint(request.params.projectId, request.params.endpointId)) ? reply.code(204).send() : reply.code(404).send({ message: "接口不存在" });
  });

  await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });
  await registerSemanticModelRoutes(app, { store });
  await registerDataWritebackRoutes(app, store, config);
  await registerAssetLibraryRoutes(app, { store, queue, objects, dataDir, libraryDir: config.assetLibraryDir });
  await registerSceneRoutes(app, {
    store,
    ...(beforeDiscardPublication ? { beforeDiscardPublication } : {}),
    ...(afterPublish ? { afterPublish } : {}),
  });
}

function isSupportedLiveSource(value: string): boolean {
  return /^(rtsps?|rtmps?|srt|wheps?|https?|udp\+mpegts|udp\+rtp):\/\//i.test(value);
}

async function nodeRedManifest(): Promise<{ runtimeVersion: string; declaredNodes: string[] }> {
  const routeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(routeDirectory, "../../node-red/package.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
    const dependencies = manifest.dependencies ?? {};
    return {
      runtimeVersion: dependencies["node-red"] ?? "unknown",
      declaredNodes: Object.keys(dependencies)
        .filter((name) => name !== "node-red" && (name.startsWith("node-red-") || name.startsWith("@flowfuse/node-red-")))
        .sort(),
    };
  } catch {
    return { runtimeVersion: "unknown", declaredNodes: [] };
  }
}
