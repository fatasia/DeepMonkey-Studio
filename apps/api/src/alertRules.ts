// P3 API 侧告警评估桥（2026-09-19）：
//   DataEventBus（MQTT 持续摄取 / REST 数据事件）→ AlertEngine 规则评估 → alarm 数据事件回灌 bus。
//   规则持久化沿用仓内 JSON 原子写模式（参照 JsonCloudRenderRegistry）；
//   语义色/文案仍由 web 的 deviceSignalPresentation 承担——这里产出的 alarm 事件载荷
//   与 DeviceSignalSnapshot 值结构对齐（state/active/severity/acknowledged/status），
//   前端 resolveDeviceSignal 可直接消费。
//   评估引擎复用 @bim-studio/studio-core 的 AlertEngine（与 apps/web 同一实现，不重复造轮子）。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPathSafeResourceId, type DataEvent } from "@bim-studio/contracts";
import type { FastifyInstance } from "fastify";
import {
  AlertEngine,
  type AlertEvent,
  type AlertRule,
  type AlertStateSnapshot,
} from "@bim-studio/studio-core";
import type { DataEventBus } from "./dataEvents.js";
import type { MetadataStore } from "./store.js";

/** 桥自身产出的告警事件统一 source，评估时跳过以防自激励闭环。 */
export const ALERT_EVENT_SOURCE = "alert-engine";

export interface AlertRuleDocument {
  version: 1;
  rules: AlertRule[];
}

/** 项目级告警规则 JSON 持久化：<dataDir>/projects/<projectId>/alert-rules.json。 */
export class AlertRuleFileStore {
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = path.join(dataDir, "projects");
  }

  private filePath(projectId: string): string {
    assertPathSafeResourceId(projectId, "projectId");
    return path.join(this.baseDir, projectId, "alert-rules.json");
  }

  async load(projectId: string): Promise<AlertRule[]> {
    try {
      const document = JSON.parse(await readFile(this.filePath(projectId), "utf8")) as AlertRuleDocument;
      if (document.version !== 1 || !Array.isArray(document.rules) || !document.rules.every(isPersistedRule)) {
        throw new Error("告警规则文件损坏：alert-rules.json 结构无效，请修复或删除该文件后重建规则");
      }
      return document.rules;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(projectId: string, rules: AlertRule[]): Promise<void> {
    const filePath = this.filePath(projectId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, rules } satisfies AlertRuleDocument, null, 2), "utf8");
    await rename(temporary, filePath);
  }
}

function isPersistedRule(value: unknown): value is AlertRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.id === "string" && rule.id.length > 0
    && typeof rule.label === "string" && rule.label.length > 0
    && typeof rule.signalId === "string" && rule.signalId.length > 0
    && (rule.kind === "threshold-above" || rule.kind === "threshold-below")
    && typeof rule.threshold === "number" && Number.isFinite(rule.threshold)
    && (rule.severity === "info" || rule.severity === "warning" || rule.severity === "alarm")
    && (rule.hysteresis === undefined || (typeof rule.hysteresis === "number" && Number.isFinite(rule.hysteresis)));
}

class RuleValidationError extends Error {}

interface ProjectRuntime {
  rules: AlertRule[];
  engine: AlertEngine;
  unsubscribe?: () => void;
}

export interface AlertRuleRuntimeOptions {
  bus: DataEventBus;
  ruleStore: Pick<AlertRuleFileStore, "load" | "save">;
  engineFactory?: (rules: AlertRule[]) => AlertEngine;
  now?: () => number;
}

/**
 * 订阅项目数据事件流并同步喂 AlertEngine；规则命中/确认/清除以 alarm 数据事件回灌 bus。
 * 规则变更会重建引擎（评估状态随之重置），避免旧阈值下的残留激活/确认状态误导呈现。
 */
export class AlertRuleRuntime {
  private readonly projects = new Map<string, ProjectRuntime>();
  private readonly loaded = new Set<string>();
  private readonly engineFactory: (rules: AlertRule[]) => AlertEngine;
  private readonly now: () => number;

  constructor(private readonly options: AlertRuleRuntimeOptions) {
    this.engineFactory = options.engineFactory ?? ((rules) => new AlertEngine(rules));
    this.now = options.now ?? Date.now;
  }

