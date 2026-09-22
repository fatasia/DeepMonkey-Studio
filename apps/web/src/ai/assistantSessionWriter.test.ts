import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantSessionWriter } from "./assistantSessionWriter";
const base = { question: "检查", answer: "", mode: "scene" as const, status: "streaming" as const };
afterEach(() => vi.useRealTimers());
describe("assistant session writer", () => {
  it("coalesces deltas but flushes a terminal snapshot and ignores late deltas", async () => {
    vi.useFakeTimers(); const save = vi.fn(async () => undefined);
    const writer = new AssistantSessionWriter(save, vi.fn());
    writer.update(base); writer.update({ ...base, answer: "局部" });
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith({ ...base, answer: "局部", sequence: 2 });
    writer.update({ ...base, answer: "停止前文字", status: "stopped" });
    writer.update({ ...base, answer: "迟到文字" }); await writer.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ ...base, answer: "停止前文字", status: "stopped", sequence: 3 });
  });
  it("retries an ambiguous network failure with the identical sequence and terminal text", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const error = vi.fn(); const writer = new AssistantSessionWriter(save, error);
    writer.update({ ...base, answer: "已完成", status: "completed" });
    await expect(writer.flush()).rejects.toThrow("offline");
    await writer.flush();
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
    expect(error).toHaveBeenCalledTimes(1);
  });
  it("serializes an in-flight save before the final snapshot", async () => {
    let resolve!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(done => { resolve = done; })).mockResolvedValue(undefined);
    const writer = new AssistantSessionWriter(save, vi.fn());
    writer.update(base); const flushing = writer.flush();
    writer.update({ ...base, status: "completed", answer: "最终" });
    expect(save).toHaveBeenCalledTimes(1); resolve(); await flushing;
    expect(save.mock.calls.map(call => call[0].status)).toEqual(["streaming", "completed"]);
  });
});
