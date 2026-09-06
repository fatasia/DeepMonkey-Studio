import { useCallback, useEffect, useRef, useState } from "react";
import type { ApplicationDocument, JsonValue, ProjectRecord, ScriptModule } from "@bim-studio/contracts";
import { api } from "../api";
import { ApplicationPlaybackSession } from "./ApplicationPlaybackSession";
import { authorBehaviorDocument, type AuthorBehaviorScope } from "./authorBehaviorDocument";
import { loadScriptDependencyModules } from "./scriptDependencyRuntime";
import type { BehaviorLogEntry } from "./behaviorLogModel";
import { createSceneBehaviorWorker } from "./SceneBehaviorHost";

interface Options {
  application?: ApplicationDocument;
  project?: ProjectRecord;
  pageId?: string;
  sceneId?: string;
  variables?: Readonly<Record<string, JsonValue>>;
  filters?: Readonly<Record<string, JsonValue>>;
  enabled: boolean;
}

/** Author UI owns no runtime writes: only this disposable session receives them. */
export function useAuthorBehaviorRun(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const owner = useRef<ApplicationPlaybackSession | undefined>(undefined);
  const runId = useRef(0);
  const [session, setSession] = useState<ApplicationPlaybackSession>();
  const [logs, setLogs] = useState<BehaviorLogEntry[]>([]);
  const [, refresh] = useState(0);
  const stop = useCallback(() => {
    runId.current += 1;
    owner.current?.dispose();
    owner.current = undefined;
    setSession(undefined);
  }, []);
  useEffect(() => {
    stop();
    setLogs([]);
    return () => { runId.current += 1; owner.current?.dispose(); owner.current = undefined; };
  }, [options.application?.metadata.id, options.project?.id, options.pageId, options.sceneId, options.enabled, stop]);

  useEffect(() => {
    if (!session) return;
    let frame = 0;
    let previous = performance.now();
    let painted = 0;
    let dirty = true;
    const timestamp = new Date().toISOString();
    const id = runId.current;
    session.onChange = () => { dirty = true; };
    const advance = (now: number) => {
      if (owner.current !== session) return;
      session.advance(now - previous);
      previous = now;
      if (dirty && now - painted >= 100) {
        setLogs(session.logs.map((log, index) => ({ ...log, id: `${id}:${index}`, timestamp })));
        refresh(value => value + 1);
        dirty = false;
        painted = now;
      }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => { cancelAnimationFrame(frame); delete session.onChange; };
  }, [session]);

  const run = useCallback(async (draft?: ScriptModule, scope: AuthorBehaviorScope = "current", authorDebug = false) => {
    const current = latest.current;
    if (!current.enabled || !current.application || !current.project) throw new Error("请先打开可编辑项目");
    stop();
    const source = authorBehaviorDocument(current.application, draft, scope, {
      ...(current.pageId ? { pageId: current.pageId } : {}), ...(current.sceneId ? { sceneId: current.sceneId } : {}),
    });
    const id = runId.current;
    const next = new ApplicationPlaybackSession(source.document, source.pageId, {
      project: current.project,
      isolateNavigation: true,
      allowLegacyScripts: false,
      ...(authorDebug ? { workerFactory: () => createSceneBehaviorWorker("bim-studio-author-debug") } : {}),
      ...(current.variables ? { variables: current.variables } : {}), ...(current.filters ? { filters: current.filters } : {}),
      hostOptions: {
        ...(authorDebug ? { authorDebug: true } : {}),
        executeNetworkRequest: async ({ binding, variables }) => {
          const result = await api.executeDirectBinding(binding, variables);
          return { ok: true, status: result.status, data: result.data as JsonValue, value: result.value as JsonValue };
        },
        executeCapabilityRequest: async ({ capabilityId, input }) => JSON.parse(JSON.stringify(await api.invokeCapability(current.project!.id, capabilityId, input, "script-runtime"))),
      },
    });
    owner.current = next;
    setLogs([]);
    setSession(next);
    await next.start(() => loadScriptDependencyModules(source.document.metadata.projectId, source.document.scriptDependencies ?? [], api.readScriptDependency));
    if (owner.current !== next || id !== runId.current) throw new Error("试运行已取消");
    const failure = next.logs.find(log => log.moduleId === "runtime" && log.level === "error");
    if (failure) throw new Error(failure.message);
  }, [stop]);

  return { session, logs, run, stop, id: runId.current,
    debug: (draft: ScriptModule) => run(draft, "current", true),
    clearLogs: () => { if (session) session.logs = []; setLogs([]); },
    pauseResume: () => { owner.current?.togglePause(); refresh(value => value + 1); },
    step: () => { owner.current?.step(); refresh(value => value + 1); },
  };
}