  async listRules(projectId: string): Promise<AlertRule[]> {
    const runtime = await this.ensureLoaded(projectId);
    return [...runtime.rules];
  }

  async createRule(projectId: string, input: unknown): Promise<AlertRule> {
    const runtime = await this.ensureLoaded(projectId);
    const rule = parseRuleInput(input);
    if (runtime.rules.some((item) => item.label === rule.label && item.signalId === rule.signalId && item.kind === rule.kind)) {
      throw new RuleValidationError(`已存在同信号同类型的告警规则：${rule.label}`);
    }
    await this.replaceRules(projectId, [...runtime.rules, rule]);
    return rule;
  }

  async removeRule(projectId: string, ruleId: string): Promise<boolean> {
    const runtime = await this.ensureLoaded(projectId);
    const rules = runtime.rules.filter((item) => item.id !== ruleId);
    if (rules.length === runtime.rules.length) return false;
    await this.replaceRules(projectId, rules);
    return true;
  }

  async states(projectId: string): Promise<AlertStateSnapshot[]> {
    const runtime = await this.ensureLoaded(projectId);
    return runtime.engine.snapshot();
  }

  /** 确认一条激活中的告警；成功后向 bus 广播 acknowledged 告警事件。 */
  async acknowledge(projectId: string, ruleId: string): Promise<boolean> {
    const runtime = await this.ensureLoaded(projectId);
    if (!runtime.engine.acknowledge(ruleId, this.now())) return false;
    const rule = runtime.rules.find((item) => item.id === ruleId);
    const state = runtime.engine.snapshot().find((item) => item.ruleId === ruleId);
    if (rule && state) {
      this.options.bus.publish(toAlarmDataEvent(projectId, rule, "acknowledged", state.lastValue, this.now()));
    }
    return true;
  }

  dispose(): void {
    for (const runtime of this.projects.values()) runtime.unsubscribe?.();
    this.projects.clear();
    this.loaded.clear();
  }

  private async ensureLoaded(projectId: string): Promise<ProjectRuntime> {
    if (!this.loaded.has(projectId)) {
      this.loaded.add(projectId);
      this.projects.set(projectId, this.build(projectId, await this.options.ruleStore.load(projectId)));
    }
    const runtime = this.projects.get(projectId);
    if (runtime) return runtime;
    const rebuilt = this.build(projectId, []);
    this.projects.set(projectId, rebuilt);
    return rebuilt;
  }

  private async replaceRules(projectId: string, rules: AlertRule[]): Promise<void> {
    await this.options.ruleStore.save(projectId, rules);
    const previous = this.projects.get(projectId);
    previous?.unsubscribe?.();
    this.projects.set(projectId, this.build(projectId, rules));
  }

  private build(projectId: string, rules: AlertRule[]): ProjectRuntime {
    const runtime: ProjectRuntime = { rules, engine: this.engineFactory(rules) };
    if (rules.length > 0) {
      runtime.unsubscribe = this.options.bus.subscribe(projectId, undefined, (event) => this.evaluate(projectId, runtime, event));
    }
    return runtime;
  }

  private evaluate(projectId: string, runtime: ProjectRuntime, event: DataEvent): void {
    if (event.source === ALERT_EVENT_SOURCE) return;
    if (runtime.rules.length === 0) return;
    const values = signalValues(event);
    if (Object.keys(values).length === 0) return;
    const parsedAt = Date.parse(event.timestamp);
    const at = Number.isFinite(parsedAt) ? parsedAt : this.now();
    for (const alertEvent of runtime.engine.evaluate({ values, at })) {
      const rule = runtime.rules.find((item) => item.id === alertEvent.ruleId);
      if (rule) this.options.bus.publish(toAlarmDataEvent(projectId, rule, alertEvent.type, alertEvent.value, alertEvent.at, event));
    }
  }
}

/**
 * 从数据事件提取数值信号：标量数字用事件 key，对象值的有限数字叶子用 `key.name`。
 * 只接受有限数字（与 AlertEngine 的 SignalSample 契约一致）；字符串数字不静默转换，
 * 避免脏数据被当作有效量测触发告警。
 */
