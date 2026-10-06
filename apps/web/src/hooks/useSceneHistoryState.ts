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

/** flush 的可调用句柄；beginTransaction 让多步异步序列获得显式事务边界（零接线成本随 flush 传递）。
 * historyEntry=true 标记撤销/重做的入口冲刷：恢复尾部吸收（armSceneHistoryTailAbsorb）只作用于它。 */
export interface SceneEditHistoryFlush {
  (label?: string, historyEntry?: boolean): void;
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
  // F4（2026-10-05 对抗测试）：载入静默期。applyScene 执行至挂载稳定的窗口内，模型挂载、
  // 灯光/环境恢复触发的引擎回调不得落撤销栈，否则打开场景即预置"幽灵编辑"（首次撤销吞刀）。
  // until 是 performance.now() 时间戳：Infinity=静默中；settle 后时间戳自然过期，无需定时器。
  const sceneLoadSilenceUntilRef = useRef(0);
  const isSceneLoadSilent = () => performance.now() < sceneLoadSilenceUntilRef.current;
  // 撤销/重做恢复尾部吸收（门10 undo/redo 竞态）：恢复完成（acceptRestoredScene）后，
  // 引擎侧收敛（异步就绪晚于 accept）与栈 current 存在差异；撤销/重做的入口冲刷若把该
  // 差异 record 落栈，会以"编辑三维场景"清空重做栈，令紧随的重做变静默空操作。
  // armed 时【且无待落用户编辑】的入口冲刷改走 history.absorb 对齐 current；携带待落
  // 编辑（防抖计时器在飞=用户刚编辑）的入口冲刷与所有命令路径照常落栈并解除武装。
  const sceneHistoryTailAbsorbRef = useRef(false);
  /** 撤销/重做恢复成功后武装尾部吸收；由 applySceneHistorySnapshot 调用。 */
  function armSceneHistoryTailAbsorb(): void {
    sceneHistoryTailAbsorbRef.current = true;
  }
  /** 载入开始：无限期静默（必须由 endSceneLoadSilence 解除，漏解除等于永久禁记，测试会暴露）。 */
  function beginSceneLoadSilence(): void { sceneLoadSilenceUntilRef.current = Number.POSITIVE_INFINITY; }
  /** 载入结束：settleMs>0 时再静默一个窗口，吸收挂载尾巴的防抖散记；0=立即恢复记账。 */
  function endSceneLoadSilence(settleMs = 0): void { sceneLoadSilenceUntilRef.current = performance.now() + settleMs; }
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

  function flushSceneHistoryEdit(label?: string, historyEntry = false): void {
    const pending = sceneHistoryTimerRef.current;
    if (pending) window.clearTimeout(pending.timer);
    sceneHistoryTimerRef.current = undefined;
    // T30：Play 态的一切记账吸收（含待落的防抖编辑），播放产物不进撤销栈。
    if (playModeActive || sceneHistoryApplyingRef.current) return;
    // F4：载入静默期的待落编辑直接丢弃——载入期挂载触发不构成用户编辑。
    if (isSceneLoadSilent()) return;
    // T27：事务窗口内的散记全部吸收，由 commit 统一落一条。
    if (sceneEditTransactionRef.current) return;
    const snapshot = sceneSnapshotFactoryRef.current?.();
    if (!snapshot) return;
    // 恢复尾部吸收只处理"无待落用户编辑"的入口冲刷:此时引擎快照与栈 current 的差异
    // 是恢复自身的收敛(异步就绪晚于 acceptRestoredScene),record 会以"编辑三维场景"
    // 清空重做栈,令紧随的重做变静默空操作(门10 undo/redo 竞态根因)→ absorb 对齐。
    // 入口冲刷携带待落编辑(防抖计时器在飞=用户刚编辑,如删除后立即撤销)时,必须
    // 正常落栈——那是用户编辑,吞掉会让撤销弹错条目;落栈即解除武装。
    if (sceneHistoryTailAbsorbRef.current) {
      if (historyEntry && !pending) {
        const absorbed = sceneHistoryRef.current.absorb(snapshot);
        console.debug(`[scene-history] tail-absorb(entry-flush) absorbed=${absorbed}`);
        if (!absorbed) sceneHistoryTailAbsorbRef.current = false;
        return;
      }
      sceneHistoryTailAbsorbRef.current = false;
    }
    const recorded = sceneHistoryRef.current.record(snapshot, label ?? pending?.label ?? "编辑三维场景");
    console.debug(`[scene-history] flush-record label=${label ?? pending?.label ?? "编辑三维场景"} recorded=${recorded}`);
  }

  function scheduleSceneHistoryEdit(label: string): void {
    if (routeView !== "studio" || sceneHistoryApplyingRef.current || sceneBehaviorActive || animationPlaying) return;
    // F4：载入静默期吸收 schedule 入口，防止恢复序列的引擎回调开出防抖计时器。
    if (isSceneLoadSilent()) return;
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
    beginSceneLoadSilence,
    endSceneLoadSilence,
    armSceneHistoryTailAbsorb,
    flushSceneHistoryEdit: sceneEditFlush,
    runSceneHistoryEdit,
    beginSceneEditTransaction,
    adoptFirstSavedScene,
  };
}
