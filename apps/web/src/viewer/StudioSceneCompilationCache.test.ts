import { expect, it, vi } from "vitest";
import { StudioSceneCompilationCache } from "./StudioSceneCompilationCache";

it("shares prewarm and switch work while cancellation belongs to each caller", async () => {
  const cache = new StudioSceneCompilationCache<string>();
  let finish!: (value: string) => void;
  let workSignal!: AbortSignal;
  const compile = vi.fn((signal: AbortSignal) => { workSignal = signal; return new Promise<string>(resolve => { finish = resolve; }); });
  const warm = new AbortController(), user = new AbortController();
  const background = cache.get("scene", warm.signal, compile);
  const foreground = cache.get("scene", user.signal, compile);
  await Promise.resolve();warm.abort();
  await expect(background).rejects.toMatchObject({ name: "AbortError" });
  expect(workSignal.aborted).toBe(false);
  finish("compiled");expect(await foreground).toBe("compiled");
  expect(await cache.get("scene", user.signal, compile)).toBe("compiled");
  expect(compile).toHaveBeenCalledOnce();
});

it("terminates unobserved work and does not let stale results replace the newest scene", async () => {
  const cache = new StudioSceneCompilationCache<string>();
  let oldFinish!: (value: string) => void;
  const old = cache.get("old", new AbortController().signal, () => new Promise(resolve => { oldFinish = resolve; }));
  await Promise.resolve();
  const buildNew = vi.fn(async () => "new");
  expect(await cache.get("new", new AbortController().signal, buildNew)).toBe("new");
  oldFinish("old");expect(await old).toBe("old");
  expect(await cache.get("new", new AbortController().signal, buildNew)).toBe("new");
  expect(buildNew).toHaveBeenCalledOnce();
  const controller = new AbortController();
  let signal!: AbortSignal;
  let finish!: (value: string) => void;
  const pending = cache.get("unused", controller.signal, input => { signal = input; return new Promise(resolve => { finish = resolve; }); });
  await Promise.resolve();controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });expect(signal.aborted).toBe(true);
  finish("stale");await Promise.resolve();
});

it("clears ownership and retries failed work", async () => {
  const cache = new StudioSceneCompilationCache<string>(), signal = new AbortController().signal;
  await expect(cache.get("scene", signal, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(await cache.get("scene", signal, async () => "retry")).toBe("retry");
  cache.clear();
  expect(await cache.get("scene", signal, async () => "fresh")).toBe("fresh");
});

it("retires only the accepted transport while preserving a newer compilation", async () => {
  const cache = new StudioSceneCompilationCache<object>(), signal = new AbortController().signal;
  const old = await cache.get("old", signal, async () => ({}));
  const compile = vi.fn(async () => ({}));
  const current = await cache.get("new", signal, compile);
  cache.release(old);
  expect(await cache.get("new", signal, compile)).toBe(current);
  cache.release(current);
  expect(await cache.get("new", signal, compile)).not.toBe(current);
  expect(compile).toHaveBeenCalledTimes(2);
});
