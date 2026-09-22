import type { CapabilityDescriptor, CapabilityJsonSchema, CapabilityProvider, PluginRegistry } from "@bim-studio/plugin-runtime";
import type { SubmitConversionTaskRequest } from "@bim-studio/contracts";
import type { ConversionTaskService } from "./conversionTasks.js";

const emptyInputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const taskIdSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { taskId: { type: "string", minLength: 1 } },
  required: ["taskId"],
};

const submitSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pluginId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    idempotencyKey: { type: "string", minLength: 1 },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        objectKey: { type: "string", minLength: 1 },
        fileName: { type: "string", minLength: 1 },
        format: { type: "string", minLength: 1 },
        size: { type: "integer", minimum: 0 },
        sha256: { type: "string", minLength: 64, maxLength: 64 },
      },
      required: ["objectKey", "fileName", "format", "size"],
    },
    configuration: { type: "object", additionalProperties: true },
  },
  required: ["pluginId", "input"],
};

/** 将原生格式转换复用到页面、SDK 与 MCP，执行仍受转换器清单和项目对象路径约束。 */
export async function registerConversionCapabilityPlugin(
  registry: PluginRegistry,
  service: ConversionTaskService,
): Promise<void> {
  const capabilityIds = [
    "model.conversion.catalog",
    "model.conversion.submit",
    "model.conversion.status",
    "model.conversion.cancel",
  ];
  const registration = registry.register({
    schemaVersion: 1,
    id: "bim.model-conversion",
    name: "Governed model conversion",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"],
    capabilities: ["model.conversion"],
    permissions: ["model.read", "model.write"],
    extensionPoints: [{
      kind: "capability.provider",
      id: "bim.model-conversion-provider",
      capabilityIds,
      execution: "in-process",
      limits: { timeoutMs: 30_000, maxInputBytes: 64 * 1024, memoryMb: 64 },
    }],
  }, ({ registerCapability }) => {
    for (const provider of providers(service)) {
      const result = registerCapability(provider);
      if (!result.ok) throw new Error(`模型转换能力注册失败：${result.message}`);
    }
  });
  if (!registration.ok) throw new Error(`模型转换插件不兼容：${registration.message}`);
  const enabled = await registry.enable("bim.model-conversion");
  if (!enabled.ok) throw new Error(`模型转换插件启用失败：${enabled.message}`);
}

function providers(service: ConversionTaskService): CapabilityProvider[] {
  return [
    {
      descriptor: descriptor(
        "model.conversion.catalog",
        "模型转换器目录",
        "query",
        ["model.read"],
        emptyInputSchema,
      ),
      async invoke() {
        const converters = service.listPlugins();
        return {
          status: "completed",
          decisionStatus: "production",
          output: { converters },
          evidence: converters.map((item) => ({
            id: `${item.manifest.id}@${item.manifest.version}`,
            kind: "trace",
            label: item.available ? "转换器可用" : "转换器待部署",
            source: item.provider?.name ?? item.manifest.name,
          })),
        };
      },
    },
    {
      descriptor: descriptor(
        "model.conversion.submit",
        "提交模型转换",
        "action",
        ["model.write"],
        submitSchema,
      ),
      async invoke(request) {
        const input = asRecord(request.input);
        const task = await service.submitDurable({
          projectId: request.projectId,
          pluginId: requiredString(input.pluginId, "pluginId"),
          ...(input.modelId !== undefined ? { modelId: requiredString(input.modelId, "modelId") } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey") } : {}),
          input: asTaskInput(input.input),
          ...(isRecord(input.configuration) ? { configuration: input.configuration } : {}),
        });
        return taskResult(task, "转换任务已提交");
      },
    },
    {
      descriptor: descriptor(
        "model.conversion.status",
        "查询模型转换状态",
        "query",
        ["model.read"],
        taskIdSchema,
      ),
      async invoke(request) {
        const taskId = requiredString(asRecord(request.input).taskId, "taskId");
        const task = service.get(request.projectId, taskId);
        if (!task) throw new Error("转换任务不存在");
        return taskResult(task, "转换任务状态");
      },
    },
    {
      descriptor: descriptor(
        "model.conversion.cancel",
        "取消模型转换",
        "action",
        ["model.write"],
        taskIdSchema,
      ),
      async invoke(request) {
        const taskId = requiredString(asRecord(request.input).taskId, "taskId");
        return taskResult(await service.cancelDurable(request.projectId, taskId), "转换任务取消结果");
      },
    },
  ];
}

function descriptor(
  id: string,
  label: string,
  kind: "query" | "action",
  permissions: string[],
  inputSchema: CapabilityJsonSchema,
): CapabilityDescriptor {
  return {
    id,
    version: "1.0.0",
    label,
    kind,
    execution: "in-process" as const,
    permissions,
    timeoutMs: 30_000,
    inputSchemaVersion: "1.0",
    outputSchemaVersion: "1.0",
    inputSchema,
    outputSchema: { type: "object", additionalProperties: true },
  };
}

function taskResult(task: ReturnType<ConversionTaskService["submit"]>, label: string) {
  return {
    status: "completed" as const,
    decisionStatus: "production" as const,
    output: task,
    evidence: [{
      id: task.id,
      kind: "trace" as const,
      label,
      source: `converter:${task.pluginId}@${task.pluginVersion}`,
      ...(task.input.sha256 ? { fingerprint: task.input.sha256 } : {}),
    }],
  };
}

function asTaskInput(value: unknown): SubmitConversionTaskRequest["input"] {
  const input = asRecord(value);
  const size = input.size;
  if (!Number.isSafeInteger(size) || Number(size) < 0) throw new Error("size 必须是非负整数");
  return {
    objectKey: requiredString(input.objectKey, "objectKey"),
    fileName: requiredString(input.fileName, "fileName"),
    format: requiredString(input.format, "format"),
    size: Number(size),
    ...(typeof input.sha256 === "string" ? { sha256: input.sha256 } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("能力输入必须是对象");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${field}`);
  return value.trim();
}
