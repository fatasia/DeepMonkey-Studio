import { describe, expect, it, vi } from "vitest";
import { ModelLoadCoordinator } from "./modelLoadCoordinator";

describe("ModelLoadCoordinator", () => {
  it("reports current pending work and excludes cancelled epochs without waiting for stale tasks", async () => {
    const coordinator = new ModelLoadCoordinator<string>(); let release!: () => void;
    const pending = coordinator.run("slow", coordinator.currentEpoch, () => new Promise(resolve => { release = () => resolve("old"); }));
    expect(coordinator.hasPending).toBe(true);
    coordinator.invalidate(); expect(coordinator.hasPending).toBe(false);
    const current = coordinator.run("current", coordinator.currentEpoch, async () => "new");
    expect(coordinator.hasPending).toBe(true); await current;
    expect(coordinator.hasPending).toBe(false); release(); await pending;
    expect(coordinator.hasPending).toBe(false);
  });
  it("deduplicates concurrent loads for the same model and scene epoch", async () => {
    const coordinator = new ModelLoadCoordinator<string>();
    const task = vi.fn(async () => "loaded");

    const first = coordinator.run("model-1", coordinator.currentEpoch, task);
    const second = coordinator.run("model-1", coordinator.currentEpoch, task);

    await expect(Promise.all([first, second])).resolves.toEqual(["loaded", "loaded"]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an old scene load after invalidation", async () => {
    const coordinator = new ModelLoadCoordinator<string>();
    const oldEpoch = coordinator.currentEpoch;
    const oldLoad = coordinator.run("model-1", oldEpoch, async () => "old");

    coordinator.invalidate();
    const currentEpoch = coordinator.currentEpoch;
    const newLoad = coordinator.run("model-1", currentEpoch, async () => "new");

    await expect(oldLoad).resolves.toBe("old");
    await expect(newLoad).resolves.toBe("new");
    expect(coordinator.isCurrent(oldEpoch)).toBe(false);
    expect(coordinator.isCurrent(currentEpoch)).toBe(true);
  });
});
