import { afterEach, describe, expect, it, vi } from "vitest";

interface SocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  onError(): void;
  onClose(): void;
}

const sockets: Array<{ close: ReturnType<typeof vi.fn>; handlers: SocketHandlers }> = [];
const connectSceneDataSocket = vi.fn((_projectId: string, _token: string | undefined, handlers: SocketHandlers) => {
  const socket = { close: vi.fn(), handlers };
  sockets.push(socket);
  return socket;
});

vi.mock("./adapters/sceneDataSocket", () => ({ connectSceneDataSocket }));
vi.mock("./api", () => ({ getAuthToken: () => undefined }));

afterEach(() => {
  sockets.length = 0;
  connectSceneDataSocket.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scene data bridge reconnect", () => {
  it("caps exponential reconnect delay and cancels pending work on unsubscribe", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, delay: number) => Number(globalThis.setTimeout(callback, delay)),
      clearTimeout: (timer: number) => globalThis.clearTimeout(timer),
    });
    const { subscribeSceneData } = await import("./sceneDataBridge.js");
    const stop = subscribeSceneData("weak-network-project", vi.fn());
    expect(connectSceneDataSocket).toHaveBeenCalledTimes(1);

    for (const delay of [800, 1_600, 3_200, 6_400, 10_000]) {
      sockets.at(-1)!.handlers.onClose();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(connectSceneDataSocket).toHaveBeenCalledTimes(sockets.length);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectSceneDataSocket).toHaveBeenCalledTimes(sockets.length);
    }

    sockets.at(-1)!.handlers.onClose();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connectSceneDataSocket).toHaveBeenCalledTimes(6);
  });
});
