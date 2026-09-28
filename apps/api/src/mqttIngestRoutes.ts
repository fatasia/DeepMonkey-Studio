import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import type { FastifyInstance } from "fastify";
import { connectionPassword, connectorUrl, requiredSource } from "./dataIntegrationHelpers.js";
import type { MetadataStore } from "./store.js";
import type { OpcUaIngestConfig } from "./opcUaSubscriptionSource.js";
import type { MqttIngestConfig, MqttIngestMapping, MqttIngestSupervisor } from "./mqttIngest.js";

interface IngestBody {
  datasetId?: string;
  mapping?: Partial<MqttIngestMapping>;
}

export async function registerMqttIngestRoutes(
  app: FastifyInstance,
  store: MetadataStore,
  supervisor: MqttIngestSupervisor,
): Promise<void> {
  app.post<{ Params: { projectId: string; connectionId: string }; Body: IngestBody }>(
    "/api/projects/:projectId/data-connections/:connectionId/ingest/start",
    async (request, reply) => {
      const connection = findMqttConnection(store, request.params.projectId, request.params.connectionId);
      if (!connection) return reply.code(404).send({ message: "MQTT 数据连接不存在" });
      const dataset = request.body?.datasetId
        ? store.listDatasets(request.params.projectId).find((item) => item.id === request.body.datasetId && item.connectionId === connection.id)
        : store.listDatasets(request.params.projectId).find((item) => item.connectionId === connection.id);
      if (!dataset) return reply.code(400).send({ message: "持续摄取需要一个属于该连接的数据集" });
      const mapping = buildMapping(connection, dataset, request.body?.mapping);
      if (!mapping) return reply.code(400).send({ message: "持续摄取需要有效的 MQTT Topic" });
      try {
        const session = await supervisor.start(`${connection.projectId}:${connection.id}`, {
          connectionId: connection.id,
          projectId: connection.projectId,
          url: String(connection.config.url ?? ""),
          ...(connection.config.user ? { user: String(connection.config.user) } : {}),
          ...(connection.config.passwordEnv ? { password: connectionPassword(connection, "MQTT_PASSWORD") } : {}),
          mapping,
        });
        return reply.code(202).send({ ok: true, mapping, stats: session.snapshot() });
      } catch (error) {
        return reply.code(502).send({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string; connectionId: string } }>(
    "/api/projects/:projectId/data-connections/:connectionId/ingest/stop",
    async (request, reply) => {
      const connection = findMqttConnection(store, request.params.projectId, request.params.connectionId);
      if (!connection) return reply.code(404).send({ message: "MQTT 数据连接不存在" });
      const stopped = await supervisor.stop(`${connection.projectId}:${connection.id}`);
      return { ok: true, stopped };
    },
  );

  app.get<{ Params: { projectId: string; connectionId: string } }>(
    "/api/projects/:projectId/data-connections/:connectionId/ingest/status",
    async (request, reply) => {
      const connection = findMqttConnection(store, request.params.projectId, request.params.connectionId);
      if (!connection) return reply.code(404).send({ message: "MQTT 数据连接不存在" });
      return { ok: true, stats: supervisor.snapshot(`${connection.projectId}:${connection.id}`) };
    },
  );

  // ---- T24 持久订阅:断线退避重连 + 订阅恢复 + 缺口对账(与简单摄取共享连接/数据集解析) ----

  app.post<{ Params: { projectId: string; connectionId: string }; Body: IngestBody }>(
    "/api/projects/:projectId/data-connections/:connectionId/ingest/persistent/start",
    async (request, reply) => {
      const resolved = findSubscriptionConnection(store, request.params.projectId, request.params.connectionId);
      if ("failure" in resolved) return reply.code(resolved.failure.status).send(resolved.failure.body);
      const connection = resolved.record;
      const dataset = request.body?.datasetId
        ? store.listDatasets(request.params.projectId).find((item) => item.id === request.body.datasetId && item.connectionId === connection.id)
        : store.listDatasets(request.params.projectId).find((item) => item.connectionId === connection.id);
      if (!dataset) return reply.code(400).send({ message: "持久订阅需要一个属于该连接的数据集" });
      try {
        if (connection.type === "opcua") {
          // T24 OPC UA 切片:真实 MonitoredItem 订阅;配置/端点问题 fail-closed 显式报错,不做降级。
          const opcUaConfig = buildOpcUaIngestConfig(connection, dataset);
          const session = await supervisor.startPersistentOpcUa(`${connection.projectId}:${connection.id}`, opcUaConfig);
          const status = session.snapshot();
          if (status.lifecycle === "reconnecting") {
            // endpoint 不可达/会话被拒:fail-closed 明确报错并停掉退避中的会话,不留静默重试。
            await supervisor.stopPersistent(`${connection.projectId}:${connection.id}`);
            return reply.code(502).send({ ok: false, message: status.lastError ?? "OPC UA 订阅建立失败" });
          }
          return reply.code(202).send({ ok: true, status });
        }
        const mapping = buildMapping(connection, dataset, request.body?.mapping);
        if (!mapping) return reply.code(400).send({ message: "持久订阅需要有效的 MQTT Topic" });
        const session = await supervisor.startPersistent(`${connection.projectId}:${connection.id}`, {
          connectionId: connection.id,
          projectId: connection.projectId,
          url: String(connection.config.url ?? ""),
          ...(connection.config.user ? { user: String(connection.config.user) } : {}),
          ...(connection.config.passwordEnv ? { password: connectionPassword(connection, "MQTT_PASSWORD") } : {}),
          mapping,
        });
        return reply.code(202).send({ ok: true, status: session.snapshot() });
      } catch (error) {
        return reply.code(502).send({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string; connectionId: string } }>(
    "/api/projects/:projectId/data-connections/:connectionId/ingest/persistent/stop",
    async (request, reply) => {
      const resolved = findSubscriptionConnection(store, request.params.projectId, request.params.connectionId);
      if ("failure" in resolved) return reply.code(resolved.failure.status).send(resolved.failure.body);
      const connection = resolved.record;
      const stopped = await supervisor.stopPersistent(`${connection.projectId}:${connection.id}`);
      return { ok: true, stopped };
    },
  );

  app.get<{ Params: { projectId: string; connectionId: string } }>(
    "/api/projects/:projectId/data-connections/:connectionId/ingest/persistent/status",
    async (request, reply) => {
      const resolved = findSubscriptionConnection(store, request.params.projectId, request.params.connectionId);
      if ("failure" in resolved) return reply.code(resolved.failure.status).send(resolved.failure.body);
      const connection = resolved.record;
      return { ok: true, status: supervisor.persistentSnapshot(`${connection.projectId}:${connection.id}`) };
    },
  );
}

/** 持久订阅连接解析:MQTT 与 OPC UA 放行(T24 切片均已实现真实订阅),其余类型 400;不做静默降级。 */
function findSubscriptionConnection(
  store: MetadataStore,
  projectId: string,
  connectionId: string,
): { record: DataConnectionRecord } | { failure: { status: number; body: Record<string, unknown> } } {
  const connection = store.listDataConnections(projectId).find((item) => item.id === connectionId);
  if (!connection) {
    return { failure: { status: 404, body: { message: "数据连接不存在" } } };
  }
  if (connection.type !== "mqtt" && connection.type !== "opcua") {
    return { failure: { status: 400, body: { message: `连接类型 ${connection.type} 不支持持久订阅;当前支持 MQTT 与 OPC UA` } } };
  }
  return { record: connection };
}

/** OPC UA 持久订阅配置:nodeId 列表取自数据集 sourceKey(与 previewOpcUa 同口径),连接级参数取自连接配置。 */
function buildOpcUaIngestConfig(connection: DataConnectionRecord, dataset: DataDatasetRecord): OpcUaIngestConfig {
  const endpointUrl = connectorUrl(connection, ["opc.tcp:"]).toString();
  const nodeIds = requiredSource(dataset, "OPC UA NodeId")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const namespaceRaw = connection.config.namespace;
  const namespace = typeof namespaceRaw === "number" ? namespaceRaw : namespaceRaw !== undefined ? Number(namespaceRaw) : undefined;
  const samplingRaw = connection.config.samplingIntervalMs;
  const samplingIntervalMs =
    typeof samplingRaw === "number" ? samplingRaw : samplingRaw !== undefined && String(samplingRaw).trim() !== "" ? Number(samplingRaw) : undefined;
  return {
    connectionId: connection.id,
    projectId: connection.projectId,
    endpointUrl,
    nodeIds,
    ...(namespace !== undefined && Number.isSafeInteger(namespace) && namespace >= 0 ? { namespace } : {}),
    ...(connection.config.user ? { user: String(connection.config.user) } : {}),
    ...(connection.config.user ? { password: connectionPassword(connection, "OPCUA_PASSWORD") } : {}),
    ...(samplingIntervalMs !== undefined && Number.isFinite(samplingIntervalMs) ? { samplingIntervalMs } : {}),
    ...(connection.config.sceneId ? { sceneId: String(connection.config.sceneId) } : {}),
  };
}

function findMqttConnection(store: MetadataStore, projectId: string, connectionId: string): DataConnectionRecord | undefined {
  const connection = store.listDataConnections(projectId).find((item) => item.id === connectionId);
  return connection?.type === "mqtt" ? connection : undefined;
}

function buildMapping(
  connection: DataConnectionRecord,
  dataset: DataDatasetRecord,
  override?: Partial<MqttIngestMapping>,
): MqttIngestMapping | undefined {
  const topic = String(override?.topic ?? dataset.sourceKey ?? connection.config.topic ?? "").trim();
  if (!topic) return undefined;
  const url = connectorUrl(connection, ["mqtt:", "mqtts:", "ws:", "wss:"]);
  return {
    topic,
    source: String(override?.source ?? connection.config.source ?? `mqtt/${connection.id}`),
    ...(override?.key || connection.config.key ? { key: String(override?.key ?? connection.config.key) } : {}),
    ...(override?.valuePath || connection.config.valuePath ? { valuePath: String(override?.valuePath ?? connection.config.valuePath) } : {}),
    ...(override?.timestampPath || connection.config.timestampPath ? { timestampPath: String(override?.timestampPath ?? connection.config.timestampPath) } : {}),
    ...(override?.sequencePath || connection.config.sequencePath ? { sequencePath: String(override?.sequencePath ?? connection.config.sequencePath) } : {}),
    ...(override?.sceneId || connection.config.sceneId ? { sceneId: String(override?.sceneId ?? connection.config.sceneId) } : {}),
    ...(override?.target ? { target: override.target } : {}),
    ...(override?.action ? { action: override.action } : {}),
    qos: normalizeQos(override?.qos ?? connection.config.qos),
    // URL is parsed above to fail early with the same contract as previewMqtt.
    ...(_urlMarker(url), {}),
  };
}

function _urlMarker(url: URL): URL {
  return url;
}

function normalizeQos(value: unknown): 0 | 1 | 2 {
  const qos = Number(value ?? 0);
  return qos === 2 ? 2 : qos === 1 ? 1 : 0;
}
