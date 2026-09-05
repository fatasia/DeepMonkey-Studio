import { randomUUID } from "node:crypto";
import type {
  CapabilityProvider,
  CapabilityRequest,
  CapabilityInvocationResult,
} from "@bim-studio/plugin-runtime";
import {
  PluginRegistry,
  type PluginHostPolicy,
} from "@bim-studio/plugin-runtime";
import {
  assessBatteryRelease,
  BATTERY_MODEL_CATALOG,
  type BatteryReleaseAssessment,
  type EnergyObservation,
  type MaintenanceAssessmentRecord,
  type MaintenanceShadowEvaluation,
} from "@bim-studio/contracts";
import type { OperationsService } from "./operations.js";
import {
  createVirtualDebugProvider,
  createVirtualDebugSuiteProvider,
} from "@bim-studio/virtual-commissioning-plugin";
import { createParametricValidationProvider } from "@bim-studio/parametric-modeling-plugin";
import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "./store.js";
import {
  createBatteryModelGateway,
  type BatteryModelGateway,
} from "./batteryModelGateway.js";
import { createBatteryCapabilityProviders } from "./batteryCapabilities.js";
import { registerDefaultAiPlugin } from "./ai/registerAiPlugin.js";
import { registerParametricAiPlugin } from "./ai/registerParametricAiPlugin.js";
import { registerIndustrialDiagnosisPlugin } from "./ai/industrialDiagnosisPlugin.js";
import { registerAlarmRcaPlugin } from "./ai/alarmRcaPlugin.js";
import { resolveAiSettings } from "./ai/aiRuntimeSettings.js";
import type { AiRuntimeSettings } from "./ai/assistantService.js";
import { INDUSTRIAL_CAPABILITY_SCHEMAS } from "./industrialCapabilitySchemas.js";
import { registerWorkcellValidationPlugin } from "./registerWorkcellValidationPlugin.js";
import { registerDataQueryPlugin } from "./registerDataQueryPlugin.js";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { registerDataQueryAiPlugin } from "./ai/registerDataQueryAiPlugin.js";
import type { ConversionTaskService } from "./conversionTasks.js";
import { registerConversionCapabilityPlugin } from "./registerConversionCapabilityPlugin.js";
import {
  loadBatteryOnnxDeployment,
  type BatteryOnnxDeployment,
} from "./batteryOnnxDeployment.js";
import { BatteryProductionOnnxRuntime } from "./batteryProductionOnnxRuntime.js";
import type { FormalBatteryModel } from "./batteryModelGateway.js";
import {
  BATTERY_UPLOAD_LIMIT_BYTES,
  parseBatteryUpload,
} from "./batteryUpload.js";
import {
  capabilityInvocationHttpStatus,
  invokeReliableHttpCapability,
} from "./capabilityInvocationReliability.js";
import { readAiDataset } from "./aiDatasetSource.js";
import { prepareAiBindingSnapshot } from "./aiDataBindingRuntime.js";
import { failAiDataBindingRun, startAiDataBindingRun, succeedAiDataBindingRun } from "./aiDataBindingRunRecorder.js";

/**
 * API 层只负责把已有领域服务挂到插件运行时，不把算法复制到路由中。
 * 这样同一能力可以被页面、MCP 或自动化任务复用，并统一获得超时、证据和审计字段。
 */
export interface IndustrialCapabilityHost {
  registry: PluginRegistry;
  batteryRelease: BatteryReleaseAssessment;
  batteryOnnx: BatteryOnnxDeployment;
  batteryOnnxRuntimeModels: FormalBatteryModel[];
  invoke<TOutput = unknown>(
    capabilityId: string,
    request: CapabilityRequest,
  ): Promise<CapabilityInvocationResult<TOutput>>;
}

const CONFIGURABLE_AI_PLUGINS = new Set([
  "bim.ai.openai-compatible",
  "bim.ai.parametric-draft",
  "bim.ai.data-query-draft",
  "bim.ai.industrial-diagnosis",
]);

