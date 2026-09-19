import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import type { FastifyInstance } from "fastify";
import { connectionPassword, connectorUrl } from "./dataIntegrationHelpers.js";
import type { MetadataStore } from "./store.js";
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
