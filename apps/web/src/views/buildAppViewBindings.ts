import type { MutableRefObject } from "react";
import type { AppViewBindings } from "./appViewBindings";
import type { EditorPrimitiveDeleteAuthoring } from "../studio/editorPrimitiveDeleteAuthoring";
import { createRestrictedPlayConsumer, type RestrictedPlayConsumer } from "../scripting/restrictedPlayConsumer";
import { playTraceStore } from "../scripting/playTraceStore";
import { formatPlayEntryNotice, formatPlayExitNotice } from "../hooks/useScenePlayMode";
import { downloadWorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import type { useAppState } from "../hooks/useAppState";
import type { useSceneHistoryState } from "../hooks/useSceneHistoryState";
import type { useSceneHistoryActions } from "../hooks/useSceneHistoryActions";
import type { useScenePlayMode } from "../hooks/useScenePlayMode";
import type { useAppDerivedState } from "../hooks/useAppDerivedState";
import type { useAppNavigationController } from "../hooks/useAppNavigationController";
import type { useApplicationRecovery } from "../hooks/useApplicationRecovery";
import type { useScenePublicationArtifacts } from "../hooks/useScenePublicationArtifacts";
import type { createSceneEditorController } from "../controllers/sceneEditorController";
import type { createScenePersistenceController } from "../controllers/scenePersistenceController";
import type { createApplicationRuntimeController } from "../controllers/applicationRuntimeController";

/** buildAppViewBindings 的组合依赖:全部来自 App.tsx 的既有局部绑定,仅做纯转发。 */
export interface AppViewBindingsDeps {
  appState: ReturnType<typeof useAppState>;
  navigationController: ReturnType<typeof useAppNavigationController>;
  derivedState: ReturnType<typeof useAppDerivedState>;
  sceneEditor: ReturnType<typeof createSceneEditorController>;
  scenePersistence: ReturnType<typeof createScenePersistenceController>;
  publicationArtifacts: ReturnType<typeof useScenePublicationArtifacts>;
  applicationRuntime: ReturnType<typeof createApplicationRuntimeController>;
  applicationRecovery: ReturnType<typeof useApplicationRecovery>;
  sceneHistoryState: ReturnType<typeof useSceneHistoryState>;
  historyActions: ReturnType<typeof useSceneHistoryActions>;
  sceneAuthoring: EditorPrimitiveDeleteAuthoring | undefined;
  playMode: ReturnType<typeof useScenePlayMode>;
  restrictedPlayRef: MutableRefObject<RestrictedPlayConsumer | undefined>;
}

/** 组装 AppRootView 的全部视图绑定(App.tsx 的 viewBindings 字面量,纯移动)。 */
export function buildAppViewBindings(deps: AppViewBindingsDeps): AppViewBindings {
  return {
    managerDirectory: deps.navigationController.managerDirectory,
    state: deps.appState,
    derived: deps.derivedState,
    sceneEditor: deps.sceneEditor,
    scenePersistence: deps.scenePersistence,
    publicationArtifacts: deps.publicationArtifacts,
    applicationRuntime: deps.applicationRuntime,
    actions: {
      navigate: deps.navigationController.navigate,
      openDataCenter: deps.navigationController.openDataCenter,
      closeDataCenter: deps.navigationController.closeDataCenter,
      openDocs: deps.navigationController.openDocs,
      replaceDashboardView: deps.navigationController.replaceDashboardView,
      changeRendererBackend: deps.navigationController.changeRendererBackend,
      switchProjectById: deps.navigationController.switchProjectById,
      openProjectDialog: deps.navigationController.openProjectDialog,
      submitProjectDialog: deps.navigationController.submitProjectDialog,
      deleteCurrentProject: deps.navigationController.deleteCurrentProject,
      refreshProject: deps.navigationController.refreshProject,
    },
    applicationRecovery: deps.applicationRecovery,
    recovery: {
      draft: deps.sceneHistoryState.recoveryDraft,
      busy: deps.sceneHistoryState.recoveryBusy,
      restore: deps.historyActions.restoreRecoveryDraft, defer: deps.historyActions.deferRecoveryDraft, discard: deps.historyActions.discardRecoveryDraft,
      export: () => { if (deps.sceneHistoryState.recoveryDraft) downloadWorkspaceRecoveryDraft(deps.sceneHistoryState.recoveryDraft); },
    },
    sceneHistory: {
      ...deps.sceneHistoryState.sceneHistoryRef.current.getState(),
      flush: deps.sceneHistoryState.flushSceneHistoryEdit, undo: deps.historyActions.undoSceneEdit, redo: deps.historyActions.redoSceneEdit,
    },
    sceneAuthoring: deps.sceneAuthoring,
    playMode: {
      active: deps.playMode.active,
      enter: () => {
        if (deps.appState.route.view !== "studio" || deps.appState.busy || deps.appState.rendererSwitching || deps.appState.sceneBehaviorOpen || deps.appState.sceneBehaviorActive || !deps.appState.activeScene || !deps.appState.project) return;
        if (deps.appState.sceneNameCommitRef.current || deps.appState.sceneName !== deps.appState.activeScene.name) {
          deps.appState.showError(new Error("场景名称尚未保存，请待名称提交后再播放"));
          return;
        }
        // P1-2（2026-10-06 对抗测试第二轮）：撤销/重做恢复在途时画布是中间态（清栈风暴
        // 后立即播放即整页错误边界的复现窗口）——播放入口必须明确拒绝并提示，而非在
        // 中间态上建 Play 会话。控制器层同口径守卫（isHistorySettled）兜底全部入口。
        if (deps.sceneHistoryState.sceneHistoryApplyingRef.current) {
          deps.appState.showError(new Error("撤销/重做恢复尚未完成，请待场景恢复结束后再进入播放"));
          return;
        }
        if (deps.appState.animationPlaying || deps.appState.engine?.getPhysicsState().playing) {
          deps.appState.showError(new Error("动画或物理正在运行，请先暂停再进入播放模式"));
          return;
        }
        if (deps.appState.engine?.getAuthorRendererBackend() === "webgpu") {
          deps.appState.showError(new Error("当前 WebGPU 渲染器暂不支持安全的 Play 快照恢复；请先切换 WebGL"));
          return;
        }
        if (deps.sceneHistoryState.sceneEditTransactionRef.current) {
          deps.appState.showError(new Error("场景编辑事务尚未完成，请等待当前操作完成后再播放"));
          return;
        }
        // S2b：会话临时修改计数清零（进入前的散记属于作者域，不计入本次播放）。
        deps.sceneHistoryState.playAbsorbedEditsRef.current = 0;
        let restricted: RestrictedPlayConsumer;
        try {
          // S2d:本会话轨迹仓重置后收纳 T31 快照(onTrace),退出后仍可审阅(审计器语义)。
          playTraceStore.resetPlayTrace(new Date().toISOString());
          restricted = createRestrictedPlayConsumer({
            scripts: deps.appState.engine?.getInteractionScripts() ?? [],
            host: { engine: deps.appState.engine!, sceneId: deps.appState.activeScene.id },
            onTrace: (scriptId, entries) => playTraceStore.recordPlayTrace(scriptId, entries),
            onError: deps.appState.showError,
          });
          restricted.start();
        } catch (error) {
          deps.appState.showError(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (deps.appState.engine) {
          deps.appState.engine.onRestrictedInteraction = (trigger, target, detail) => restricted.dispatchInteraction(trigger, target, detail);
          deps.appState.engine.onRestrictedPlayFrame = (deltaMs) => restricted.advance(deltaMs);
        }
        const result = deps.playMode.enterPlay();
        if (result.ok) {
          deps.restrictedPlayRef.current = restricted;
          deps.appState.engine?.setContinuousRender("restricted-play", true);
          // S2b：未保存的脚本草稿不参与本次播放（热重载语义），必须如实呈现。
          deps.appState.setMessage(formatPlayEntryNotice(Boolean(deps.appState.pendingBehaviorDraftRef.current)));
        } else {
          if (deps.appState.engine) {
            deps.appState.engine.onRestrictedInteraction = undefined;
            deps.appState.engine.onRestrictedPlayFrame = undefined;
          }
          void restricted.stop();
          if (result.reason === "scene-not-ready") deps.appState.showError(new Error("场景尚未完整载入，请稍后重试进入播放"));
          else if (result.reason === "history-restore-in-flight") deps.appState.showError(new Error("撤销/重做恢复尚未完成，请待场景恢复结束后再进入播放"));
          else if (result.reason === "engine-missing") deps.appState.showError(new Error("三维引擎尚未就绪，请稍后重试进入播放"));
        }
      },
      exit: async () => {
        const restricted = deps.restrictedPlayRef.current;
        if (deps.appState.engine) {
          deps.appState.engine.onRestrictedInteraction = undefined;
          deps.appState.engine.onRestrictedPlayFrame = undefined;
          deps.appState.engine.setContinuousRender("restricted-play", false);
        }
        await restricted?.stop();
        const result = await deps.playMode.exitPlay();
        if (result.ok) {
          deps.restrictedPlayRef.current = undefined;
          deps.appState.setError(undefined);
          // S2b：播放期间被吸收的临时修改随整体恢复丢弃，数量如实汇报。
          deps.appState.setMessage(formatPlayExitNotice(deps.sceneHistoryState.playAbsorbedEditsRef.current));
        } else {
          deps.appState.showError(new Error("播放已停止受限脚本，但场景恢复未完成；请再次点击退出播放重试。"));
        }
      },
    },
  };
}
