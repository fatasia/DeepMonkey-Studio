import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneWorkspaceLoadGate } from "./sceneWorkspaceLoadGate";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("scene workspace load gate (P2-5 模式切换进度门)", () => {
  it("engages busy only after the 500ms threshold, and release clears it exactly once", () => {
    const setBusy = vi.fn();
    const gate = createSceneWorkspaceLoadGate(setBusy);
    gate.engage();
    vi.advanceTimersByTime(499);
    expect(setBusy).not.toHaveBeenCalled(); // 快速载入不闪进度
    vi.advanceTimersByTime(1);
    expect(setBusy).toHaveBeenCalledWith(true);
    gate.release();
    expect(setBusy).toHaveBeenLastCalledWith(false);
    gate.release(); // 幂等：重复释放不追加状态翻转
    expect(setBusy).toHaveBeenCalledTimes(2);
  });

  it("cancels the engage timer when released before the threshold", () => {
    const setBusy = vi.fn();
    const gate = createSceneWorkspaceLoadGate(setBusy);
    gate.engage();
    gate.release();
    vi.advanceTimersByTime(2000);
    expect(setBusy).not.toHaveBeenCalled(); // 未接通即释放：不产生迟到的 busy
  });

  it("ignores engage after release (stale handles are inert)", () => {
    const setBusy = vi.fn();
    const gate = createSceneWorkspaceLoadGate(setBusy);
    gate.release();
    gate.engage();
    vi.advanceTimersByTime(1000);
    expect(setBusy).not.toHaveBeenCalled();
  });
});
