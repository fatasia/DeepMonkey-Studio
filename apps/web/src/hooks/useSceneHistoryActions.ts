import { useEffect } from "react";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createWorkspaceRecoveryDraft, deleteWorkspaceRecoveryDraft, writeWorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import type { createScenePersistenceController } from "../controllers/scenePersistenceController";
import type { AppState } from "./useAppState";
import type { useSceneHistoryState } from "./useSceneHistoryState";
import { workspaceRecoveryDecisionKey } from "../studio/workspaceRecoveryDecision";

type PersistenceController = ReturnType<typeof createScenePersistenceController>;
type SceneHistoryState = ReturnType<typeof useSceneHistoryState>;

interface SceneHistoryActionsOptions {
  state: AppState;
  history: SceneHistoryState;
  applyScene: PersistenceController["applyScene"];
}

/** 提供撤销、重做和恢复草稿动作，并保证失败时历史指针与画布一致。 */
export function useSceneHistoryActions({ state, history, applyScene }: SceneHistoryActionsOptions) {
  const { activeApplication, activeScene, busy, engine, lastAutoSavedSceneRevisionRef, project, revision, route, setAutoSaveEnabled, setMessage, showError } = state;
  const {
    recoveryDecisionRef,
    recoveryDraft,
    sceneHistoryApplyingRef,
    sceneHistoryRef,
    sceneHistoryRevision,
    sceneSnapshotFactoryRef,
    setRecoveryBusy,
    setRecoveryDraft,
    flushSceneHistoryEdit,
  } = history;

  async function applySceneHistorySnapshot(snapshot: SceneSnapshot, action: "undo" | "redo"): Promise<void> {
    if (!project) return;
    sceneHistoryApplyingRef.current = true;
    try {
      await applyScene(snapshot, false, project, false);
      setMessage(action === "undo" ? "已撤销三维编辑" : "已重做三维编辑");
    } catch (reason) {
      // 恢复失败时把历史指针退回原位，避免按钮状态与画布内容脱节。
      if (action === "undo") sceneHistoryRef.current.redo();
      else sceneHistoryRef.current.undo();
      showError(reason);
    } finally {
      sceneHistoryApplyingRef.current = false;
    }
  }

  async function undoSceneEdit(): Promise<void> {
    flushSceneHistoryEdit();
    const snapshot = sceneHistoryRef.current.undo();
    if (snapshot) await applySceneHistorySnapshot(snapshot, "undo");
  }

  async function redoSceneEdit(): Promise<void> {
    const snapshot = sceneHistoryRef.current.redo();
    if (snapshot) await applySceneHistorySnapshot(snapshot, "redo");
  }

  useEffect(() => {
    if (route.view !== "studio" || busy) return;
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], .monaco-editor")) return;
      const modifier = event.ctrlKey || event.metaKey;
      const undo = modifier && event.key.toLowerCase() === "z" && !event.shiftKey;
      const redo = modifier && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey));
      if (!undo && !redo) return;
      event.preventDefault();
      if (undo) void undoSceneEdit();
      else void redoSceneEdit();
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [route.view, project?.id, activeScene?.id, sceneHistoryRevision, busy]);

  useEffect(() => {
    if (route.view !== "studio" || !project || !activeScene || !engine || recoveryDraft || revision <= lastAutoSavedSceneRevisionRef.current) return;
    const timer = window.setTimeout(() => {
      const snapshot = sceneSnapshotFactoryRef.current?.();
      if (!snapshot) return;
      const applicationDraft = activeApplication?.metadata.id === route.applicationId ? activeApplication : undefined;
      const draft = createWorkspaceRecoveryDraft(project.id, applicationDraft, snapshot);
      // This live editor authored the copy; undo/redo is not a crash-recovery entry.
      // The ref resets on a real reload, so reload recovery remains available.
      recoveryDecisionRef.current = workspaceRecoveryDecisionKey(draft);
      void writeWorkspaceRecoveryDraft(draft);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [route.view, route.applicationId, project?.id, activeScene?.id, activeApplication?.metadata.revision, engine, revision, recoveryDraft]);

  async function restoreRecoveryDraft(): Promise<void> {
    if (!recoveryDraft || !project) return;
    setRecoveryBusy(true);
    try {
      // 使用当前服务器应用 revision，只恢复场景内容，避免旧应用文档重新引入版本冲突。
      recoveryDecisionRef.current = workspaceRecoveryDecisionKey(recoveryDraft);
      await applyScene(recoveryDraft.scene, false, project, false);
      // 恢复动作本身会推进一次场景 revision；将该 revision 视为已处理，避免恢复后立刻重新弹出同一副本。
      lastAutoSavedSceneRevisionRef.current = revision + 1;
      await deleteWorkspaceRecoveryDraft(recoveryDraft.projectId, recoveryDraft.applicationId, recoveryDraft.sceneId);
      sceneHistoryRef.current.record(recoveryDraft.scene, "恢复本地修改");
      setAutoSaveEnabled(false);
      setRecoveryDraft(undefined);
      setMessage("已恢复本地修改；自动保存已暂停，请检查后手动保存");
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function discardRecoveryDraft(): Promise<void> {
    if (!recoveryDraft) return;
    setRecoveryBusy(true);
    try {
      recoveryDecisionRef.current = workspaceRecoveryDecisionKey(recoveryDraft);
      await deleteWorkspaceRecoveryDraft(recoveryDraft.projectId, recoveryDraft.applicationId, recoveryDraft.sceneId);
      // 丢弃不会改变场景内容，但需要阻止当前 revision 的保护副本被恢复写入 effect 立即重建。
      lastAutoSavedSceneRevisionRef.current = revision;
      setRecoveryDraft(undefined);
      setMessage("本地恢复副本已丢弃，服务器版本未受影响");
    } finally {
      setRecoveryBusy(false);
    }
  }

  function deferRecoveryDraft(): void {
    if (!recoveryDraft) return;
    recoveryDecisionRef.current = workspaceRecoveryDecisionKey(recoveryDraft);
    setRecoveryDraft(undefined);
    setMessage("已使用服务器版本打开；本地恢复副本仍保留，可稍后处理");
  }

  return { undoSceneEdit, redoSceneEdit, restoreRecoveryDraft, deferRecoveryDraft, discardRecoveryDraft };
}
