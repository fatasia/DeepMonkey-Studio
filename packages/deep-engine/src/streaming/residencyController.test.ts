import { describe, expect, it } from "vitest";
import { ResourceResidencyController } from "./residencyController.js";

const profile = (id: string, bytes = [80, 40, 20], revision = 1) => ({
  id, revision, kind: "geometry" as const, levels: bytes.map((byteLength, level) => ({ level, byteLength })),
});

describe("ResourceResidencyController", () => {
  it("degrades lower-priority requests deterministically to fit the stable budget", () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 120, maxUploadBytesPerFrame: 120 });
    controller.register(profile("hero")); controller.register(profile("background"));
    const plan = controller.planFrame(1, [
      { id: "background", desiredLevel: 0, priority: 1 },
      { id: "hero", desiredLevel: 0, priority: 10, required: true },
    ]);
    expect(plan.selections).toEqual([
      { id: "background", requestedLevel: 0, targetLevel: 1, reason: "quality-reduced" },
      { id: "hero", requestedLevel: 0, targetLevel: 0, reason: "requested" },
    ]);
    expect(plan.uploadBytes).toBe(120);
    expect(plan.transitionPeakBytes).toBe(120);
  });

  it("carries the registered resource kind into immutable upload work", () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 32, maxUploadBytesPerFrame: 32 });
    controller.register({ ...profile("albedo", [32]), kind: "texture" });
    const plan = controller.planFrame(1, [{ id: "albedo", desiredLevel: 0 }]);
    expect(plan.uploads).toEqual([expect.objectContaining({ id: "albedo", kind: "texture" })]);
    expect(controller.profile("albedo")).toMatchObject({ kind: "texture" });
    controller.commit(plan, new Set(["albedo"]));
    expect(controller.snapshot()).toEqual([expect.objectContaining({ id: "albedo", kind: "texture" })]);
  });

  it("keeps confirmed state when a replacement upload fails and commits successful peers", () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 200, maxUploadBytesPerFrame: 200 });
    controller.register(profile("a", [60, 20])); controller.register(profile("b", [60, 20]));
    const initial = controller.planFrame(1, [{ id: "a", desiredLevel: 1 }, { id: "b", desiredLevel: 1 }]);
    controller.commit(initial, new Set(["a", "b"]));
    const upgrade = controller.planFrame(2, [{ id: "a", desiredLevel: 0 }, { id: "b", desiredLevel: 0 }]);
    const result = controller.commit(upgrade, new Set(["a"]));
    expect(result.appliedUploads).toEqual(["a"]); expect(result.failedUploads).toEqual(["b"]);
    expect(result.evicted).toEqual(["a"]);
    expect(controller.snapshot().map((item) => [item.id, item.level])).toEqual([["a", 0], ["b", 1]]);
  });

  it("plans ten thousand resources without quadratic resident lookup", () => {
    const count = 10_000;
    const controller = new ResourceResidencyController({ maxResidentBytes: count, maxUploadBytesPerFrame: count,
      maxResources: count, retainFrames: 0 });
    const requests = Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, desiredLevel: 0 }));
    for (const request of requests) controller.register(profile(request.id, [1]));
    const first = controller.planFrame(1, requests); controller.commit(first, new Set(requests.map((request) => request.id)));
    const started = performance.now(); const second = controller.planFrame(2, requests);
    expect(second.uploads).toHaveLength(0); expect(performance.now() - started).toBeLessThan(1000);
  });

  it("bounds no-gap replacement peak and defers an upgrade without losing the resident fallback", () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 100, maxUploadBytesPerFrame: 100 });
    controller.register(profile("asset", [90, 20]));
    const initial = controller.planFrame(1, [{ id: "asset", desiredLevel: 1 }]);
    controller.commit(initial, new Set(["asset"]));
    const upgrade = controller.planFrame(2, [{ id: "asset", desiredLevel: 0 }]);
    expect(upgrade.uploads).toHaveLength(0);
    expect(upgrade.selections[0]).toMatchObject({ targetLevel: 1, reason: "transition-headroom" });
    controller.commit(upgrade, new Set());
    expect(controller.snapshot()[0]!.level).toBe(1);
  });

  it("evicts expired unrequested resources before upload and retains recent resources when budget allows", () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 100, maxUploadBytesPerFrame: 100, retainFrames: 2 });
    controller.register(profile("old", [50])); controller.register(profile("next", [50]));
    const first = controller.planFrame(1, [{ id: "old", desiredLevel: 0 }]); controller.commit(first, new Set(["old"]));
    const retained = controller.planFrame(2, [{ id: "next", desiredLevel: 0 }]);
    expect(retained.evictions).toHaveLength(0); controller.commit(retained, new Set(["next"]));
    const expired = controller.planFrame(5, [{ id: "next", desiredLevel: 0 }]);
    expect(expired.evictions).toContainEqual(expect.objectContaining({ id: "old", phase: "before-upload" }));
    controller.commit(expired, new Set()); expect(controller.snapshot().map((item) => item.id)).toEqual(["next"]);
  });

  it("invalidates stale plans and rejects revision regressions or malformed profiles", () => {
    const controller = new ResourceResidencyController({ maxResidentBytes: 100, maxUploadBytesPerFrame: 100 });
    controller.register(profile("asset", [60, 30], 2));
    const stale = controller.planFrame(1, [{ id: "asset", desiredLevel: 1 }]);
    controller.planFrame(2, [{ id: "asset", desiredLevel: 1 }]);
    expect(() => controller.commit(stale, new Set(["asset"]))).toThrow("stale");
    expect(() => controller.register(profile("asset", [60, 30], 1))).toThrow("regressed");
    expect(() => controller.register(profile("asset", [61, 30], 2))).toThrow("without a revision");
    expect(() => controller.register(profile("bad", [20, 21]))).toThrow("Coarser");
    const current = controller.planFrame(3, [{ id: "asset", desiredLevel: 1 }]);
    controller.commit(current, new Set(["asset"]));
    expect(() => controller.remove("asset")).toThrow("before eviction");
  });
});
