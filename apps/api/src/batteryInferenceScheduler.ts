import { randomUUID } from "node:crypto";
import type { AiDataBinding, DataSourceEvidence } from "@bim-studio/contracts";
import type { CapabilityInvocationResult } from "@bim-studio/plugin-runtime";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { prepareAiBindingSnapshot } from "./aiDataBindingRuntime.js";
import { readAiDataset } from "./aiDatasetSource.js";
import type { IndustrialCapabilityHost } from "./industrialCapabilities.js";
import type { MetadataStore } from "./metadataStore.js";
import { failAiDataBindingRun, startAiDataBindingRun, succeedAiDataBindingRun } from "./aiDataBindingRunRecorder.js";

interface SchedulerDependencies {
  store: MetadataStore;
  host: IndustrialCapabilityHost;
  dataQuerySource: DataQuerySource;
  onResult?: (event: BatteryScheduledRunEvent) => Promise<void> | void;
  onError?: (error: unknown, bindingId: string) => void;
}

export interface BatteryScheduledRunEvent {
  projectId: string;
  binding: AiDataBinding;
  startedAt: string;
  completedAt: string;
  sourceEvidence: DataSourceEvidence;
  result: CapabilityInvocationResult<Record<string, unknown>>;
}

/** 单机电池周期执行器；模型路由仍完全由 battery.model.predict 插件负责。 */
export class BatteryInferenceScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly nextRunAt = new Map<string, number>();
  private readonly active = new Map<string, AbortController>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly dependencies: SchedulerDependencies, private readonly heartbeatMs = 1_000) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.heartbeatMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort("电池推理调度器已停止");
    this.active.clear();
  }

  async tick(now = Date.now()): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const project of this.dependencies.store.listProjects()) {
      for (const binding of this.dependencies.store.listAiDataBindings(project.id)) {
        const key = bindingKey(project.id, binding.id);
        if (!isRunnableBatteryBinding(binding) || this.active.has(key)) continue;
        if ((this.nextRunAt.get(key) ?? 0) > now) continue;
        this.nextRunAt.set(key, now + nextIntervalMs(binding, this.failures.get(key) ?? 0));
        pending.push(this.runBinding(project.id, binding));
      }
    }
    await Promise.all(pending);
  }

  private async runBinding(projectId: string, binding: AiDataBinding): Promise<void> {
    const controller = new AbortController();
    const key = bindingKey(projectId, binding.id);
    this.active.set(key, controller);
    const startedAt = new Date().toISOString();
    const run = await startAiDataBindingRun(this.dependencies.store, binding, (this.failures.get(key) ?? 0) + 1);
    let sourceEvidence: DataSourceEvidence | undefined;
    try {
      const snapshot = await readAiDataset(
        this.dependencies.dataQuerySource,
        this.dependencies.store,
        projectId,
        binding.datasetId,
        controller.signal,
      );
      sourceEvidence = snapshot.evidence;
      const prepared = prepareAiBindingSnapshot(binding, snapshot);
      const result = await this.dependencies.host.invoke<Record<string, unknown>>(binding.capabilityId, {
        requestId: randomUUID(),
        projectId,
        principal: "battery-scheduler",
        role: "admin",
        signal: controller.signal,
        input: batteryInput(binding, prepared.records),
      });
      if (result.status === "failed" || result.status === "blocked") {
        throw new Error(result.error?.message ?? `电池能力运行状态：${result.status}`);
      }
      this.failures.delete(key);
      await succeedAiDataBindingRun(this.dependencies.store, run, binding, snapshot.evidence, result.output);
      await this.dependencies.onResult?.({
        projectId,
        binding,
        startedAt,
        completedAt: new Date().toISOString(),
        sourceEvidence: snapshot.evidence,
        result,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
        await failAiDataBindingRun(this.dependencies.store, run, error, sourceEvidence);
        this.dependencies.onError?.(error, binding.id);
      }
    } finally {
      this.active.delete(key);
    }
  }
}

function isRunnableBatteryBinding(binding: AiDataBinding): binding is AiDataBinding & { trigger: { type: "interval"; seconds: number } } {
  return binding.status === "active"
    && binding.capabilityId === "battery.model.predict"
    && binding.trigger.type === "interval";
}

function nextIntervalMs(binding: AiDataBinding & { trigger: { type: "interval"; seconds: number } }, failures: number): number {
  const base = Math.max(1, binding.trigger.seconds) * 1_000;
  const backoff = binding.retry.backoffSeconds * 1_000 * 2 ** Math.min(4, failures);
  return Math.min(24 * 60 * 60_000, Math.max(base, backoff));
}

function batteryInput(binding: AiDataBinding, records: Array<Record<string, string | number>>): Record<string, unknown> {
  const parameters = binding.parameters ?? {};
  const model = text(parameters.model);
  if (!model) throw new Error("电池绑定缺少正式模型");
  return {
    model,
    fileName: `dataset:${binding.datasetId}`,
    records,
    ...copyParameter(parameters, "chemistry"),
    ...copyParameter(parameters, "routingMode"),
    ...copyParameter(parameters, "nominalCapacityAh"),
    ...copyParameter(parameters, "targetCapacityRetention"),
  };
}

function copyParameter(parameters: Record<string, string | number | boolean>, key: string): Record<string, string | number | boolean> {
  const value = parameters[key];
  return value === undefined ? {} : { [key]: value };
}

function text(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bindingKey(projectId: string, bindingId: string): string {
  return `${projectId}:${bindingId}`;
}
