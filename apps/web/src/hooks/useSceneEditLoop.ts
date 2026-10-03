import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SceneEditRunner, type SceneEditMode, type SceneEditPort, type SceneEditSession } from "../ai/sceneEditSession";
import type { AssistantSessionOptions } from "../components/AssistantModelControls";

/** 持有一个场景改动会话;组件卸载/切项目即取消(不留悬挂的模型请求)。 */
export function useSceneEditLoop(port: SceneEditPort | undefined, projectId: string | undefined) {
  const [runner, setRunner] = useState<SceneEditRunner>();
  const runnerRef = useRef<SceneEditRunner | undefined>(undefined);
  runnerRef.current = runner;
  const session: SceneEditSession | undefined = useSyncExternalStore(
    useCallback((listener: () => void) => runner?.subscribe(listener) ?? (() => undefined), [runner]),
    () => runner?.getState(),
    () => undefined,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => () => runnerRef.current?.cancel(), []);
  useEffect(() => { setRunner((current) => { current?.cancel(); return undefined; }); }, [projectId, port]);

  const start = useCallback(async (input: { objective: string; mode: SceneEditMode; maxCorrections: number; modelOptions: AssistantSessionOptions }) => {
    if (!port) return;
    runnerRef.current?.cancel();
    const created = new SceneEditRunner(port, async (question, context, signal) => {
      const { api } = await import("../api");
      const result = await api.streamAssistant("scene", question, context, () => undefined, {
        ...(projectId ? { projectId } : {}), signal,
        ...(input.modelOptions.model ? { model: input.modelOptions.model } : {}),
        ...(input.modelOptions.reasoningEffort ? { reasoningEffort: input.modelOptions.reasoningEffort } : {}),
      });
      return { text: result.text, model: result.model };
    }, { id: `se-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, objective: input.objective, mode: input.mode, maxCorrections: input.maxCorrections },
    async (record) => {
      if (!projectId) throw new Error("no project");
      const { api } = await import("../api");
      await api.recordSceneEdit(projectId, record);
    });
    setRunner(created);
    setBusy(true);
    try { await created.start(); } finally { setBusy(false); }
  }, [port, projectId]);

  const run = useCallback(async (action: (target: SceneEditRunner) => Promise<void> | void) => {
    const target = runnerRef.current;
    if (!target) return;
    setBusy(true);
    try { await action(target); } finally { setBusy(false); }
  }, []);

  return {
    session, busy, start,
    approve: () => run((target) => target.approve()),
    reject: () => run((target) => target.reject()),
    undo: () => run((target) => target.undo()),
    cancel: () => runnerRef.current?.cancel(),
    reset: () => { runnerRef.current?.cancel(); setRunner(undefined); },
  };
}
