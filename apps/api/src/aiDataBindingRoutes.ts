import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  AiDataBinding,
  AiDataBindingFeature,
  AiDataBindingOutput,
  AiDataBindingRunStatus,
  AiDataBindingTrigger,
} from "@bim-studio/contracts";
import type { MetadataStore } from "./metadataStore.js";

type ProjectParams = { projectId: string };
type BindingParams = ProjectParams & { bindingId: string };

/** AI 数据绑定只管理算法读取策略，不复制数据连接与凭据。 */
export async function registerAiDataBindingRoutes(app: FastifyInstance, store: MetadataStore): Promise<void> {
  app.get<{ Params: ProjectParams }>("/api/projects/:projectId/ai-data-bindings", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    return store.listAiDataBindings(request.params.projectId);
  });

  app.post<{ Params: ProjectParams; Body: Partial<AiDataBinding> }>(
    "/api/projects/:projectId/ai-data-bindings",
    async (request, reply) => saveBinding(store, request.params.projectId, request.body ?? {}, reply),
  );

  app.get<{
    Params: ProjectParams;
    Querystring: { bindingId?: string; status?: string; limit?: string };
  }>("/api/projects/:projectId/ai-data-binding-runs", async (request, reply) => {
    if (!requireProject(store, request.params.projectId, reply)) return reply;
    const statuses = new Set<AiDataBindingRunStatus>(["queued", "running", "succeeded", "failed", "skipped", "cancelled"]);
    const status = request.query.status as AiDataBindingRunStatus | undefined;
    if (status && !statuses.has(status)) return reply.code(400).send({ message: "运行状态无效" });
    return store.listAiDataBindingRuns(request.params.projectId, {
      ...(request.query.bindingId?.trim() ? { bindingId: request.query.bindingId.trim() } : {}),
      ...(status ? { status } : {}),
      limit: Math.min(500, Math.max(0, Math.trunc(Number(request.query.limit ?? 50)) || 0)),
    });
  });

  app.patch<{ Params: BindingParams; Body: Partial<AiDataBinding> }>(
    "/api/projects/:projectId/ai-data-bindings/:bindingId",
    async (request, reply) => {
      if (!requireProject(store, request.params.projectId, reply)) return reply;
      const existing = store.getAiDataBinding(request.params.projectId, request.params.bindingId);
      if (!existing) return reply.code(404).send({ message: "AI 数据绑定不存在" });
      return saveBinding(store, request.params.projectId, { ...existing, ...request.body, id: existing.id }, reply);
    },
  );

  app.delete<{ Params: BindingParams }>(
    "/api/projects/:projectId/ai-data-bindings/:bindingId",
    async (request, reply) => {
      if (!requireProject(store, request.params.projectId, reply)) return reply;
      const removed = await store.removeAiDataBinding(request.params.projectId, request.params.bindingId);
      return removed ? reply.code(204).send() : reply.code(404).send({ message: "AI 数据绑定不存在" });
    },
  );
}

