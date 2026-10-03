/**
 * H-C5-K10：运行状态轮询的指数退避与错误节流。
 *
 * 旧实现固定 1.2s 轮询且每次失败都 setError，服务端抖动时错误条反复闪现刷屏。
 * 现约定：成功后固定间隔；失败一次间隔翻倍（封顶 MAX），错误只在首次失败时上报，
 * 连续失败不再重复驱动 UI，成功后全部复位。
 */

export const AGENT_POLL_INTERVAL_MS = 1_200;
export const AGENT_POLL_MAX_BACKOFF_MS = 15_000;

export interface AgentPollBackoff {
  /** 已连续失败的次数（成功后归零）。 */
  readonly failures: number;
  /** 失败后调用：返回下一次轮询前要等待的毫秒数（base * 2^failures，封顶 max）。 */
  next(): number;
  /** 成功后调用：回到固定间隔节奏。 */
  reset(): void;
}

export function createAgentPollBackoff(base: number = AGENT_POLL_INTERVAL_MS, max: number = AGENT_POLL_MAX_BACKOFF_MS): AgentPollBackoff {
  let count = 0;
  return {
    get failures() { return count; },
    next() {
      count += 1;
      return Math.min(base * 2 ** count, max);
    },
    reset() { count = 0; },
  };
}

/** 错误节流：连续失败期间只在第 1 次上报，避免同一故障反复刷错误条。 */
export function shouldReportPollFailure(failures: number): boolean {
  return failures === 1;
}
