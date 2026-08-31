import type { AiDataBinding } from "@bim-studio/contracts";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { readAiDataset } from "./aiDatasetSource.js";
import { prepareAiBindingSnapshot } from "./aiDataBindingRuntime.js";
import { failAiDataBindingRun, startAiDataBindingRun, succeedAiDataBindingRun } from "./aiDataBindingRunRecorder.js";
import type { MetadataStore } from "./metadataStore.js";
import type { OperationsService } from "./operations.js";

interface SchedulerDependencies {
  store: MetadataStore;
  operations: OperationsService;
  dataQuerySource: DataQuerySource;
  onError?: (error: unknown, deploymentId: string) => void;
}

/** 单机部署调度器：按维护部署的采样周期读取统一数据集，避免各模型私接协议驱动。 */
export class MaintenanceInferenceScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly nextRunAt = new Map<string, number>();
  private readonly active = new Map<string, AbortController>();

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
    for (const controller of this.active.values()) controller.abort("维护推理调度器已停止");
    this.active.clear();
  }

  async tick(now = Date.now()): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const project of this.dependencies.store.listProjects()) {
      const datasets = new Set(this.dependencies.dataQuerySource.listDatasets(project.id).map((item) => item.id));
      for (const deployment of this.dependencies.operations.snapshot(project.id).deployments) {
        if (!deployment.enabled || !datasets.has(deployment.sourceId) || this.active.has(deployment.id)) continue;
        const binding = deployment.bindingId
          ? this.dependencies.store.getAiDataBinding(project.id, deployment.bindingId)
          : undefined;
        // 新绑定严格按激活状态和周期触发；旧部署保留原有定时行为，避免升级后静默停机。
        if (deployment.bindingId && (!binding || binding.status !== "active" || binding.trigger.type !== "interval")) continue;
        if ((this.nextRunAt.get(deployment.id) ?? 0) > now) continue;
        // 连续失败时自动退避，弱网恢复后由成功评估清零，不让离线设备持续打满连接器。
        const failures = deployment.consecutiveFailures ?? 0;
        const failureBackoff = binding ? binding.retry.backoffSeconds * 1_000 * 2 ** Math.min(4, failures) : 0;
        const baseIntervalMs = Math.max(1, binding?.trigger.type === "interval" ? binding.trigger.seconds : deployment.sampleIntervalSec) * 1_000;
        const intervalMs = Math.min(15 * 60_000, Math.max(baseIntervalMs, failureBackoff));
        this.nextRunAt.set(deployment.id, now + intervalMs);
        pending.push(this.runDeployment(project.id, deployment.id, deployment.sourceId, binding));
      }
    }
    await Promise.all(pending);
  }

  private async runDeployment(projectId: string, deploymentId: string, datasetId: string, binding?: AiDataBinding): Promise<void> {
    const controller = new AbortController();
    this.active.set(deploymentId, controller);
    const run = binding ? await startAiDataBindingRun(this.dependencies.store, binding) : undefined;
    let sourceEvidence;
    try {
      const snapshot = await readAiDataset(
        this.dependencies.dataQuerySource,
        this.dependencies.store,
        projectId,
        datasetId,
        controller.signal,
      );
      sourceEvidence = snapshot.evidence;
      const rows = binding ? prepareAiBindingSnapshot(binding, snapshot).numericRows : snapshot.numericRows;
      const assessment = await this.dependencies.operations.assess(projectId, deploymentId, rows, snapshot.evidence);
      if (run && binding) await succeedAiDataBindingRun(this.dependencies.store, run, binding, snapshot.evidence, assessment);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (run) await failAiDataBindingRun(this.dependencies.store, run, error, sourceEvidence);
        await this.dependencies.operations.recordDeploymentFailure(projectId, deploymentId, error);
        this.dependencies.onError?.(error, deploymentId);
      }
    } finally {
      this.active.delete(deploymentId);
    }
  }
}
