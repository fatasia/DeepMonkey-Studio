import { useRef, useState } from "react";
import type { ScenePhysicsState, SceneSnapshot } from "@bim-studio/contracts";

/**
 * T30 受限 Play 模式（切片一：状态机 + 快照隔离 + 整体恢复）。
 *
 * 语义对标 Unity Play Mode 的工程隔离，但按 Deep 的快照撤销栈架构实现：
 * - 进入 Play：先 flush 未提交编辑（落撤销栈），再经与撤销栈同源的快照工厂捕获"进入前快照"，
 *   然后启动物理/动画驱动。进入本身不产生撤销条目（快照与进入前事实相同，指纹去重）。
 * - 播放中：物理位移/动画改写的实例状态是临时态——`useSceneHistoryState` 的 `playModeActive`
 *   门禁吸收一切记账，不进撤销栈；驱动不触发 revision，故不触发持久化自动保存。
 * - 退出 Play：暂停驱动后按进入前快照走 `applyScene` 整体恢复（模型位姿/图元/物理/动画/
 *   外观/环境/绑定等全部作者域），再按进入前播放头回 seek。播放全程零撤销条目。
 */

/** Play 模式需要的引擎面：全部是既有公开接口（B3 物理开关、T19 动画播放链），不新增引擎能力。 */
export interface ScenePlayModeEngine {
  getPhysicsState(): ScenePhysicsState;
  setPhysicsState(state: ScenePhysicsState): void;
  playSceneAnimation(): void;
  pauseSceneAnimation(): void;
  seekSceneAnimation(time: number): void;
}

/** 依赖显式注入：快照捕获、记账收束、整体恢复与播放头读取全部来自既有生产链路。 */
export interface ScenePlayModeHost {
  /** 引擎句柄；未挂载（undefined）时进入被拒绝，与持久化层 engine?: ViewerEngine 同口径。 */
  engine: ScenePlayModeEngine | undefined;
  /** 画布事实快照，与撤销栈同一工厂（sceneSnapshotFactoryRef → makeSceneSnapshot）；undefined = 场景未就绪。 */
  capture(): SceneSnapshot | undefined;
  /** 收束未提交编辑（防抖窗口落撤销栈），保证"进入前快照 = 已提交事实"。 */
  flush(): void;
  /** 整体恢复路径：与撤销/恢复草稿同一条 persistence.applyScene。 */
  applyScene(scene: SceneSnapshot): Promise<void>;
  /** 播放头读取：与 sceneAnimationCommands 同走 animation 瞬时通道；通道未挂载时回退 0。 */
  readAnimationPlayhead(): number;
  /** 异常如实上报（生产 = showError）；恢复失败必须可见，不得静默吞掉。 */
  reportError(error: unknown): void;
}

export type ScenePlayModeResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "already-playing" // 双层嵌套 Play 拒绝
        | "not-playing"
        | "engine-missing"
        | "scene-not-ready" // 快照工厂拒绝（渲染器恢复中/模型未载完）
        | "engine-lost" // 退出时引擎已被替换或释放
        | "restore-failed"
        | "start-failed";
    };

/** Play 会话状态：active 供 UI 与记账门禁消费；enteredAt 为 ISO 进入时刻。 */
export interface ScenePlayModeState {
  readonly active: boolean;
  readonly enteredAt: string | undefined;
}

interface ScenePlaySession {
  /** 进入前快照（深拷贝；播放中的任何编辑不会污染它）。 */
  readonly snapshot: SceneSnapshot;
  /** 进入前播放头（秒）；退出恢复后按它回 seek，动画域逐帧恢复到进入前那一格。 */
  readonly playhead: number;
}

const IDLE_STATE: ScenePlayModeState = { active: false, enteredAt: undefined };

/**
 * S2b 进入 Play 的草稿语义文案。未保存的脚本草稿不参与本次播放——Play 会话按已保存
 * 版本的交互脚本运行（热重载语义 §2.3：Play 中编辑不改变运行中会话，退出再进装载新图），
 * 该事实必须如实呈现，不得让用户误以为草稿已生效。
 */
export function formatPlayEntryNotice(hasPendingBehaviorDraft: boolean): string {
  return hasPendingBehaviorDraft
    ? "已进入播放模式；修改仅在本次播放期间生效；未保存的脚本草稿未参与本次播放，按已保存版本运行"
    : "已进入播放模式；修改仅在本次播放期间生效";
}

/**
 * S2b 退出汇报。播放期间被门禁吸收的每一次记账(用户编辑与引擎/物理驱动的临时
 * 状态改写)在整体恢复时全部丢弃(撤销栈与持久化都不留痕),数量大于零时必须如实
 * 汇报丢弃事实。措辞用「状态变更」而非「修改」:计数包含模拟驱动的改写,不暗示
 * 全部出自用户之手。
 */
export function formatPlayExitNotice(discardedEdits: number): string {
  return discardedEdits > 0
    ? `已退出播放模式；播放期间的 ${discardedEdits} 项临时状态变更已丢弃，场景已恢复为进入前状态`
    : "已退出播放模式，场景恢复为进入前状态";
}