export async function createIndustrialCapabilityHost(
  operations: OperationsService,
  options: {
    batteryGateway?: BatteryModelGateway;
    batteryOnnx?: BatteryOnnxDeployment;
    aiSettings?: () => AiRuntimeSettings;
    dataQuerySource?: DataQuerySource;
    conversionTasks?: ConversionTaskService;
  } = {},
): Promise<IndustrialCapabilityHost> {
  const batteryOnnx =
    options.batteryOnnx ?? (await loadBatteryOnnxDeployment());
  const batteryOnnxRuntimeModels = [...batteryOnnx.requestedModels];
  const productionOnnxRuntime =
    batteryOnnxRuntimeModels.length > 0
      ? new BatteryProductionOnnxRuntime(batteryOnnx)
      : undefined;
  const batteryGateway =
    options.batteryGateway ??
    createBatteryModelGateway({
      onnxManifests: batteryOnnx.manifests,
      ...(productionOnnxRuntime ? { onnxRuntime: productionOnnxRuntime } : {}),
      ...(batteryOnnxRuntimeModels.length > 0
        ? {
            runtimeByModel: Object.fromEntries(
              batteryOnnxRuntimeModels.map((model) => [model, "onnx"]),
            ),
          }
        : {}),
    });
  const batteryRelease = assessBatteryRelease(
    BATTERY_MODEL_CATALOG,
    batteryOnnx.manifests,
  );
  const registry = new PluginRegistry(hostPolicy());
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.industrial-core",
    name: "Industrial core capabilities",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: [
      "operations.maintenance",
      "operations.energy",
      "simulation.virtual-debug",
      "battery.model",
      "battery.twin",
      "modeling.parametric",
    ],
    permissions: [
      "operations.read",
      "operations.write",
      "simulation.execute",
      "battery.read",
      "battery.execute",
      "modeling.read",
    ],
    extensionPoints: [
      {
        kind: "capability.provider" as const,
        id: "bim.industrial-operations",
        capabilityIds: [
          "operations.maintenance.assess",
          "operations.maintenance.shadow-evaluate",
          "operations.energy.analyze",
          "simulation.virtual-debug.run",
          "simulation.virtual-debug.run-suite",
          "battery.model.predict",
          "battery.twin.status",
          "battery.twin.initialize",
          "battery.twin.simulate",
          "battery.twin.assimilate",
          "battery.twin.evidence",
          "battery.release.status",
          "modeling.parametric.validate",
        ],
        execution: "in-process" as const,
        limits: {
          timeoutMs: 30_000,
          maxInputBytes: 8 * 1024 * 1024,
          memoryMb: 512,
        },
      },
    ],
  };

  const registration = registry.register(manifest, ({ registerCapability }) => {
    for (const capability of providers(operations, batteryGateway)) {
      const result = registerCapability(capability);
      if (!result.ok) throw new Error(`核心能力注册失败：${result.message}`);
    }
  });
  if (!registration.ok)
    throw new Error(`核心能力插件不兼容：${registration.message}`);
  // 内置插件在 API 启动时启用；失败会阻止启动，避免出现“页面可见但能力不存在”的假状态。
  const enabled = await registry.enable("bim.industrial-core");
  if (!enabled.ok) throw new Error(`核心能力启用失败：${enabled.message}`);
  await registerWorkcellValidationPlugin(registry);
  if (options.conversionTasks)
    await registerConversionCapabilityPlugin(registry, options.conversionTasks);
  if (options.dataQuerySource)
    await registerDataQueryPlugin(registry, options.dataQuerySource);
  await registerDefaultAiPlugin(registry);
  if (options.dataQuerySource)
    await registerDataQueryAiPlugin(
      registry,
      options.dataQuerySource,
      options.aiSettings ?? (() => resolveAiSettings()),
    );
  await registerParametricAiPlugin(
    registry,
    options.aiSettings ?? (() => resolveAiSettings()),
  );
  await registerIndustrialDiagnosisPlugin(registry);
  await registerAlarmRcaPlugin(registry);

  return {
    registry,
    batteryRelease,
    batteryOnnx,
    batteryOnnxRuntimeModels,
    invoke: (capabilityId, request) =>
      registry.invokeCapability(capabilityId, request),
  };
}

