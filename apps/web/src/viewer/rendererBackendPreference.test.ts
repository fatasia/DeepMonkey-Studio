import { describe, expect, it, vi } from "vitest";
import { RENDERER_BACKEND_STORAGE_KEY } from "../appDefaults";
import { canAutomaticallyChangeRenderer, commitRendererPreference, stageRendererPreference } from "./rendererBackendPreference";

describe("renderer backend preference", () => {
  it.each(["preparing", "recovering", "failed"] as const)("blocks automatic retries in %s", (phase) => {
    expect(canAutomaticallyChangeRenderer(phase, false)).toBe(false);
    expect(canAutomaticallyChangeRenderer(phase, true)).toBe(false);
  });

  it("restores automatically only when idle and not already switching", () => {
    expect(canAutomaticallyChangeRenderer("idle", false)).toBe(true);
    expect(canAutomaticallyChangeRenderer("idle", true)).toBe(false);
  });

  it("does not let a stored preference restart a failed candidate after fallback", () => {
    let starts = 0;
    const stored = "webgpu";
    const active = "webgl" as string;
    for (let render = 0; render < 20; render++) {
      if (stored !== active && canAutomaticallyChangeRenderer("failed", false)) starts++;
    }
    expect(starts).toBe(0);
    // 用户仍可登记明确重试，自动保护不修改偏好或禁止手动路径。
    const pending = { current: undefined as "webgl" | "webgpu" | undefined };
    stageRendererPreference(pending, "webgpu", true);
    expect(pending.current).toBe("webgpu");
  });
  it("does not persist until the requested backend is active", () => {
    const pending = { current: undefined as "webgl" | "webgpu" | undefined };
    const storage = { setItem: vi.fn() };

    stageRendererPreference(pending, "webgpu", true);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(commitRendererPreference(pending, "webgl", storage)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();

    expect(commitRendererPreference(pending, "webgpu", storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(RENDERER_BACKEND_STORAGE_KEY, "webgpu");
    expect(pending.current).toBeUndefined();
  });

  it("keeps temporary publication switches out of user preferences", () => {
    const pending = { current: "webgpu" as "webgl" | "webgpu" | undefined };
    const storage = { setItem: vi.fn() };

    stageRendererPreference(pending, "webgl", false);

    expect(pending.current).toBeUndefined();
    expect(commitRendererPreference(pending, "webgl", storage)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("clears a completed activation even when browser storage rejects the write", () => {
    const pending = { current: "webgpu" as "webgl" | "webgpu" | undefined };
    const storage = { setItem: vi.fn(() => { throw new Error("quota"); }) };

    expect(() => commitRendererPreference(pending, "webgpu", storage)).toThrow("quota");
    expect(pending.current).toBeUndefined();
  });
});
