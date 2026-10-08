import { afterEach, expect, it, vi } from "vitest";
import { startStudioRendererPrewarm } from "./studioRendererPreparation";

afterEach(() => vi.useRealTimers());
it("waits for scene restoration, prepares each stable version once and cancels superseded work", async () => {
  vi.useFakeTimers();
  let key: string | undefined;
  const tasks: { key: string; signal: AbortSignal; resolve(value: boolean): void }[] = [];
  const prepare = vi.fn((key: string, signal: AbortSignal) => new Promise<boolean>(resolve => tasks.push({ key, signal, resolve })));
  const stop = startStudioRendererPrewarm(() => key, prepare);
  await vi.advanceTimersByTimeAsync(1000); expect(prepare).not.toHaveBeenCalled();
  key = "partial"; await vi.advanceTimersByTimeAsync(500);
  key = "loaded"; await vi.advanceTimersByTimeAsync(1000);
  expect(tasks.map(task => task.key)).toEqual(["loaded"]);
  key = "edited"; await vi.advanceTimersByTimeAsync(500);
  expect(tasks[0]!.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  tasks[0]!.resolve(true); tasks[1]!.resolve(true);
  await vi.advanceTimersByTimeAsync(5000); expect(prepare).toHaveBeenCalledTimes(2);
  key = "next"; await vi.advanceTimersByTimeAsync(1000); stop();
  expect(tasks[2]!.signal.aborted).toBe(true);
});
it("retries a busy foreground bridge without restarting successful work", async () => {
  vi.useFakeTimers();
  const prepare = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const stop = startStudioRendererPrewarm(() => "scene", prepare);
  await vi.advanceTimersByTimeAsync(5000);
  expect(prepare).toHaveBeenCalledTimes(2); stop();
});
