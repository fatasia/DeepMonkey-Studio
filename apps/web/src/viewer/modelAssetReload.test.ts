import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { deferred, manifest, modelInstanceHarness, modelObject } from "./modelInstanceEngineTestFixture";

/** 资产热重载(reloadModelAsset):同素材原位重取 + 引擎替换事务 fail-closed。 */
describe("model asset hot reload", () => {
  it("refetches the same asset with a cache-busted url and swaps in place", async () => {
    const h = modelInstanceHarness();
    const source = manifest("asset-old");
    const before = h.models.get("instance")!;
    const result = await h.engine.reloadModelAsset("instance", source);
    expect(result.id).toBe("instance");
    expect(result.assetModelId).toBe("asset-old");
    expect(result.object).not.toBe(before.object);
    expect(h.models.get("instance")).toBe(result);
    const requestedUrl = h.gltfLoader.loadAsync.mock.calls[0]![0] as string;
    expect(requestedUrl.startsWith("/asset-old.glb?t=")).toBe(true);
    expect(h.removeModel).not.toHaveBeenCalled();
    expect(source.geometryUrl).toBe("/asset-old.glb");
  });

  it("keeps the mounted instance when the refetch fails", async () => {
    const h = modelInstanceHarness();
    h.gltfLoader.loadAsync.mockRejectedValue(new Error("network unavailable"));
    await expect(h.engine.reloadModelAsset("instance", manifest("asset-old"))).rejects.toThrow("network unavailable");
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.removeModel).not.toHaveBeenCalled();
  });

  it("keeps the mounted instance when the reloaded structure is incompatible", async () => {
    const h = modelInstanceHarness();
    h.gltfLoader.loadAsync.mockResolvedValue({ scene: modelObject("renamed-part"), animations: [] });
    await expect(h.engine.reloadModelAsset("instance", manifest("asset-old"))).rejects.toThrow("结构不兼容");
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.removeModel).not.toHaveBeenCalled();
  });

  it("keeps the mounted instance when a previous animation clip is missing", async () => {
    const h = modelInstanceHarness();
    h.animationClips.set("instance", [new THREE.AnimationClip("walk", 1, [])]);
    await expect(h.engine.reloadModelAsset("instance", manifest("asset-old"))).rejects.toThrow("动画");
    expect(h.removeModel).not.toHaveBeenCalled();
  });

  it("retains author state across the swap", async () => {
    const h = modelInstanceHarness();
    const result = await h.engine.reloadModelAsset("instance", manifest("asset-old"));
    expect(result.object.position.toArray()).toEqual([7, 2, 3]);
    expect(result.object.scale.toArray()).toEqual([2, 3, 4]);
    expect(result.name).toBe(h.original.name);
    expect(h.fitAll).not.toHaveBeenCalled();
  });

  it("delegates to the replacement transaction when the asset identity differs", async () => {
    const h = modelInstanceHarness();
    const result = await h.engine.reloadModelAsset("instance", manifest("asset-new"));
    expect(result.assetModelId).toBe("asset-new");
    expect(h.gltfLoader.loadAsync).toHaveBeenCalledWith("/asset-new.glb");
  });

  it.each(["locked", "isolated", "read-only"])("does not refetch when the instance is %s", async mode => {
    const h = modelInstanceHarness();
    if (mode === "locked") h.controls.locked = true;
    if (mode === "isolated") h.controls.isolated = true;
    if (mode === "read-only") Object.assign(h.engine, { readOnlyMode: true });
    await expect(h.engine.reloadModelAsset("instance", manifest("asset-old"))).rejects.toThrow();
    expect(h.gltfLoader.loadAsync).not.toHaveBeenCalled();
  });

  it("rejects ifc/fragments reload without touching storage", async () => {
    const h = modelInstanceHarness();
    await expect(h.engine.reloadModelAsset("instance", { ...manifest("asset-old"), viewerKind: "ifc" })).rejects.toThrow("IFC/Fragments");
    expect(h.gltfLoader.loadAsync).not.toHaveBeenCalled();
  });

  it("discards a stale reload candidate when the instance changed during loading", async () => {
    const h = modelInstanceHarness();
    const candidate = modelObject();
    const pending = deferred<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>();
    h.gltfLoader.loadAsync.mockReturnValue(pending.promise);
    const operation = h.engine.reloadModelAsset("instance", manifest("asset-old"));
    h.models.delete("instance");
    pending.resolve({ scene: candidate, animations: [] });
    await expect(operation).rejects.toMatchObject({ name: "ModelLoadSupersededError" });
    expect(h.disposeObject).toHaveBeenCalledExactlyOnceWith(candidate);
  });
});
