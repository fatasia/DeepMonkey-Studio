import { describe, expect, it, vi } from "vitest";
import { validatePbrFrame } from "./validatePbrFrame.js";

type ErrorListener = (event: { error: { name: string; message: string } }) => void;

function fakeSession(overrides?: {
  state?: string;
  diagnostics?: string[];
  listeners?: Map<string, Set<ErrorListener>>;
}) {
  const listeners = overrides?.listeners ?? new Map<string, Set<ErrorListener>>();
  const device = {
    addEventListener: (type: string, listener: ErrorListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: ErrorListener) => { listeners.get(type)?.delete(listener); },
    queue: { onSubmittedWorkDone: () => Promise.resolve() },
    dispatchError(name: string, message: string) {
      for (const listener of listeners.get("uncapturederror") ?? []) listener({ error: { name, message } });
    },
    listenerCount(type: string) { return listeners.get(type)?.size ?? 0; },
  };
  return {
    device,
    state: overrides?.state ?? "ready",
    diagnostics: overrides?.diagnostics ?? [],
  } as unknown as Parameters<typeof validatePbrFrame>[0] & { device: typeof device; diagnostics: string[] };
}

const FRAME = { frameId: 1 } as never;

describe("validatePbrFrame uncaptured-error window", () => {
  it("passes a clean frame and detaches the listener (window closed)", async () => {
    const session = fakeSession();
    const frame = await validatePbrFrame(session, () => FRAME, () => { throw new Error("must not invalidate"); });
    expect(frame).toBe(FRAME);
    expect((session as unknown as { device: { listenerCount(t: string): number } }).device.listenerCount("uncapturederror")).toBe(0);
  });

  it("captures an uncaptured validation error and fails closed with invalidate", async () => {
    const session = fakeSession();
    let invalidated = 0;
    // render 期间 device 派发 validation error(异步派发时序由宏任务窗口兜住)。
    const pending: Promise<void>[] = [];
    const original = session.device.queue.onSubmittedWorkDone;
    (session.device.queue as { onSubmittedWorkDone: () => Promise<void> }).onSubmittedWorkDone = () => {
      const done = original.call(session.device.queue);
      // 排空 resolve 之后、窗口收口前派发——模拟事件任务晚于 drain resolve。
      queueMicrotask(() => {
        pending.push(Promise.resolve());
        (session as unknown as { device: { dispatchError(n: string, m: string): void } }).device
          .dispatchError("GPUValidationError", "encoder finished twice");
      });
      return done;
    };
    await expect(validatePbrFrame(session, () => FRAME, () => { invalidated++; }))
      .rejects.toThrow("encoder finished twice");
    expect(invalidated).toBe(1);
  });

  it("still fails closed on hidden surface, stale state and diagnostics", async () => {
    const hidden = fakeSession();
    await expect(validatePbrFrame(hidden, () => undefined, () => {})).rejects.toThrow("Surface is hidden");
    const stale = fakeSession({ state: "lost" });
    await expect(validatePbrFrame(stale, () => FRAME, () => {})).rejects.toThrow("not ready");
    const diagnosed = fakeSession({ diagnostics: ["device reset"] });
    await expect(validatePbrFrame(diagnosed, () => FRAME, () => {})).rejects.toThrow("GPU first frame failed");
  });
});
