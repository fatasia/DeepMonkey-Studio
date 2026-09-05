import { useEffect, useRef, useState } from "react";
import { ModelOptimizerWorkerClient } from "./modelOptimizerWorkerClient";

export type OptimizerTaskKind = "import" | "optimize" | "save";
export interface OptimizerTask {
  signal: AbortSignal;
  worker: () => ModelOptimizerWorkerClient;
  assertCurrent: () => void;
}

/** 每个工作区只允许一个当前任务；取消、替换、卸载共用同一失效通道。 */
export function useOptimizerTask() {
  const active = useRef<AbortController | undefined>(undefined);
  const worker = useRef<ModelOptimizerWorkerClient | undefined>(undefined);
  const [kind, setKind] = useState<OptimizerTaskKind>();

  function invalidate() {
    active.current?.abort();
    active.current = undefined;
    worker.current?.terminate();
    worker.current = undefined;
  }
  useEffect(() => invalidate, []);

  async function run(taskKind: OptimizerTaskKind, action: (task: OptimizerTask) => Promise<void>, onError: (reason: unknown) => void, replace = false) {
    if (active.current && !replace) return;
    invalidate();
    const controller = new AbortController();
    active.current = controller;
    setKind(taskKind);
    const assertCurrent = () => controller.signal.throwIfAborted();
    try {
      await action({ signal: controller.signal, assertCurrent, worker: () => {
        assertCurrent();
        worker.current ??= new ModelOptimizerWorkerClient();
        return worker.current;
      } });
    } catch (reason) {
      if (!controller.signal.aborted) onError(reason);
    } finally {
      if (active.current === controller) { invalidate(); setKind(undefined); }
    }
  }

  function cancel() { invalidate(); setKind(undefined); }
  return { kind, busy: Boolean(kind), run, cancel };
}
