/**
 * T31 × T30 Play 模式最小联动边界(切片一)。
 *
 * 六步核查结论:T30 的 `useScenePlayMode` hook 已交付,但其上层消费方(Play UI 入口)
 * 尚未接入 App——当前不存在生产态的 active 信号可消费。按任务口径"若 T30 接口不便
 * 消费,定义清晰边界并报告":
 * - 本文件**不 import** `hooks/useScenePlayMode*`(文件所有权纪律,T30 文件零改动);
 * - 以结构兼容接口(鸭子类型)消费 Play 信号:`{ readonly active: boolean }` 与
 *   `useScenePlayMode` 返回形态、`ScenePlayModeState` 完全结构兼容;
 * - 未来 App 接线处只需一行:`isActive: () => playMode.active`。
 *
 * 语义(对标 Unity Play Mode 的脚本域生命周期):
 * - 进入 Play(active false→true):创建**新**脚本运行时会话并 start(会话隔离——
 *   每次进入都是干净初态,与 T30 "进入前快照 = 已提交事实"的隔离口径一致);
 * - 退出 Play(true→false):stop 当前会话并丢弃;
 * - 幂等:重复 sync 不重复 start/stop;异常如实传播,不假装成功。
 */

/** 与 T30 `ScenePlayModeState`/`useScenePlayMode` 返回结构兼容的最小面。 */
export interface PlayModeSignalSource {
  readonly active: boolean;
}

/** 脚本运行时会话生命周期(受限图运行时或任何等价会话对象)。 */
export interface ScriptRuntimeSession {
  start(): void;
  stop(): void;
}

export interface PlayModeScriptRuntimeBridgeOptions<T extends ScriptRuntimeSession> {
  /** Play 信号源(active 布尔);每次 sync 时读取最新值。 */
  readonly isActive: () => boolean;
  /** 进入 Play 时创建新会话(工厂注入保证会话隔离);抛错则本次进入失败并如实传播。 */
  readonly createSession: () => T;
  /** 可选:信号订阅(如 React 状态变更回调);缺省时由宿主手动调 sync()。 */
  readonly subscribe?: (listener: () => void) => () => void;
}

export interface PlayModeScriptRuntimeBridge<T extends ScriptRuntimeSession> {
  /** 当前会话;仅 Play 活跃期间非空。 */
  readonly session: T | undefined;
  /** 会话是否处于运行态。 */
  readonly running: boolean;
  /** 同步信号:进入/退出 Play 各触发一次 start/stop;幂等。 */
  sync(): void;
  /** 释放:停止当前会话并退订信号;之后 sync 不再起会话。 */
  dispose(): void;
}

export function createPlayModeScriptRuntimeBridge<T extends ScriptRuntimeSession>(
  options: PlayModeScriptRuntimeBridgeOptions<T>,
): PlayModeScriptRuntimeBridge<T> {
  let session: T | undefined;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  const bridge: PlayModeScriptRuntimeBridge<T> = {
    get session() {
      return session;
    },
    get running() {
      return session !== undefined;
    },
    sync(): void {
      if (disposed) return;
      const active = options.isActive();
      if (active && session === undefined) {
        // 工厂抛错如实传播:本次进入失败、保持无会话,由宿主决定上报口径。
        session = options.createSession();
        session.start();
        return;
      }
      if (!active && session !== undefined) {
        const stopping = session;
        session = undefined;
        stopping.stop();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (session !== undefined) {
        const stopping = session;
        session = undefined;
        stopping.stop();
      }
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };

  if (options.subscribe) {
    unsubscribe = options.subscribe(() => bridge.sync());
    // 订阅建立后立即对齐一次当前信号态。
    bridge.sync();
  }
  return bridge;
}