/** API/MCP 共用的最小能力入口；输入仍由能力自身做严格校验。 */
export async function registerIndustrialCapabilityRoutes(
  app: FastifyInstance,
  dependencies: { store: MetadataStore; host: IndustrialCapabilityHost; dataQuerySource?: DataQuerySource },
): Promise<void> {
  app.get("/api/plugins", async () => ({
    plugins: dependencies.host.registry.list().map(pluginSummary),
  }));
  app.patch<{ Params: { pluginId: string }; Body: { enabled?: boolean } }>(
    "/api/admin/plugins/:pluginId/status",
    async (request, reply) => {
      const pluginId = request.params.pluginId;
      if (!CONFIGURABLE_AI_PLUGINS.has(pluginId))
        return reply
          .code(409)
          .send({ message: "该插件属于系统核心，不能在运行中停用" });
      if (typeof request.body?.enabled !== "boolean")
        return reply.code(400).send({ message: "enabled 必须是布尔值" });
      const result = request.body.enabled
        ? await dependencies.host.registry.enable(pluginId)
        : await dependencies.host.registry.disable(pluginId);
      if (!result.ok)
        return reply
          .code(result.code === "not-found" ? 404 : 409)
          .send({ message: result.message, result });
      return {
        plugin: result.plugin ? pluginSummary(result.plugin) : undefined,
      };
    },
  );
  app.get("/api/capabilities", async () => ({
    capabilities: dependencies.host.registry.listCapabilities(),
  }));
  app.get<{ Params: { capabilityId: string } }>(
    "/api/capabilities/:capabilityId",
    async (request, reply) => {
      const capability = dependencies.host.registry.getCapability(
        request.params.capabilityId,
      );
      return capability ?? reply.code(404).send({ message: "能力不存在" });
    },
  );
  app.get("/api/ai/providers", async () => ({
    providers: dependencies.host.registry.listAiProviders(),
  }));
  app.get("/api/battery/models/catalog", async () => ({
    models: BATTERY_MODEL_CATALOG,
  }));
  app.get("/api/battery/models/release-gate", async () => ({
    ...dependencies.host.batteryRelease,
    deployment: {
      enabled: dependencies.host.batteryOnnx.enabled,
      requestedModels: dependencies.host.batteryOnnx.requestedModels,
      activeModels: dependencies.host.batteryOnnxRuntimeModels,
      diagnostics: dependencies.host.batteryOnnx.diagnostics,
    },
    evaluatedAt: new Date().toISOString(),
  }));
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/battery/predictions",
    async (request, reply) => {
      if (!dependencies.store.getProject(request.params.projectId))
        return reply.code(404).send({ message: "项目不存在" });
      if (request.systemUser?.role === "viewer")
        return reply.code(403).send({ message: "浏览者不能执行电池模型" });

      try {
        const upload = await request.file({
          limits: { fileSize: BATTERY_UPLOAD_LIMIT_BYTES, files: 1, fields: 6 },
        });
        if (!upload)
          return reply.code(400).send({ message: "缺少电池采样文件" });
        const records = parseBatteryUpload(await upload.toBuffer());
        const fields = upload.fields as unknown as Record<string, unknown>;
        const model = multipartField(fields, "model");
        const chemistry = multipartField(fields, "chemistry");
        const routingMode = multipartField(fields, "routingMode");
        const nominalCapacityAh = multipartNumber(fields, "nominalCapacityAh");
        const targetCapacityRetention = multipartNumber(
          fields,
          "targetCapacityRetention",
        );
        const controller = new AbortController();
        const abortFromClient = () => controller.abort("客户端已取消电池分析");
        request.raw.once("aborted", abortFromClient);
        const result = await dependencies.host
          .invoke("battery.model.predict", {
            requestId: randomUUID(),
            projectId: request.params.projectId,
            principal: request.systemUser?.id ?? "web-user",
            ...(request.systemUser ? { role: request.systemUser.role } : {}),
            signal: controller.signal,
            input: {
              model,
              fileName: upload.filename,
              records,
              ...(routingMode ? { routingMode } : {}),
              ...(chemistry ? { chemistry } : {}),
              ...(nominalCapacityAh !== undefined ? { nominalCapacityAh } : {}),
              ...(targetCapacityRetention !== undefined
                ? { targetCapacityRetention }
                : {}),
            },
          })
          .finally(() =>
            request.raw.removeListener("aborted", abortFromClient),
          );
        return result.status === "failed" || result.status === "blocked"
          ? reply.code(422).send(result)
          : result;
      } catch (error) {
        return reply
          .code(400)
          .send({
            message:
              error instanceof Error ? error.message : "电池数据文件无效",
          });
      }
    },
  );
  app.post<{
    Params: { projectId: string };
    Body: {
      bindingId?: string;
      datasetId?: string;
      model?: string;
      chemistry?: string;
      routingMode?: string;
      nominalCapacityAh?: number;
      targetCapacityRetention?: number;
    };
  }>("/api/projects/:projectId/battery/predictions/from-dataset", async (request, reply) => {
    if (!dependencies.store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能执行电池模型" });
    if (!dependencies.dataQuerySource) return reply.code(503).send({ message: "统一数据集运行时尚未启用" });
    const bindingId = request.body?.bindingId?.trim();
    const binding = bindingId ? dependencies.store.getAiDataBinding(request.params.projectId, bindingId) : undefined;
    if (bindingId && (!binding || binding.capabilityId !== "battery.model.predict")) {
      return reply.code(404).send({ message: "电池数据绑定不存在" });
    }
    const datasetId = binding?.datasetId ?? request.body?.datasetId?.trim();
    if (!datasetId) return reply.code(400).send({ message: "请选择电池数据集" });

    const controller = new AbortController();
    const bindingRun = binding ? await startAiDataBindingRun(dependencies.store, binding) : undefined;
    let sourceEvidence;
    const abortFromClient = () => controller.abort("客户端已取消电池分析");
    request.raw.once("aborted", abortFromClient);
    try {
      const snapshot = await readAiDataset(
        dependencies.dataQuerySource,
        dependencies.store,
        request.params.projectId,
        datasetId,
        controller.signal,
      );
      sourceEvidence = snapshot.evidence;
      const prepared = binding ? prepareAiBindingSnapshot(binding, snapshot) : snapshot;
      const parameters = binding?.parameters ?? {};
      const model = textParameter(parameters.model) ?? request.body.model;
      const result = await dependencies.host.invoke<Record<string, unknown>>("battery.model.predict", {
        requestId: randomUUID(),
        projectId: request.params.projectId,
        principal: request.systemUser?.id ?? "web-user",
        ...(request.systemUser ? { role: request.systemUser.role } : {}),
        signal: controller.signal,
        input: {
          model,
          fileName: `dataset:${datasetId}`,
          records: prepared.records,
          ...(textParameter(parameters.routingMode) ?? request.body.routingMode ? { routingMode: textParameter(parameters.routingMode) ?? request.body.routingMode } : {}),
          ...(textParameter(parameters.chemistry) ?? request.body.chemistry ? { chemistry: textParameter(parameters.chemistry) ?? request.body.chemistry } : {}),
          ...(numberParameter(parameters.nominalCapacityAh) ?? request.body.nominalCapacityAh !== undefined ? { nominalCapacityAh: numberParameter(parameters.nominalCapacityAh) ?? request.body.nominalCapacityAh } : {}),
          ...(numberParameter(parameters.targetCapacityRetention) ?? request.body.targetCapacityRetention !== undefined ? { targetCapacityRetention: numberParameter(parameters.targetCapacityRetention) ?? request.body.targetCapacityRetention } : {}),
        },
      });
      const withEvidence = result.output && typeof result.output === "object" && !Array.isArray(result.output)
        ? { ...result, output: { ...result.output, sourceEvidence: snapshot.evidence } }
        : result;
      if (bindingRun && binding) {
        if (result.status === "failed" || result.status === "blocked") {
          await failAiDataBindingRun(dependencies.store, bindingRun, result.error?.message ?? result.status, snapshot.evidence);
        } else {
          await succeedAiDataBindingRun(dependencies.store, bindingRun, binding, snapshot.evidence, result.output);
        }
      }
      return result.status === "failed" || result.status === "blocked"
        ? reply.code(422).send(withEvidence)
        : withEvidence;
    } catch (error) {
      if (bindingRun) await failAiDataBindingRun(dependencies.store, bindingRun, error, sourceEvidence);
      return reply.code(400).send({ message: error instanceof Error ? error.message : "电池数据集无效" });
    } finally {
      request.raw.removeListener("aborted", abortFromClient);
    }
  });
  app.post<{
    Params: { projectId: string };
    Body: Partial<CapabilityRequest> & { capabilityId?: string };
  }>("/api/projects/:projectId/capabilities/invoke", async (request, reply) => {
    if (!dependencies.store.getProject(request.params.projectId))
      return reply.code(404).send({ message: "项目不存在" });
    const capabilityId =
      typeof request.body?.capabilityId === "string"
        ? request.body.capabilityId
        : "";
    if (!capabilityId)
      return reply.code(400).send({ message: "缺少 capabilityId" });
    const descriptor = dependencies.host.registry.getCapability(capabilityId);
    if (!descriptor) return reply.code(404).send({ message: "能力不存在" });
    if (
      request.systemUser?.role === "viewer" &&
      !isReadOnlyCapability(descriptor)
    ) {
      return reply.code(403).send({ message: "浏览者只能调用只读查询能力" });
    }
    const body = request.body ?? {};
    const result = await invokeReliableHttpCapability({
      capabilityId,
      client: request.raw,
      response: reply.raw,
      invoke: dependencies.host.invoke,
      addAuditLog: dependencies.store.addAuditLog?.bind(dependencies.store),
      request: {
      requestId:
        typeof body.requestId === "string" && body.requestId
          ? body.requestId
          : randomUUID(),
      projectId: request.params.projectId,
      // 登录身份由服务端会话提供，不能接受客户端伪造 principal/role。
      principal:
        request.systemUser?.id ??
        (typeof body.principal === "string" && body.principal
          ? body.principal
          : "api-user"),
      ...(request.systemUser
        ? { role: request.systemUser.role }
        : typeof body.role === "string"
          ? { role: body.role }
          : {}),
      input: body.input ?? {},
      ...(typeof body.dryRun === "boolean" ? { dryRun: body.dryRun } : {}),
      ...(typeof body.expectedRevision === "string"
        ? { expectedRevision: body.expectedRevision }
        : {}),
      },
    });
    return result.status === "failed" || result.status === "blocked"
      ? reply.code(capabilityInvocationHttpStatus(result)).send(result)
      : result;
  });
}

