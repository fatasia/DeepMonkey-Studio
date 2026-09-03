import { useEffect, useRef, useState } from "react";
import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import { api } from "../api";

export type PlantLiteRunKind = "single" | "batch" | "reproduce";
export type PlantLiteRunPhase = "running" | "cancelling" | "refreshing";

export interface PlantLiteRunProgress {
  kind: PlantLiteRunKind;
  phase: PlantLiteRunPhase;
  current: number;
  total: number;
  saved: number;
}

interface PlantLiteBatchFailure {
  name: string;
  message: string;
}

export interface PlantLiteBatchResult {
  total: number;
  current: number;
  saved: number;
  cancelled: boolean;
  failures: PlantLiteBatchFailure[];
}

interface ActivePlantLiteRun {
  id: number;
  controller: AbortController;
}

interface UsePlantLiteRunControllerOptions {
  projectId: string;
  reload: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setError: (message: string) => void;
}

interface ExecutePlantLiteBatchOptions {
  requests: PlantLiteStudyRequest[];
  signal: AbortSignal;
  run: (request: PlantLiteStudyRequest, signal: AbortSignal) => Promise<unknown>;
  onProgress?: (progress: Pick<PlantLiteRunProgress, "current" | "total" | "saved">) => void;
}

/** 顺序运行有意保留：避免多个 DES Worker 同时争抢浏览器与服务端资源。 */
export async function executePlantLiteBatch({
  requests,
  signal,
  run,
  onProgress,
}: ExecutePlantLiteBatchOptions): Promise<PlantLiteBatchResult> {
  let saved = 0;
  let current = 0;
  let cancelled = signal.aborted;
  const failures: PlantLiteBatchFailure[] = [];
  for (let index = 0; index < requests.length && !cancelled; index += 1) {
    const request = requests[index];
    if (!request) continue;
    current = index + 1;
    onProgress?.({ current, total: requests.length, saved });
    try {
      await run(request, signal);
      saved += 1;
      onProgress?.({ current, total: requests.length, saved });
    } catch (reason) {
      if (isPlantLiteCancellation(reason, signal)) {
        cancelled = true;
        break;
      }
      failures.push({
        name: request.name?.trim() || "未命名方案",
        message: compactPlantLiteRunError(reason),
      });
    }
    cancelled = signal.aborted;
  }
  return { total: requests.length, current, saved, cancelled, failures };
}

export function plantLiteRunProgressLabel(progress: PlantLiteRunProgress): string {
  if (progress.kind === "batch") {
    if (progress.phase === "refreshing") return `刷新结果 · 已保存 ${progress.saved}/${progress.total}`;
    if (progress.phase === "cancelling") return `正在取消 ${progress.current}/${progress.total} · 已保存 ${progress.saved}`;
    return `运行 ${progress.current}/${progress.total} · 已保存 ${progress.saved}`;
  }
  const task = progress.kind === "reproduce" ? "复现" : "仿真";
  if (progress.phase === "refreshing") return `${task}完成 · 刷新结果`;
  if (progress.phase === "cancelling") return `正在取消${task}`;
  return `${task}运行中`;
}

export function isPlantLiteCancellation(reason: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return reason instanceof Error && reason.name === "AbortError";
}

export function compactPlantLiteRunError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/\s+/g, " ").trim().slice(0, 160) || "运行失败";
}