async function saveBinding(
  store: MetadataStore,
  projectId: string,
  input: Partial<AiDataBinding>,
  reply: FastifyReply,
) {
  if (!requireProject(store, projectId, reply)) return reply;
  try {
    const now = new Date().toISOString();
    const existing = input.id ? store.getAiDataBinding(projectId, input.id) : undefined;
    const datasetId = requiredText(input.datasetId ?? existing?.datasetId, "数据集");
    if (!store.listDatasets(projectId).some((item) => item.id === datasetId)) throw new Error("数据集不存在");
    const entity = normalizeEntity(input.entity ?? existing?.entity);
    const time = normalizeTime(input.time ?? existing?.time);
    const parameters = normalizeParameters(input.parameters ?? existing?.parameters);
    const binding: AiDataBinding = {
      id: existing?.id ?? randomUUID(),
      projectId,
      name: requiredText(input.name ?? existing?.name, "绑定名称"),
      datasetId,
      capabilityId: requiredText(input.capabilityId ?? existing?.capabilityId, "AI 能力"),
      ...(parameters ? { parameters } : {}),
      status: input.status ?? existing?.status ?? "draft",
      ...(entity ? { entity } : {}),
      ...(time ? { time } : {}),
      features: normalizeFeatures(input.features ?? existing?.features ?? []),
      window: normalizeWindow(input.window ?? existing?.window),
      trigger: normalizeTrigger(input.trigger ?? existing?.trigger),
      quality: normalizeQuality(input.quality ?? existing?.quality),
      retry: normalizeRetry(input.retry ?? existing?.retry),
      output: normalizeOutput(input.output ?? existing?.output),
      revision: existing ? existing.revision + 1 : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await store.saveAiDataBinding(projectId, binding);
    return reply.code(existing ? 200 : 201).send(saved);
  } catch (error) {
    return reply.code(400).send({ message: compactError(error) });
  }
}

function normalizeEntity(value: AiDataBinding["entity"]): AiDataBinding["entity"] {
  if (!value) return undefined;
  return { keyField: requiredText(value.keyField, "设备标识字段"), ...(value.selectedKeys?.length ? { selectedKeys: value.selectedKeys } : {}) };
}

function normalizeTime(value: AiDataBinding["time"]): AiDataBinding["time"] {
  if (!value) return undefined;
  return { field: requiredText(value.field, "时间字段"), order: value.order === "desc" ? "desc" : "asc", ...(value.timezone ? { timezone: value.timezone } : {}) };
}

function normalizeFeatures(features: AiDataBindingFeature[]): AiDataBindingFeature[] {
  const normalized = features.map((item) => {
    const scale = finiteOptional(item.scale);
    const offset = finiteOptional(item.offset);
    return {
      modelField: requiredText(item.modelField, "模型字段"),
      sourceField: requiredText(item.sourceField, "数据字段"),
      ...(item.unit?.trim() ? { unit: item.unit.trim() } : {}),
      ...(scale !== undefined ? { scale } : {}),
      ...(offset !== undefined ? { offset } : {}),
      required: item.required !== false,
    };
  });
  if (new Set(normalized.map((item) => item.modelField)).size !== normalized.length) throw new Error("模型字段不能重复");
  return normalized;
}

function normalizeWindow(value: AiDataBinding["window"] | undefined): AiDataBinding["window"] {
  const rows = positiveInteger(value?.rows);
  const durationSeconds = positiveInteger(value?.durationSeconds);
  if (!rows && !durationSeconds) return { rows: 60 };
  return { ...(rows ? { rows } : {}), ...(durationSeconds ? { durationSeconds } : {}) };
}

function normalizeTrigger(value: AiDataBindingTrigger | undefined): AiDataBindingTrigger {
  if (!value || value.type === "manual") return { type: "manual" };
  if (value.type === "interval") return { type: "interval", seconds: positiveInteger(value.seconds) ?? 60 };
  const debounceSeconds = positiveInteger(value.debounceSeconds);
  return { type: "event", ...(value.eventName?.trim() ? { eventName: value.eventName.trim() } : {}), ...(debounceSeconds ? { debounceSeconds } : {}) };
}

function normalizeQuality(value: AiDataBinding["quality"] | undefined): AiDataBinding["quality"] {
  return {
    minimumSamples: positiveInteger(value?.minimumSamples) ?? 1,
    maxAgeSeconds: positiveInteger(value?.maxAgeSeconds) ?? 300,
    maximumMissingRate: clamp(Number(value?.maximumMissingRate ?? 0.2), 0, 1),
  };
}

function normalizeRetry(value: AiDataBinding["retry"] | undefined): AiDataBinding["retry"] {
  return { maxAttempts: clamp(Math.trunc(Number(value?.maxAttempts ?? 3)), 0, 10), backoffSeconds: positiveInteger(value?.backoffSeconds) ?? 5 };
}

function normalizeOutput(value: AiDataBindingOutput | undefined): AiDataBindingOutput {
  if (!value || value.type === "record") return { type: "record", ...(value?.type === "record" && value.targetDatasetId ? { targetDatasetId: value.targetDatasetId } : {}) };
  if (value.type === "case") return { type: "case", ...(value.caseType?.trim() ? { caseType: value.caseType.trim() } : {}) };
  return { type: "scene-link", ...(value.sceneId ? { sceneId: value.sceneId } : {}), ...(value.entityField ? { entityField: value.entityField } : {}) };
}

function normalizeParameters(value: AiDataBinding["parameters"]): AiDataBinding["parameters"] {
  if (!value) return undefined;
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || !["string", "number", "boolean"].includes(typeof item)) continue;
    if (typeof item === "number" && !Number.isFinite(item)) continue;
    parameters[key.trim()] = typeof item === "string" ? item.trim() : item;
  }
  return Object.keys(parameters).length ? parameters : undefined;
}

function requireProject(store: MetadataStore, projectId: string, reply: FastifyReply): boolean {
  if (store.getProject(projectId)) return true;
  void reply.code(404).send({ message: "项目不存在" });
  return false;
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function finiteOptional(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 500);
}
