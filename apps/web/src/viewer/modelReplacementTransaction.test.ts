import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { captureSceneModelState } from "./captureSceneModelState";
import { commitModelReplacement } from "./modelReplacementTransaction";
import { manifest, modelInstanceHarness, modelObject } from "./modelInstanceEngineTestFixture";

describe("deferred model resource disposal", () => {
  it.each(["register-before-mount", "register-after-mount", "apply-state"])("restores the original object and all authored state after candidate %s failure", async failure => {
    const h = modelInstanceHarness(); const candidate = modelObject();
    const retainedFloor = { modelId: "instance", level: "first", visible: false, expansion: 3 };
    const otherFloor = { modelId: "other", level: "second", visible: true, expansion: 7 };
    h.floors.set("instance:first", retainedFloor); h.floors.set("other:second", otherFloor);
    const snapshot = captureSceneModelState(h.engine, h.original); const camera = h.camera.position.toArray();
    const originalGeometry = (h.original.object.children[0] as THREE.Mesh).geometry;
    const disposeOriginal = vi.spyOn(originalGeometry, "dispose");
    const disposeCandidate = vi.spyOn((candidate.children[0] as THREE.Mesh).geometry, "dispose");
    h.gltfLoader.loadAsync.mockResolvedValue({ scene: candidate, animations: [] });
    const normalRegister = h.registerObject.getMockImplementation()!;
    const normalApply = h.applyModelState.getMockImplementation()!;
    if (failure.startsWith("register")) h.registerObject.mockImplementationOnce((...args) => {
      if (failure === "register-after-mount") normalRegister(...args);
      expect(disposeOriginal).not.toHaveBeenCalled(); throw new Error("candidate registration failed");
    });
    else h.applyModelState.mockImplementationOnce((...args) => {
      normalApply(...args); expect(disposeOriginal).not.toHaveBeenCalled(); throw new Error("candidate state failed");
    });
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("原实例已恢复");
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.original.assetModelId).toBe("asset-old");
    expect(h.modelRoot.children).toEqual([h.original.object]);
    expect(h.applied.get("instance")).toEqual(snapshot);
    expect(captureSceneModelState(h.engine, h.original)).toEqual(snapshot);
    expect(h.floors.get("instance:first")).toEqual(retainedFloor); expect(h.floors.get("other:second")).toBe(otherFloor);
    expect(h.controls.selected).toBe("instance"); expect(h.controls.selectedLayer).toBe("root/0");
    expect(h.camera.position.toArray()).toEqual(camera);
    expect(disposeOriginal).not.toHaveBeenCalled(); expect(disposeCandidate).toHaveBeenCalledOnce();
    expect(h.fitAll).not.toHaveBeenCalled();
  });

  it("preserves the original mixer, selected animation, exact action time and policy on rollback", async () => {
    const h = modelInstanceHarness();
    const clip = new THREE.AnimationClip("grip", 2, []); const mixer = new THREE.AnimationMixer(h.original.object);
    const action = mixer.clipAction(clip).play(); action.time = 0.7; action.paused = true; mixer.time = 4.7; mixer.timeScale = 0.4;
    const stop = vi.spyOn(mixer, "stopAllAction"), uncache = vi.spyOn(mixer, "uncacheRoot");
    const runtime = {
      mixers: new Map([["instance", mixer]]), animationClipSelection: new Map([["instance", "grip"]]),
      animationEnabledIds: new Set(["instance"]), modelAnimationPlaybackStates: new Map([["instance", { autoplay: true, loopMode: "once" }]]),
    };
    Object.assign(h.engine, runtime); h.animationClips.set("instance", [clip]);
    h.gltfLoader.loadAsync.mockResolvedValue({ scene: modelObject(), animations: [new THREE.AnimationClip("grip", 2, [])] });
    h.applyModelState.mockImplementationOnce(() => { throw new Error("candidate cannot apply"); });
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("原实例已恢复");
    expect(runtime.mixers.get("instance")).toBe(mixer); expect(h.animationClips.get("instance")).toEqual([clip]);
    expect(runtime.animationClipSelection.get("instance")).toBe("grip"); expect(runtime.animationEnabledIds.has("instance")).toBe(true);
    expect(runtime.modelAnimationPlaybackStates.get("instance")).toEqual({ autoplay: true, loopMode: "once" });
    expect(mixer.existingAction(clip)).toBe(action); expect(action.time).toBe(0.7); expect(action.paused).toBe(true);
    expect(mixer.time).toBe(4.7); expect(mixer.timeScale).toBe(0.4); expect(stop).not.toHaveBeenCalled(); expect(uncache).not.toHaveBeenCalled();
  });

  it("releases the old geometry only after candidate state and floors successfully apply", async () => {
    const h = modelInstanceHarness(); const original = h.original.object;
    const disposeOriginal = vi.spyOn((original.children[0] as THREE.Mesh).geometry, "dispose");
    const apply = h.applyModelState.getMockImplementation()!;
    h.applyModelState.mockImplementation((...args) => { expect(disposeOriginal).not.toHaveBeenCalled(); apply(...args); });
    const result = await h.engine.replaceModelManifest("instance", manifest());
    expect(h.models.get("instance")).toBe(result); expect(result.object).not.toBe(original);
    expect(h.modelRoot.children).toEqual([result.object]); expect(disposeOriginal).toHaveBeenCalledOnce();
  });

  it("can retry a candidate after a rolled-back commit without changing identity", async () => {
    const h = modelInstanceHarness();
    h.applyModelState.mockImplementationOnce(() => { throw new Error("candidate setup failed"); });
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("原实例已恢复");
    const result = await h.engine.replaceModelManifest("instance", manifest());
    expect(result.id).toBe("instance"); expect(result.assetModelId).toBe("asset-new");
    expect(h.models.size).toBe(1); expect(h.modelRoot.children).toEqual([result.object]);
    expect(h.gltfLoader.loadAsync).toHaveBeenCalledTimes(2);
  });

  it("restores target floors and selection if candidate floor reapplication fails", async () => {
    const h = modelInstanceHarness(); const floor = { modelId: "instance", level: "first", visible: false, expansion: 3 };
    h.floors.set("instance:first", floor);
    const normalSetFloor = h.engine.setFloorState.bind(h.engine);
    vi.spyOn(h.engine, "setFloorState").mockImplementationOnce(() => { throw new Error("candidate floor failed"); }).mockImplementation(normalSetFloor);
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("原实例已恢复");
    expect(h.models.get("instance")).toBe(h.original); expect(h.floors.get("instance:first")).toEqual(floor);
    expect(h.controls.selected).toBe("instance"); expect(h.controls.selectedLayer).toBe("root/0");
  });

  it("keeps normal instance deletion immediate", () => {
    const h = modelInstanceHarness(); const disposeOriginal = vi.spyOn((h.original.object.children[0] as THREE.Mesh).geometry, "dispose");
    h.engine.removeModel("instance"); expect(disposeOriginal).toHaveBeenCalledOnce();
    expect(h.models.has("instance")).toBe(false); expect(h.modelRoot.children).toEqual([]);
  });

  it("reports systemic rollback failure without disposing the retained original", async () => {
    const h = modelInstanceHarness(); const disposeOriginal = vi.spyOn((h.original.object.children[0] as THREE.Mesh).geometry, "dispose");
    h.applyModelState.mockImplementation(() => { throw new Error("renderer unavailable"); });
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("原实例回滚也失败");
    expect(disposeOriginal).not.toHaveBeenCalled(); expect(h.models.get("instance")).toBe(h.original);
  });

  it("still attempts restoration when candidate cleanup itself fails", () => {
    const restorePrevious = vi.fn(), releasePrevious = vi.fn();
    expect(() => commitModelReplacement({ detachPrevious: vi.fn(), installCandidate: () => { throw new Error("candidate"); },
      discardCandidate: () => { throw new Error("dispose"); }, restorePrevious, releasePrevious })).toThrow("原实例已恢复，但候选资源清理失败");
    expect(restorePrevious).toHaveBeenCalledOnce(); expect(releasePrevious).not.toHaveBeenCalled();
  });
});
