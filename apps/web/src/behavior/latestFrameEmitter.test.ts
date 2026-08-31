import { describe, expect, it, vi } from "vitest";
import { createLatestFrameEmitter, type FrameRequester } from "./latestFrameEmitter";

describe("createLatestFrameEmitter", () => {
  it("同一帧只发布最新运行状态", () => {
    const callbacks: FrameRequestCallback[] = [];
    const publish = vi.fn();
    const emit = createLatestFrameEmitter(publish, ((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as FrameRequester);

    emit("初始化");
    emit("运行中");
    emit("错误");

    expect(callbacks).toHaveLength(1);
    callbacks[0]?.(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith("错误");

    emit("已恢复");
    expect(callbacks).toHaveLength(2);
    callbacks[1]?.(16);
    expect(publish).toHaveBeenLastCalledWith("已恢复");
  });
});