function signalValues(event: DataEvent): Record<string, number> {
  const values: Record<string, number> = {};
  const value = event.value;
  if (typeof value === "number" && Number.isFinite(value)) {
    values[event.key] = value;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, item] of Object.entries(value)) {
      if (typeof item === "number" && Number.isFinite(item)) values[`${event.key}.${name}`] = item;
    }
  }
  return values;
}

function toAlarmDataEvent(
  projectId: string,
  rule: AlertRule,
  status: AlertEvent["type"],
  value: number | null,
  at: number,
  trigger?: DataEvent,
): DataEvent {
  return {
    id: randomUUID(),
    projectId,
    source: ALERT_EVENT_SOURCE,
    key: `alert/${rule.id}`,
    value: {
      state: status === "cleared" ? "normal" : rule.severity === "alarm" ? "alarm" : "warning",
      active: status !== "cleared",
      severity: rule.severity === "alarm" ? "critical" : rule.severity,
      acknowledged: status === "acknowledged",
      status,
      ...(value === null ? {} : { value }),
      message: rule.label,
      ruleId: rule.id,
    },
    timestamp: new Date(at).toISOString(),
    action: "alarm",
    ...(trigger?.sceneId ? { sceneId: trigger.sceneId } : {}),
    ...(trigger?.target ? { target: trigger.target } : {}),
  };
}

function parseRuleInput(input: unknown): AlertRule {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RuleValidationError("告警规则请求体必须是 JSON 对象");
  const body = input as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 128) throw new RuleValidationError("告警规则需要 1-128 字符的 label");
  const signalId = typeof body.signalId === "string" ? body.signalId.trim() : "";
  if (!signalId || signalId.length > 128) throw new RuleValidationError("告警规则需要 1-128 字符的 signalId（数据信号键）");
  if (body.kind !== "threshold-above" && body.kind !== "threshold-below") {
    throw new RuleValidationError("kind 必须是 threshold-above（越上限）或 threshold-below（越下限）");
  }
  if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold)) {
    throw new RuleValidationError("threshold 必须是有限数字");
  }
  if (body.severity !== "info" && body.severity !== "warning" && body.severity !== "alarm") {
    throw new RuleValidationError("severity 必须是 info、warning 或 alarm");
  }
  let hysteresis: number | undefined;
  if (body.hysteresis !== undefined) {
    if (typeof body.hysteresis !== "number" || !Number.isFinite(body.hysteresis) || body.hysteresis < 0) {
      throw new RuleValidationError("hysteresis 必须是不小于 0 的有限数字");
    }
    hysteresis = body.hysteresis;
  }
  return {
    id: randomUUID(),
    label,
    signalId,
    kind: body.kind,
    threshold: body.threshold,
    severity: body.severity,
    ...(hysteresis !== undefined ? { hysteresis } : {}),
  };
}

interface AlertRuleBody {
  label?: unknown;
  signalId?: unknown;
  kind?: unknown;
  threshold?: unknown;
  severity?: unknown;
  hysteresis?: unknown;
}

export async function registerAlertRuleRoutes(
  app: FastifyInstance,
  store: MetadataStore,
  runtime: AlertRuleRuntime,
): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: AlertRuleBody }>("/api/projects/:projectId/alert-rules", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    try {
      return reply.code(201).send(await runtime.createRule(request.params.projectId, request.body));
    } catch (error) {
      if (error instanceof RuleValidationError) return reply.code(400).send({ message: error.message });
      throw error;
    }
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/alert-rules", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return runtime.listRules(request.params.projectId);
  });

  app.delete<{ Params: { projectId: string; ruleId: string } }>("/api/projects/:projectId/alert-rules/:ruleId", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const removed = await runtime.removeRule(request.params.projectId, request.params.ruleId);
    if (!removed) return reply.code(404).send({ message: "告警规则不存在" });
    return { ok: true, removed: true };
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/alert-state", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return { ok: true, states: await runtime.states(request.params.projectId) };
  });

  app.post<{ Params: { projectId: string; ruleId: string } }>("/api/projects/:projectId/alert-rules/:ruleId/acknowledge", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const acknowledged = await runtime.acknowledge(request.params.projectId, request.params.ruleId);
    if (!acknowledged) return reply.code(409).send({ message: "该告警不处于激活状态，无法确认" });
    return { ok: true };
  });
}
