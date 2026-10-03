import { describe, expect, it } from "vitest";
import {
  AGENT_POLL_INTERVAL_MS,
  AGENT_POLL_MAX_BACKOFF_MS,
  createAgentPollBackoff,
  shouldReportPollFailure,
} from "./agentRunPolling";

describe("agentRunPolling（H-C5-K10 退避与错误节流）", () => {
  it("连续失败指数退避并封顶：2400→4800→9600→15000", () => {
    const backoff = createAgentPollBackoff();
    expect(backoff.failures).toBe(0);
    expect(backoff.next()).toBe(2 * AGENT_POLL_INTERVAL_MS);
    expect(backoff.next()).toBe(4 * AGENT_POLL_INTERVAL_MS);
    expect(backoff.next()).toBe(8 * AGENT_POLL_INTERVAL_MS);
    expect(backoff.failures).toBe(3);
    expect(backoff.next()).toBe(AGENT_POLL_MAX_BACKOFF_MS);
    // 已在封顶后继续失败不再增长。
    expect(backoff.next()).toBe(AGENT_POLL_MAX_BACKOFF_MS);
  });

  it("成功复位后回到初始节奏", () => {
    const backoff = createAgentPollBackoff();
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.failures).toBe(0);
    expect(backoff.next()).toBe(2 * AGENT_POLL_INTERVAL_MS);
  });

  it("自定义 base/max 生效（测试与非默认节奏可注入）", () => {
    const backoff = createAgentPollBackoff(100, 300);
    expect(backoff.next()).toBe(200);
    expect(backoff.next()).toBe(300);
    expect(backoff.next()).toBe(300);
  });

  it("错误节流：连续失败只在首次上报，成功复位后再次首败仍上报", () => {
    expect(shouldReportPollFailure(1)).toBe(true);
    expect(shouldReportPollFailure(2)).toBe(false);
    expect(shouldReportPollFailure(5)).toBe(false);
    expect(shouldReportPollFailure(0)).toBe(false);
  });
});
