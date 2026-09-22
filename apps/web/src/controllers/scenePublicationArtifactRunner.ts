import type { PublishedSceneRecord } from "@bim-studio/contracts";
import type { exportSceneClientPackage, SceneClientPackageResult, PreparedSceneClientPackage } from "../delivery/sceneClientPackage";
import { assertSceneArtifactRecord, resolveSceneArtifactPublication, type SceneArtifactRecord } from "./scenePublicationArtifactRecord";

export interface SceneArtifactRunnerDependencies {
  loadHistory(projectId: string, sceneId: string): Promise<PublishedSceneRecord[]>;
  exportPackage: typeof exportSceneClientPackage;
  exportExecutable?: typeof exportSceneClientPackage;
  saveRecord(record: SceneArtifactRecord): Promise<void>;
  onChange?: (record: SceneArtifactRecord) => void;
}

export interface SceneArtifactRunResult {
  record: SceneArtifactRecord;
  result?: SceneClientPackageResult;
}

/** 重试只读取已发布历史；执行器不保存草稿或创建发布版本。 */
export function createSceneArtifactRunner(deps: SceneArtifactRunnerDependencies) {
  const pending = new Map<string, { controller: AbortController; delivery: { committed: boolean }; operation: Promise<SceneArtifactRunResult> }>();
  const attempts = new Map<string, number>();

  function run(input: SceneArtifactRecord, prepared?: PreparedSceneClientPackage): Promise<SceneArtifactRunResult> {
    const existing = pending.get(input.key);
    if (existing) return existing.operation;
    const frozen = structuredClone(input);
    const controller = new AbortController();
    const delivery = { committed: false };
    const attemptId = Math.max(input.attemptId, attempts.get(input.key) ?? 0) + 1;
    attempts.set(input.key, attemptId);
    // 先登记执行权，再开始异步工作，onChange 中的重复调用也复用本次任务。
    const operation = Promise.resolve().then(() => execute(frozen, attemptId, controller.signal, () => { delivery.committed = true; }, prepared))
      .finally(() => { if (pending.get(frozen.key)?.operation === operation) pending.delete(frozen.key); });
    pending.set(frozen.key, { controller, delivery, operation });
    return operation;
  }

  async function execute(input: SceneArtifactRecord, attemptId: number, signal: AbortSignal, commitDelivery: () => void,
    prepared?: PreparedSceneClientPackage): Promise<SceneArtifactRunResult> {
    assertSceneArtifactRecord(input);
    let record = { ...input, attemptId };
    let persistenceFailed = false;
    async function persist(status: SceneArtifactRecord["status"], error?: string, errorCode?: string) {
      record = { ...record, status, updatedAt: new Date().toISOString() };
      delete record.error; delete record.errorCode;
      if (error !== undefined) record.error = error;
      if (errorCode !== undefined) record.errorCode = errorCode;
      try { await deps.saveRecord(structuredClone(record)); }
      catch (reason) { persistenceFailed = true; throw reason; }
      if (!signal.aborted || status === "cancelled") deps.onChange?.(structuredClone(record));
    }
    try {
      await persist("preparing");
      signal.throwIfAborted();
      const history = await abortable(deps.loadHistory(record.projectId, record.sceneId), signal);
      signal.throwIfAborted();
      const publication = resolveSceneArtifactPublication(record, history);
      await persist("building");
      signal.throwIfAborted();
      const exporter = record.format === "executable" ? deps.exportExecutable : deps.exportPackage;
      if (!exporter) throw new Error("Scene EXE 下载器未配置");
      const result = await abortable(exporter({
        projectId: record.projectId, scene: publication.snapshot, target: record.target,
        publication,
        renderer: record.renderer, toolbarVisible: record.toolbarVisible, signal,
        ...(record.branding ? { branding: record.branding } : {}),
        ...(prepared === undefined ? {} : { prepared }),
      }), signal);
      signal.throwIfAborted();
      // 导出成功时文件交付已发生。此后取消无效；ready 写入失败仍拒绝，不能伪装成取消。
      commitDelivery();
      await persist("ready");
      signal.throwIfAborted();
      return { record: structuredClone(record), result };
    } catch (reason) {
      if (persistenceFailed) throw reason;
      if (signal.aborted) await persist("cancelled", "客户端打包已取消。", "cancelled");
      else {
        await persist("failed", reason instanceof Error ? reason.message : String(reason), "build-failed");
        if (signal.aborted) await persist("cancelled", "客户端打包已取消。", "cancelled");
      }
      return { record: structuredClone(record) };
    }
  }

  return { run, cancel: (key: string): void => {
    const request = pending.get(key);
    if (request && !request.delivery.committed) request.controller.abort();
  } };
}

/** 历史读取没有 signal 参数；取消后停止等待，同时接住底层迟到结果。 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
