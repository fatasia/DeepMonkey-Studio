import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { SceneAuthoringHistory } from "../studio/sceneAuthoringHistory";
import type { WorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import { runSceneHistoryTransaction } from "../studio/sceneHistoryTransaction";

/**
 * T27 全局撤销/重做统一事务：把一组原子命令（如"替换素材+恢复绑定+更新变换"）合并为一个撤销单元。
 * 撤销一个事务 = 整体回滚到事务前快照；提交 = 事务窗口内全部域的变更只落一条撤销条目。
 */
export interface SceneEditTransaction {
  readonly label: string;
  /** 事务开始前已落栈的场景快照；失败回滚即恢复到它。 */
  readonly before: SceneSnapshot | undefined;
  /** 事务是否仍开启；commit/rollback 后为 false，过期句柄上的重复提交是空操作。 */
  readonly active: boolean;
  /** 提交：事务窗口内的全部变更（模型/外观/动画/物理等全域）合并为一条撤销条目。 */
  commit(label?: string): void;
  /** 放弃：返回事务前快照交由调用方应用（与撤销同路径）；窗口关闭且不产生任何撤销条目。 */
  rollback(): SceneSnapshot | undefined;
}

/** flush 的可调用句柄；beginTransaction 让多步异步序列获得显式事务边界（零接线成本随 flush 传递）。 */
export interface SceneEditHistoryFlush {
  (label?: string): void;
  beginTransaction(label: string): SceneEditTransaction;
}

/** 事务工厂依赖：落栈收束、事实快照捕获与撤销栈记录全部显式注入，hook 与测试夹具共用同一实现。 */
export interface SceneEditTransactionHost {
  /** 收束连续编辑（防抖窗口内的待记内容立即落栈），保证事务前状态已入栈。 */
  flush(): void;
  /** 捕获当前事实快照（事务前状态与提交内容都从这里读取）。 */
  capture(): SceneSnapshot | undefined;
  /** 向唯一撤销栈记录一条条目（fingerprint 去重由栈负责）。 */
  record(snapshot: SceneSnapshot, label: string): void;
}

/** 开启事务：不嵌套，重入返回当前开启的事务；同一时刻只允许一个开启事务。 */
export function createSceneEditTransaction(
  openRef: { current: SceneEditTransaction | undefined },
  host: SceneEditTransactionHost,
  label: string,
): SceneEditTransaction {
  const existing = openRef.current;
  if (existing) return existing;
  host.flush();
  const transaction: SceneEditTransaction = {
    label,
    before: host.capture(),
    get active() {
      return openRef.current === transaction;
    },
    commit(override?: string) {
      if (openRef.current !== transaction) return;
      openRef.current = undefined;
      const snapshot = host.capture();
      if (snapshot) host.record(snapshot, override ?? label);
    },
    rollback() {
      if (openRef.current !== transaction) return undefined;
      openRef.current = undefined;
      return transaction.before ? structuredClone(transaction.before) : undefined;
    },
  };
  openRef.current = transaction;
  return transaction;
}

interface SceneHistoryStateOptions {
  activeScene: SceneSnapshot | undefined;
  routeView: string;
  sceneBehaviorActive: boolean;
  animationPlaying: boolean;
  /**
   * T30 受限 Play 模式：播放态的一切编辑记账吸收——播放期间产生的状态是临时态，
   * 不进撤销栈；退出 Play 经 applyScene 按进入前快照整体恢复，栈保持进入前原样。
   */
  playModeActive?: boolean;
}

/** 管理三维编辑历史与恢复草稿所需的本地事务状态。 */
export function useSceneHistoryState({ activeScene, routeView, sceneBehaviorActive, animationPlaying, playModeActive = false }: SceneHistoryStateOptions) {
  const [recoveryDraft, setRecoveryDraft] = useState<WorkspaceRecoveryDraft>();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const recoveryDecisionRef = useRef<string | undefined>(undefined);
  const sceneHistoryRef = useRef(new SceneAuthoringHistory());
  const sceneSnapshotFactoryRef = useRef<(() => SceneSnapshot | undefined) | undefined>(undefined);
  const sceneHistoryTimerRef = useRef<{ timer: number; label: string } | undefined>(undefined);
  const sceneHistoryApplyingRef = useRef(false);
  const firstSavedSceneIdRef = useRef<string | undefined>(undefined);
  const sceneHistoryRecordRef = useRef<(label: string) => void>(() => undefined);
  const sceneEditTransactionRef = useRef<SceneEditTransaction | undefined>(undefined);
  const [sceneHistoryRevision, setSceneHistoryRevision] = useState(0);
  // S2b：Play 会话内被门禁吸收的记账次数（防抖散记 + 离散命令）＝播放中临时修改的
  // 可呈现计数。会话开始由 App 显式清零，退出时读取后写入丢弃汇报；不影响任何记账裁决。
  const playAbsorbedEditsRef = useRef(0);

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
    // T30：Play 态的一切记账吸收（含待落的防抖编辑），播放产物不进撤销栈。
    if (playModeActive || sceneHistoryApplyingRef.current) return;
    // T27：事务窗口内的散记全部吸收，由 commit 统一落一条。
    if (sceneEditTransactionRef.current) return;
    const snapshot = sceneSnapshotFactoryRef.current?.();
    if (snapshot) sceneHistoryRef.current.record(snapshot, label ?? pending?.label ?? "编辑三维场景");
  }

  function scheduleSceneHistoryEdit(label: string): void {
    if (routeView !== "studio" || sceneHistoryApplyingRef.current || sceneBehaviorActive || animationPlaying) return;
    // S2b：Play 门禁吸收的防抖散记计入临时修改计数（记账裁决不变）。
    if (playModeActive) {
      playAbsorbedEditsRef.current += 1;
      return;
    }
    const pending = sceneHistoryTimerRef.current;
    if (pending) window.clearTimeout(pending.timer);
    sceneHistoryTimerRef.current = undefined;
    // T27：事务窗口内的连续编辑同样吸收，防止异步序列中途落出半程快照。
    if (sceneEditTransactionRef.current) return;
    const timer = window.setTimeout(() => flushSceneHistoryEdit(label), 220);
    sceneHistoryTimerRef.current = { timer, label };
  }

  sceneHistoryRecordRef.current = scheduleSceneHistoryEdit;

  function runSceneHistoryEdit(change: () => void): void {
    // T30：Play 态下离散命令照常生效于画布（临时态），只是不产生撤销条目。
    if (routeView !== "studio" || sceneHistoryApplyingRef.current || sceneBehaviorActive || animationPlaying) {
      change();
      return;
    }
    // S2b：Play 门禁吸收的离散命令计入临时修改计数（记账裁决不变）。
    if (playModeActive) {
      playAbsorbedEditsRef.current += 1;
      change();
      return;
    }
    runSceneHistoryTransaction(change, flushSceneHistoryEdit, flushSync);
  }

  function beginSceneEditTransaction(label: string): SceneEditTransaction {
    return createSceneEditTransaction(sceneEditTransactionRef, {
      flush: () => flushSceneHistoryEdit(),
      capture: () => sceneSnapshotFactoryRef.current?.(),
      // T30：Play 态提交不落条目——播放中的状态是临时态，撤销栈保持进入前原样。
      record: (snapshot, txLabel) => { if (!playModeActive) sceneHistoryRef.current.record(snapshot, txLabel); },
    }, label);
  }

  function adoptFirstSavedScene(saved: SceneSnapshot): void {
    flushSceneHistoryEdit();
    sceneHistoryRef.current.adoptSceneIdentity(saved);
    firstSavedSceneIdRef.current = saved.id;
  }

  // beginTransaction 挂在 flush 函数上随既有 bindings.sceneHistory.flush 接线传递，App 层零改动即达消费方。
  const sceneEditFlush = flushSceneHistoryEdit as SceneEditHistoryFlush;
  sceneEditFlush.beginTransaction = beginSceneEditTransaction;

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
    playAbsorbedEditsRef,
    sceneEditTransactionRef,
    sceneHistoryRevision,
    flushSceneHistoryEdit: sceneEditFlush,
    runSceneHistoryEdit,
    beginSceneEditTransaction,
    adoptFirstSavedScene,
  };
}
