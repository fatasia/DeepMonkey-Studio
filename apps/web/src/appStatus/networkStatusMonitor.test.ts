import { describe, expect, it } from "vitest";
import { NetworkStatusMonitor } from "./networkStatusMonitor";

describe("NetworkStatusMonitor", () => {
  it("连续两次失败进入降级，一次失败仍保持空闲", () => {
    const monitor = new NetworkStatusMonitor();
    monitor.recordFailure("HTTP 502");
    expect(monitor.getSnapshot().phase).toBe("idle");
    monitor.recordFailure("HTTP 502");
    expect(monitor.getSnapshot().phase).toBe("degraded");
    expect(monitor.getSnapshot().detail).toBe("HTTP 502");
  });

  it("4xx 证明链路健康，按成功计", () => {
    const monitor = new NetworkStatusMonitor();
    monitor.recordFailure("HTTP 502");
    monitor.recordSuccess();
    monitor.recordSuccess();
    expect(monitor.getSnapshot().phase).toBe("idle");
  });

  it("降级后恢复进入提示态并自动收起，期间的成功不重置计时", () => {
    vi_useFakeTimers();
    const monitor = new NetworkStatusMonitor();
    monitor.recordFailure("网络不可达");
    monitor.recordFailure("网络不可达");
    monitor.recordSuccess();
    expect(monitor.getSnapshot().phase).toBe("recovered");
    monitor.recordSuccess();
    monitor.recordSuccess();
    vi_advanceTimers(2100);
    expect(monitor.getSnapshot().phase).toBe("recovered");
    vi_advanceTimers(2000);
    expect(monitor.getSnapshot().phase).toBe("idle");
    vi_useRealTimers();
  });

  it("恢复期间再次失败立即回到降级，不再自动收起", () => {
    vi_useFakeTimers();
    const monitor = new NetworkStatusMonitor();
    monitor.recordFailure("HTTP 503");
    monitor.recordFailure("HTTP 503");
    monitor.recordSuccess();
    monitor.recordFailure("HTTP 503");
    expect(monitor.getSnapshot().phase).toBe("degraded");
    vi_advanceTimers(5000);
    expect(monitor.getSnapshot().phase).toBe("degraded");
    vi_useRealTimers();
  });

  it("长连接断开直接触发降级", () => {
    const monitor = new NetworkStatusMonitor();
    monitor.noteTransportDisconnected();
    expect(monitor.getSnapshot().phase).toBe("degraded");
    monitor.recordSuccess();
    expect(monitor.getSnapshot().phase).toBe("recovered");
  });

  it("订阅者只在状态变化时收到通知(空闲期单次失败不广播)", () => {
    const monitor = new NetworkStatusMonitor();
    let notifications = 0;
    const unsubscribe = monitor.subscribe(() => { notifications += 1; });
    monitor.recordFailure("HTTP 500");
    expect(notifications).toBe(0);
    monitor.recordFailure("HTTP 500");
    monitor.recordSuccess();
    expect(notifications).toBe(2);
    unsubscribe();
  });
});

import { afterEach, vi } from "vitest";
function vi_useFakeTimers() { vi.useFakeTimers(); }
function vi_useRealTimers() { vi.useRealTimers(); }
function vi_advanceTimers(ms: number) { vi.advanceTimersByTime(ms); }
afterEach(() => { try { vi.useRealTimers(); } catch { /* 未启用时无需恢复 */ } });
