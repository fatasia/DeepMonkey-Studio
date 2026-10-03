import { useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import { createSceneEditPort } from "../ai/sceneEditPort";
import type { SceneEditPort } from "../ai/sceneEditSession";
import { sceneMetadataDraftPatch } from "../studio/editorSceneWriteDriver";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { AppViewBindings } from "../views/appViewBindings";

/** 把当前编辑器(引擎/撤销栈/作者写入口/draft 状态)接成助手场景改动闭环端口;无活跃场景时返回 undefined。 */
/**
 * 事务/命令使用固定的 "active-scene" 作用域:视口引擎同一时刻只承载一个场景,而未保存场景首次保存会换 ID(自动保存默认开启),
 * 若用真实 ID,审阅期间的换 ID 会让整批以 scene-mismatch 失败。切换场景导致的状态变化由 runner 的前值指纹校验兜底。
 */
export const ASSISTANT_ACTIVE_SCENE_ID = "active-scene";

export function useSceneEditPort(bindings: AppViewBindings, engine: ViewerEngine | null | undefined): SceneEditPort | undefined {
  const latest = useRef({ bindings, engine });
  latest.current = { bindings, engine };
  return useMemo(() => {
    if (!engine) return undefined;
    return createSceneEditPort({
      sceneId: ASSISTANT_ACTIVE_SCENE_ID,
      engine: () => latest.current.engine ?? undefined,
      unavailableReason: () => {
        const { bindings: current } = latest.current;
        if (current.playMode?.active) return "Play 模式下的改动是临时态,请先退出 Play";
        return current.sceneAuthoring ? undefined : "场景正忙或处于行为/动画运行态,暂不可写入";
      },
      authoring: () => latest.current.bindings.sceneAuthoring,
      beginTransaction: label => {
        const authoring = latest.current.bindings.sceneAuthoring;
        if (!authoring) throw new Error("当前不可写入场景");
        return authoring.begin(label);
      },
      syncDraft: commands => {
        const { state } = latest.current.bindings;
        const draft = sceneMetadataDraftPatch(commands);
        // 同步提交,保证随后事务 commit 的作者快照已包含这些 draft 变更。
        flushSync(() => {
          if (draft.lightingPatch) state.setLighting(value => ({ ...value, ...draft.lightingPatch! }));
          if (draft.environmentPatch) state.setSceneEnvironment(value => ({ ...value, ...draft.environmentPatch! }));
          if (draft.weather) state.setWeather(draft.weather);
          if (draft.animationAnchorPatch) {
            state.setSceneAnimation(value => value.stateMachine ? { ...value, stateMachine: { ...value.stateMachine, ...draft.animationAnchorPatch! } } : value);
          }
        });
      },
      undoLabel: () => latest.current.bindings.sceneHistory.undoLabel,
      undo: () => latest.current.bindings.sceneHistory.undo(),
    });
  }, [engine]);
}