function textParameter(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParameter(value: string | number | boolean | undefined): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function pluginSummary(plugin: ReturnType<PluginRegistry["list"]>[number]) {
  const capabilityIds = plugin.manifest.extensionPoints.flatMap((point) =>
    point.kind === "capability.provider" ? point.capabilityIds : [],
  );
  const providerIds = plugin.manifest.extensionPoints.flatMap((point) =>
    point.kind === "ai.provider" ? point.providerIds : [],
  );
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    status: plugin.status,
    configurable: CONFIGURABLE_AI_PLUGINS.has(plugin.manifest.id),
    capabilities: [...plugin.manifest.capabilities],
    capabilityIds,
    providerIds,
    diagnostics: plugin.diagnostics,
  };
}

function isReadOnlyCapability(descriptor: {
  kind: string;
  permissions: string[];
}): boolean {
  return (
    descriptor.kind === "query" &&
    descriptor.permissions.every(
      (permission) =>
        permission.endsWith(".read") || permission === "ai.invoke",
    )
  );
}

function providers(
  operations: OperationsService,
  batteryGateway: BatteryModelGateway,
): CapabilityProvider[] {
  return [
    {
      descriptor: {
        id: "operations.maintenance.assess",
        version: "1.0.0",
        label: "预测维护评估",
        kind: "analysis",
        execution: "in-process",
        permissions: ["operations.read", "operations.write"],
        timeoutMs: 30_000,
        inputSchemaVersion: "1.0",
        outputSchemaVersion: "1.0",
        inputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceAssess.input,
        outputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceAssess.output,
      },
      async invoke(request) {
        const input = asRecord(request.input);
        const deploymentId = requiredString(input.deploymentId, "deploymentId");
        const rows = numericRows(input.rows);
        const assessment = await operations.assess(
          request.projectId,
          deploymentId,
          rows,
        );
        return maintenanceResult(assessment, "预测维护评估已完成");
      },
    },
    {
      descriptor: {
        id: "operations.maintenance.shadow-evaluate",
        version: "1.0.0",
        label: "预测维护影子评测",
        kind: "analysis",
        execution: "in-process",
        permissions: ["operations.read", "operations.write"],
        timeoutMs: 30_000,
        inputSchemaVersion: "1.0",
        outputSchemaVersion: "1.0",
        inputSchema:
          INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceShadowEvaluate.input,
        outputSchema:
          INDUSTRIAL_CAPABILITY_SCHEMAS.maintenanceShadowEvaluate.output,
      },
      async invoke(request) {
        const input = asRecord(request.input);
        const modelId = requiredString(input.modelId, "modelId");
        const labelColumn = requiredString(input.labelColumn, "labelColumn");
        const result = await operations.shadowEvaluate(
          request.projectId,
          modelId,
          numericRows(input.rows),
          labelColumn,
          optionalNumber(input.threshold),
          optionalString(input.timeColumn),
        );
        return shadowResult(result);
      },
    },
    {
      descriptor: {
        id: "operations.energy.analyze",
        version: "1.0.0",
        label: "能源分析",
        kind: "analysis",
        execution: "in-process",
        permissions: ["operations.read", "operations.write"],
        timeoutMs: 15_000,
        inputSchemaVersion: "1.0",
        outputSchemaVersion: "1.0",
        inputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.energyAnalyze.input,
        outputSchema: INDUSTRIAL_CAPABILITY_SCHEMAS.energyAnalyze.output,
      },
      async invoke(request) {
        const input = asRecord(request.input);
        const result = await operations.analyzeEnergy(
          request.projectId,
          (Array.isArray(input.observations)
            ? input.observations
            : []) as EnergyObservation[],
        );
        return {
          status: "completed",
          decisionStatus: "production",
          output: result,
          evidence: [
            {
              id: result.id,
              kind: "data",
              label: "能源观测分析",
              source: `project:${request.projectId}`,
              fingerprint: result.evidenceFingerprint,
            },
          ],
        };
      },
    },
    createVirtualDebugProvider(),
    createVirtualDebugSuiteProvider(),
    createParametricValidationProvider(),
    ...createBatteryCapabilityProviders(batteryGateway),
  ];
}

