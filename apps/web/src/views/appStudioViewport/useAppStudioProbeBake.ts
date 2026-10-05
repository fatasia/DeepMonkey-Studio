import { useCallback, useEffect, useRef, useState } from "react";
import type { ProbeGridBakeGrid } from "@bim-studio/deep-engine";
import { runProbeGridBake } from "../../delivery/probeGridBakeRunner";
import { storeProbeGridBake } from "../../delivery/probeGridBakePublicationSession";
import { fetchPersistedProbeGridBake, persistProbeGridBake } from "../../delivery/probeGridBakePersistence";
import type { ProbeGridBakeUiState } from "../../components/SceneProbeGridBakePanel";
import type { AppStudioController } from "../AppStudioShell";

/**
 * AppStudioViewport F3 探针网格烘焙域状态(source-size 拆分,2026-10-04:自
 * AppStudioViewport.tsx 按职责抽出自定义 hook,代码逐行同源;语义零变化)。
 *
 * 职责:烘焙 UI 状态机与执行回调。结果由 runner 存入发布会话态,Deep Native 打包
 * (exportSceneClientPackage → prepareNativeSceneClientPayload)按场景语义哈希自动携带;
 * 场景/项目切换即回到 idle,烘焙中的旧任务回执被丢弃;场景加载/切换时异步回填
 * 服务端持久化烘焙。
 */
export function useAppStudioProbeBake(
  project: AppStudioController["project"],
  activeScene: AppStudioController["activeScene"],
): {
  readonly probeBake: ProbeGridBakeUiState;
  readonly bakeProbeGrid: (grid: ProbeGridBakeGrid) => void;
} {
  const [probeBake, setProbeBake] = useState<ProbeGridBakeUiState>({ kind: "idle" });
  const probeBakeOwnerRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    probeBakeOwnerRef.current = project?.id && activeScene ? `${project.id}/${activeScene.id}` : undefined;
    setProbeBake({ kind: "idle" });
  }, [project?.id, activeScene?.id]);
  // F3 持久化回填:场景加载/切换时异步 GET 服务端持久化烘焙,命中即写回发布会话态
  // (probeGridBakeForPayload 随后可取到)。哈希用当前场景语义计算,场景已变化时服务端
  // 自然失配(404),不命中不报错、不阻塞渲染;切换走人后过期回执被丢弃。
  useEffect(() => {
    if (!activeScene) return;
    const ownerKey = project?.id ? `${project.id}/${activeScene.id}` : undefined;
    let subscribed = true;
    fetchPersistedProbeGridBake(activeScene).then(entry => {
      if (!entry || !subscribed || probeBakeOwnerRef.current !== ownerKey) return;
      storeProbeGridBake(activeScene, entry);
      // 仅在 idle 时呈现回填状态,避免覆盖同场景内已开始的烘焙进度。
      setProbeBake(current => current.kind !== "idle" ? current : { kind: "done",
        probeCount: entry.probeCount, coveredCount: entry.coveredCount,
        coverage: entry.probeCount > 0 ? entry.coveredCount / entry.probeCount : 0 });
    }).catch(() => undefined);
    return () => { subscribed = false; };
  }, [project?.id, activeScene?.id]);
  const bakeProbeGrid = useCallback((grid: ProbeGridBakeGrid) => {
    if (!activeScene || !project) return;
    const ownerKey = `${project.id}/${activeScene.id}`;
    setProbeBake({ kind: "running", phase: "compile-scene" });
    runProbeGridBake({ scene: activeScene, models: project.models, grid })
      .then(outcome => {
        // 烘焙成功即入发布会话(键=编译器严格源投影哈希):发布链 probeGridBakeForPayload
        // 才能取到探针数据。此前只更新 UI 状态,发布时 lookup 必然落空——烘焙→发布断链。
        storeProbeGridBake(activeScene, outcome);
        // F3 持久化:异步上送服务端(按 sceneId+sourceHash 内容寻址),失败静默降级
        // =维持会话态,只 console.warn;不阻塞回执,也不影响本次会话内的发布。
        void persistProbeGridBake(activeScene, outcome);
        if (probeBakeOwnerRef.current === ownerKey) setProbeBake({ kind: "done",
          probeCount: outcome.probeCount, coveredCount: outcome.coveredCount, coverage: outcome.coverage });
      })
      .catch(reason => {
        if (probeBakeOwnerRef.current === ownerKey) setProbeBake({ kind: "error",
          message: reason instanceof Error ? reason.message : String(reason) });
      });
  }, [activeScene, project]);
  return { probeBake, bakeProbeGrid };
}