export interface ScenePlayModeController {
  readonly active: boolean;
  enterPlay(): ScenePlayModeResult;
  exitPlay(): Promise<ScenePlayModeResult>;
}

/**
 * Play 生命周期状态机。与 React 解耦以便脱离渲染器单测（hook 只是薄包装）；
 * 每次调用经 getHost 读取最新引擎/捕获/恢复闭包，与 App 每渲染重建绑定的语义一致。
 */
export function createScenePlayModeController(
  getHost: () => ScenePlayModeHost,
  notify: (state: ScenePlayModeState) => void,
): ScenePlayModeController {
  let active = false;
  let enteredAt: string | undefined;
  let session: ScenePlaySession | undefined;
  let exiting = false;
  let sessionEngine: ScenePlayModeEngine | undefined;

  function emit(): void {
    notify(active ? { active: true, enteredAt: enteredAt } : IDLE_STATE);
  }

  function startRuntimeDrivers(engine: ScenePlayModeEngine): void {
    const physics = engine.getPhysicsState();
    // 物理驱动尊重作者 enabled 开关；playing 只是运行驱动位（引擎侧还会按 enabled 再收敛一次）。
    if (physics.enabled && !physics.playing) engine.setPhysicsState({ ...physics, playing: true });
    // 动画驱动：无关键帧时引擎内部空操作；已播放时重复调用不会二次派发 animationStart。
    engine.playSceneAnimation();
  }

  function stopRuntimeDrivers(engine: ScenePlayModeEngine): void {
    engine.pauseSceneAnimation();
    const physics = engine.getPhysicsState();
    if (physics.enabled && physics.playing) engine.setPhysicsState({ ...physics, playing: false });
  }

  function enterPlay(): ScenePlayModeResult {
    if (active) return { ok: false, reason: "already-playing" };
    const host = getHost();
    // 先收束未提交编辑：防抖窗口内的编辑先落撤销栈，再捕获进入前快照。
    host.flush();
    if (!host.engine) return { ok: false, reason: "engine-missing" };
    const snapshot = host.capture();
    if (!snapshot) return { ok: false, reason: "scene-not-ready" };
    session = { snapshot: structuredClone(snapshot), playhead: host.readAnimationPlayhead() };
    sessionEngine = host.engine;
    enteredAt = new Date().toISOString();
    active = true;
    emit();
    try {
      startRuntimeDrivers(host.engine);
    } catch (reason) {
      try { stopRuntimeDrivers(host.engine); } catch { /* The engine can be lost during startup. */ }
      active = false;
      enteredAt = undefined;
      session = undefined;
      sessionEngine = undefined;
      emit();
      host.reportError(reason);
      return { ok: false, reason: "start-failed" };
    }
    return { ok: true };
  }

  async function exitPlay(): Promise<ScenePlayModeResult> {
    if (!active || !session) return { ok: false, reason: "not-playing" };
    if (exiting) return { ok: false, reason: "already-playing" };
    const host = getHost();
    const engine = host.engine;
    const { snapshot, playhead } = session;
    if (!engine || engine !== sessionEngine) {
      // 引擎在播放期间被替换/释放：无法整体恢复，保持播放态并如实上报（快照仍在，可重试）。
      host.reportError(new Error("引擎已卸载，无法退出播放并恢复场景；请重新载入场景"));
      return { ok: false, reason: "engine-lost" };
    }
    // 先停驱动再恢复：避免恢复期间动画帧/物理步进继续改写对象。
    exiting = true;
    try {
      stopRuntimeDrivers(engine);
      // 传快照深拷贝：applyScene 会接管该对象（setActiveScene(scene)），不得与留存会话共享引用。
      await host.applyScene(structuredClone(snapshot));
      if (playhead > 0) engine.seekSceneAnimation(playhead);
    } catch (reason) {
      // 恢复失败保持播放态：会话快照保留可重试。
      host.reportError(reason);
      emit();
      return { ok: false, reason: "restore-failed" };
    } finally {
      exiting = false;
    }
    active = false;
    enteredAt = undefined;
    session = undefined;
    sessionEngine = undefined;
    emit();
    return { ok: true };
  }

  return {
    get active() {
      return active;
    },
    enterPlay,
    exitPlay,
  };
}

/** React 薄包装：控制器只创建一次，host 闭包每渲染经 getHost 刷新（与 App 绑定重建语义一致）。 */
export function useScenePlayMode(getHost: () => ScenePlayModeHost): ScenePlayModeController & ScenePlayModeState {
  const [state, setState] = useState<ScenePlayModeState>(IDLE_STATE);
  const hostRef = useRef(getHost);
  hostRef.current = getHost;
  const controllerRef = useRef<ScenePlayModeController | undefined>(undefined);
  if (!controllerRef.current) controllerRef.current = createScenePlayModeController(() => hostRef.current(), setState);
  // active 以 notify 同步进 React state 为准；enterPlay/exitPlay 返回值即同步事实，UI 入口可直接消费。
  return {
    active: state.active,
    enteredAt: state.enteredAt,
    enterPlay: controllerRef.current.enterPlay,
    exitPlay: controllerRef.current.exitPlay,
  };
}
