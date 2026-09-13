/**
 * 应用级连接状态监控:集中 fetch 出口在连续失败后进入降级态,恢复后短暂提示"已恢复"。
 * 只关心"服务器是否可达"——4xx(如登录失败)证明链路健康,不计入失败。
 */

export type NetworkStatusPhase = "idle" | "degraded" | "recovered";

export interface NetworkStatusSnapshot {
  phase: NetworkStatusPhase;
  /** 触发降级的最近一次原因,用于横幅文案与诊断。 */
  detail?: string;
}

const FAILURE_THRESHOLD = 2;
const RECOVERY_ANNOUNCE_MS = 4000;

export class NetworkStatusMonitor {
  private phase: NetworkStatusPhase = "idle";
  private detail: string | undefined;
  private consecutiveFailures = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  /** useSyncExternalStore 要求 getSnapshot 返回稳定引用:仅在状态真正变化时替换缓存对象。 */
  private snapshot: NetworkStatusSnapshot = { phase: "idle" };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): NetworkStatusSnapshot => this.snapshot;

  /** 请求成功或收到 4xx(链路可达)都视为健康;恢复提示只宣布一次,后续成功不打断自动收起。 */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.phase === "degraded") this.enterRecovered("连接已恢复");
  }

  /** 网络错误或 5xx 调用;detail 只取首个短语,避免横幅过长。恢复提示期间再失败立即回到降级。 */
  recordFailure(detail?: string): void {
    this.consecutiveFailures += 1;
    this.detail = detail;
    if (this.phase === "recovered" || this.consecutiveFailures >= FAILURE_THRESHOLD) this.enterDegraded();
  }

  /** WebSocket 等长连接断开时调用;恢复由下一次 recordSuccess 兜底。 */
  noteTransportDisconnected(detail = "长连接已断开"): void {
    this.detail = detail;
    this.enterDegraded();
  }

  dispose(): void {
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.listeners.clear();
  }

  private enterDegraded(): void {
    if (this.recoveryTimer !== undefined) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.phase !== "degraded") {
      this.phase = "degraded";
      this.publish();
    }
  }

  private enterRecovered(detail: string): void {
    this.detail = detail;
    this.phase = "recovered";
    this.publish();
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.phase = "idle";
      this.detail = undefined;
      this.publish();
    }, RECOVERY_ANNOUNCE_MS);
  }

  private publish(): void {
    this.snapshot = {
      phase: this.phase,
      ...(this.detail && this.phase !== "idle" ? { detail: this.detail } : {}),
    };
    for (const listener of this.listeners) listener();
  }
}

export const networkStatusMonitor = new NetworkStatusMonitor();