function maintenanceResult(
  assessment: MaintenanceAssessmentRecord,
  label: string,
) {
  return {
    status: "completed" as const,
    decisionStatus:
      assessment.decisionStatus === "validated"
        ? ("production" as const)
        : ("shadow" as const),
    output: assessment,
    confidence: assessment.dataQuality,
    evidence: [
      {
        id: assessment.evidenceFingerprint,
        kind: "trace" as const,
        label,
        source: `deployment:${assessment.deploymentId}`,
        fingerprint: assessment.evidenceFingerprint,
      },
    ],
  };
}

function shadowResult(result: MaintenanceShadowEvaluation) {
  return {
    status: "completed" as const,
    decisionStatus: "shadow" as const,
    output: result,
    confidence: result.f1,
    evidence: [
      {
        id: result.fingerprint,
        kind: "model" as const,
        label: "固定数据集影子评测",
        source: `model:${result.modelId}`,
        fingerprint: result.fingerprint,
      },
    ],
  };
}

function hostPolicy(): PluginHostPolicy {
  return {
    apiVersion: "1.0",
    sceneApiVersion: "1.0",
    host: "cloud",
    renderer: "webgl2",
    capabilities: [
      "operations.maintenance",
      "operations.energy",
      "simulation.virtual-debug",
      "battery.model",
      "battery.twin",
      "modeling.parametric",
      "modeling.parametric.ai",
      "industrial.ai.diagnosis",
      "industrial.ai.alarm-rca",
      "manufacturing.validation",
      "data.query",
      "data.query.ai",
      "model.conversion",
      "ai.provider",
    ],
    permissions: [
      "operations.read",
      "operations.write",
      "simulation.execute",
      "battery.read",
      "battery.execute",
      "modeling.read",
      "modeling.write",
      "manufacturing.read",
      "data.read",
      "model.read",
      "model.write",
      "ai.invoke",
    ],
    extensionPoints: ["capability.provider", "ai.provider"],
    allowTrustedSceneExtensions: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("能力输入必须是对象");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`缺少 ${field}`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function multipartField(fields: Record<string, unknown>, name: string): string {
  const candidate = Array.isArray(fields[name])
    ? fields[name][0]
    : fields[name];
  if (!candidate || typeof candidate !== "object" || !("value" in candidate))
    return "";
  const value = String((candidate as { value: unknown }).value).trim();
  return value;
}

function multipartNumber(
  fields: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = multipartField(fields, name);
  if (!value) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`${name} 必须是有限数字`);
  return numeric;
}

function numericRows(value: unknown): Array<Record<string, number>> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const record = asRecord(row);
    return Object.fromEntries(
      Object.entries(record).flatMap(([key, item]) => {
        const number = Number(item);
        return Number.isFinite(number)
          ? [[key, number] as [string, number]]
          : [];
      }),
    );
  });
}
