/**
 * 仿真结果导出路由:POST /api/projects/:projectId/operations/logistics/des-studies/:studyId/export
 * 把已完成 Plant Lite Study 的结果发布到外部 MQTT 主题或 SQL 表(study_results 结构)。
 * 仅服务仿真后导出动作;不做实时流订阅,不做远程控制。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ResultExportTarget } from "@bim-studio/contracts";
import { assertResultExportTarget } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import type { OperationsService } from "./operations.js";
import {
  buildResultExportPayload,
  publishResultMqtt,
  writeResultSql,
  type ResultExportTransports,
  type ResultMqttConnection,
  type ResultSqlConnection,
} from "./resultExport.js";

interface ExportBody {
  target: ResultExportTarget;
  connection?: {
    mqtt?: { brokerUrl?: string; clientId?: string; user?: string; passwordEnv?: string };
    sql?: { connectionStringEnv?: string };
  };
}

export interface ResultExportRouteOptions {
  store: MetadataStore;
  operations: OperationsService;
  /** 测试注入 fake;缺省走真实 mqtt/pg 动态导入。 */
  transports?: ResultExportTransports;
  /** SQL 连接串缺省环境变量名。 */
  sqlConnectionStringEnv?: string;
}

export const RESULT_EXPORT_SQL_CONNECTION_ENV = "RESULT_EXPORT_DATABASE_URL";

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireEnv(name: string | undefined, fallback: string): string {
  const environmentName = name && name.trim() ? name : fallback;
  const value = process.env[environmentName];
  if (value === undefined || value === "") {
    throw new Error(`未配置环境变量 ${environmentName},无法建立导出连接`);
  }
  return value;
}

export async function registerResultExportRoutes(app: FastifyInstance, options: ResultExportRouteOptions): Promise<void> {
  app.post<{ Params: { projectId: string; studyId: string }; Body: ExportBody }>(
    "/api/projects/:projectId/operations/logistics/des-studies/:studyId/export",
    async (request, reply) => {
      if (!options.store.getProject(request.params.projectId)) {
        return reply.code(404).send({ message: "项目不存在" });
      }
      // 用完整快照而非 snapshotForApi:后者为控制首屏负载会剥掉历史记录的 trace,
      // 而 trace 参与 evidence 指纹口径,剥掉会让导出指纹与统一索引漂移。
      const study = options.operations
        .snapshot(request.params.projectId)
        .plantLiteStudies.find((item) => item.id === request.params.studyId);
      if (!study) return reply.code(404).send({ message: "仿真 Study 不存在" });
      if (study.outcome.status !== "completed" && study.outcome.status !== "limited") {
        return reply.code(409).send({ message: `Study 状态为 ${study.outcome.status},仅已完成结果可导出` });
      }
      try {
        const target = request.body?.target;
        assertResultExportTarget(target);
        const payload = buildResultExportPayload(study, {
          ...(target.kind === "sql" ? { table: target.topicOrTable } : {}),
          includeFingerprints: target.includeFingerprints,
        });
        const injected = target.kind === "mqtt" ? options.transports?.mqtt : options.transports?.sql;
        const connection = target.kind === "mqtt"
          ? mqttConnectionFrom(request.body?.connection?.mqtt)
          : sqlConnectionFrom(request.body?.connection?.sql, options.sqlConnectionStringEnv);
        const receipt = target.kind === "mqtt"
          ? await publishResultMqtt(payload, target, injected as ResultExportTransports["mqtt"], connection as ResultMqttConnection | undefined)
          : await writeResultSql(payload, target, injected as ResultExportTransports["sql"], connection as ResultSqlConnection | undefined);
        return { ok: true, receipt };
      } catch (error) {
        return reply.code(400).send({ message: compactError(error) });
      }
    },
  );
}

function mqttConnectionFrom(
  value: NonNullable<ExportBody["connection"]>["mqtt"],
): ResultMqttConnection | undefined {
  if (!value) return undefined;
  if (!value.brokerUrl) throw new Error("MQTT 导出需要 connection.mqtt.brokerUrl");
  return {
    brokerUrl: value.brokerUrl,
    ...(value.clientId ? { clientId: value.clientId } : {}),
    ...(value.user ? { user: value.user } : {}),
    ...(value.passwordEnv ? { password: requireEnv(value.passwordEnv, value.passwordEnv) } : {}),
  };
}

function sqlConnectionFrom(
  value: NonNullable<ExportBody["connection"]>["sql"],
  fallbackEnv: string | undefined,
): ResultSqlConnection | undefined {
  if (!value) return undefined;
  return { connectionString: requireEnv(value.connectionStringEnv, fallbackEnv ?? RESULT_EXPORT_SQL_CONNECTION_ENV) };
}
