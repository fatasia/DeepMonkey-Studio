import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { SceneAuthoringHistory } from "../studio/sceneAuthoringHistory";
import type { WorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import { runSceneHistoryTransaction } from "../studio/sceneHistoryTransaction";

interface SceneHistoryStateOptions {
  activeScene: SceneSnapshot | undefined;
  routeView: string;
  sceneBehaviorActive: boolean;
  animationPlaying: boolean;
}

/** 管理三维编辑历史与恢复草稿所需的本地事务状态。 */
export function useSceneHistoryState({ activeScene, routeView, sceneBehaviorActive, animationPlaying }: SceneHistoryStateOptions) {
  const [recoveryDraft, setRecoveryDraft] = useState<WorkspaceRecoveryDraft>();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const recoveryDecisionRef = useRef<string | undefined>(undefined);
  const sceneHistoryRef = useRef(new SceneAuthoringHistory());
  const sceneSnapshotFactoryRef = useRef<(() => SceneSnapshot | undefined) | undefined>(undefined);
  const sceneHistoryTimerRef = useRef<{ timer: number; label: string } | undefined>(undefined);
  const sceneHistoryApplyingRef = useRef(false);
  const firstSavedSceneIdRef = useRef<string | undefined>(undefined);
  const sceneHistoryRecordRef = useRef<(label: string) => void>(() => undefined);
  const [sceneHistoryRevision, setSceneHistoryRevision] = useState(0);

  useEffect(() => sceneHistoryRef.current.subscribe(() => setSceneHistoryRevision((value) => value + 1)), []);

  useEffect(() => {
    const pending = sceneHistoryTimerRef.current;
    if (pending) window.clearTimeout(pending.timer);
    sceneHistoryTimerRef.current = undefined;
    const firstSavedId = firstSavedSceneIdRef.current;
    firstSavedSceneIdRef.current = undefined;
    if (activeScene && firstSavedId === activeScene.id) return;
    sceneHistoryRef.current.reset(activeScene);
  }, [activeScene?.id]);

  useEffect(() => {
    if (routeView === "studio") return;
    const pending = sceneHistoryTimerRef.current;
    if (pending) window.clearTimeout(pending.timer);
    sceneHistoryTimerRef.current = undefined;
  }, [routeView]);

  function flushSceneHistoryEdit(label?: string): void {
    const pending = sceneHistoryTimerRef.current;
    if (pending) window.clearTimeout(pending.timer);
    sceneHistoryTimerRef.current = undefined;
    const snapshot = sceneSnapshotFactoryRef.current?.();
    if (snapshot) sceneHistoryRef.current.record(snapshot, label ?? pending?.label ?? "编辑三维场景");
  }

  function scheduleSceneHistoryEdit(label: string): void {
    if (routeView !== "studio" || sceneHistoryApplyingRef.current || sceneBehaviorActive || animationPlaying) return;
    const pending = sceneHistoryTimerRef.current;
    if (pending) window.clearTimeout(pending.timer);
    const timer = window.setTimeout(() => flushSceneHistoryEdit(label), 220);
    sceneHistoryTimerRef.current = { timer, label };
  }

  sceneHistoryRecordRef.current = scheduleSceneHistoryEdit;

  function runSceneHistoryEdit(change: () => void): void {
    if (routeView !== "studio" || sceneHistoryApplyingRef.current || sceneBehaviorActive || animationPlaying) { change(); return; }
    runSceneHistoryTransaction(change, flushSceneHistoryEdit, flushSync);
  }

  function adoptFirstSavedScene(saved: SceneSnapshot): void {
    flushSceneHistoryEdit();
    sceneHistoryRef.current.adoptSceneIdentity(saved);
    firstSavedSceneIdRef.current = saved.id;
  }

  return {
    recoveryDraft,
    setRecoveryDraft,
    recoveryBusy,
    setRecoveryBusy,
    recoveryDecisionRef,
    sceneHistoryRef,
    sceneSnapshotFactoryRef,
    sceneHistoryApplyingRef,
    sceneHistoryRecordRef,
    sceneHistoryRevision,
    flushSceneHistoryEdit,
    runSceneHistoryEdit,
    adoptFirstSavedScene,
  };
}