export function usePlantLiteRunController({
  projectId,
  reload,
  setBusy,
  setError,
}: UsePlantLiteRunControllerOptions) {
  const [progress, setProgress] = useState<PlantLiteRunProgress>();
  const [notice, setNotice] = useState("");
  const activeRef = useRef<ActivePlantLiteRun | undefined>(undefined);
  const nextIdRef = useRef(0);

  useEffect(() => () => {
    activeRef.current?.controller.abort();
    activeRef.current = undefined;
    setBusy(false);
  }, [projectId, setBusy]);

  function begin(kind: PlantLiteRunKind, total: number): ActivePlantLiteRun | undefined {
    if (activeRef.current) return undefined;
    const active = { id: nextIdRef.current += 1, controller: new AbortController() };
    activeRef.current = active;
    setProgress({ kind, phase: "running", current: 1, total, saved: 0 });
    setNotice("");
    setError("");
    setBusy(true);
    return active;
  }

  function isCurrent(active: ActivePlantLiteRun): boolean {
    return activeRef.current?.id === active.id;
  }

  function update(active: ActivePlantLiteRun, next: PlantLiteRunProgress) {
    if (isCurrent(active)) setProgress(next);
  }

  function finish(active: ActivePlantLiteRun) {
    if (!isCurrent(active)) return;
    activeRef.current = undefined;
    setProgress(undefined);
    setBusy(false);
  }

  async function refresh(active: ActivePlantLiteRun): Promise<string | undefined> {
    try {
      await reloadPlantLiteResults(reload);
      return undefined;
    } catch (reason) {
      if (!isCurrent(active)) return undefined;
      return compactPlantLiteRunError(reason);
    }
  }

  async function runSingle(
    kind: Extract<PlantLiteRunKind, "single" | "reproduce">,
    execute: (signal: AbortSignal) => Promise<unknown>,
  ) {
    const active = begin(kind, 1);
    if (!active) return;
    try {
      await execute(active.controller.signal);
      if (!isCurrent(active)) return;
      update(active, { kind, phase: "refreshing", current: 1, total: 1, saved: 1 });
      const refreshError = await refresh(active);
      if (!isCurrent(active)) return;
      if (refreshError) setError(`${kind === "reproduce" ? "复现" : "仿真"}结果已保存，但列表刷新失败：${refreshError}`);
      else setNotice(`${kind === "reproduce" ? "复现" : "仿真"}完成，结果已保存。`);
    } catch (reason) {
      if (!isCurrent(active)) return;
      if (!isPlantLiteCancellation(reason, active.controller.signal)) {
        setError(compactPlantLiteRunError(reason));
        return;
      }
      update(active, { kind, phase: "refreshing", current: 1, total: 1, saved: 0 });
      const refreshError = await refresh(active);
      if (!isCurrent(active)) return;
      if (refreshError) setError(`仿真已取消；已完成结果仍会保留，但列表刷新失败：${refreshError}`);
      else setNotice("已取消当前仿真；已完成结果已保留。");
    } finally {
      finish(active);
    }
  }

  async function run(request: PlantLiteStudyRequest) {
    await runSingle("single", (signal) => api.runPlantLiteStudy(projectId, request, signal));
  }

  async function reproduce(studyId: string) {
    await runSingle("reproduce", (signal) => api.reproducePlantLiteStudy(projectId, studyId, signal));
  }

  async function runBatch(requests: PlantLiteStudyRequest[]) {
    const batch = requests.slice(0, 4);
    if (!batch.length) return;
    const active = begin("batch", batch.length);
    if (!active) return;
    try {
      const result = await executePlantLiteBatch({
        requests: batch,
        signal: active.controller.signal,
        run: (request, signal) => api.runPlantLiteStudy(projectId, request, signal),
        onProgress: (value) => update(active, { kind: "batch", phase: "running", ...value }),
      });
      if (!isCurrent(active)) return;
      update(active, {
        kind: "batch",
        phase: "refreshing",
        current: Math.max(1, result.current),
        total: result.total,
        saved: result.saved,
      });
      const refreshError = await refresh(active);
      if (!isCurrent(active)) return;
      if (refreshError) {
        setError(`方案实验已保存 ${result.saved}/${result.total} 个结果，但列表刷新失败：${refreshError}`);
      } else if (result.cancelled) {
        setNotice(`已取消当前请求和剩余队列；已保存 ${result.saved}/${result.total} 个结果。`);
      } else if (result.failures.length) {
        setError(`方案实验已保存 ${result.saved}/${result.total} 个结果；${result.failures.map((item) => `${item.name}：${item.message}`).join("；")}`);
      } else {
        setNotice(`方案实验完成，已保存 ${result.saved}/${result.total} 个结果。`);
      }
    } catch (reason) {
      if (isCurrent(active)) setError(compactPlantLiteRunError(reason));
    } finally {
      finish(active);
    }
  }

  function cancel() {
    const active = activeRef.current;
    if (!active || progress?.phase !== "running") return;
    setProgress((current) => current ? { ...current, phase: "cancelling" } : current);
    active.controller.abort();
  }

  return { progress, notice, run, runBatch, reproduce, cancel };
}

async function reloadPlantLiteResults(reload: () => Promise<void>, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await reload();
      return;
    } catch (reason) {
      lastError = reason;
      if (attempt + 1 < attempts) await new Promise((resolve) => globalThis.setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}
