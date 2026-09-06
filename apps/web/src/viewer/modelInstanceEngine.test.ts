import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { captureSceneModelState } from "./captureSceneModelState";
import { deferred, manifest, modelInstanceHarness, modelObject } from "./modelInstanceEngineTestFixture";

describe("independent model instance loading", () => {
  it("loads the same resource into two independent identities and deduplicates only a matching instance", async () => {
    const h = modelInstanceHarness();
    const source = manifest("shared");
    const [a, b] = await Promise.all([h.engine.loadManifest(source, "a"), h.engine.loadManifest(source, "b")]);
    expect(a.id).toBe("a"); expect(b.id).toBe("b");
    expect(a.assetModelId).toBe("shared"); expect(b.assetModelId).toBe("shared");
    expect(a.object).not.toBe(b.object);
    a.object.position.x = 17;
    expect(b.object.position.x).toBe(0);
    expect(await h.engine.loadManifest(source, "a")).toBe(a);
    expect(h.gltfLoader.loadAsync).toHaveBeenCalledTimes(2);
    expect(h.fitAll).not.toHaveBeenCalled();
    expect(source.modelId).toBe("shared");
    await expect(h.engine.loadManifest(manifest("other"), "a")).rejects.toThrow("替换");
  });

  it("keeps the legacy default identity and does not add resource fields to legacy snapshots", async () => {
    const h = modelInstanceHarness();
    const loaded = await h.engine.loadManifest(manifest("legacy"));
    expect(loaded.id).toBe("legacy");
    expect(captureSceneModelState(h.engine, loaded)).not.toHaveProperty("assetModelId");
  });
});

describe("model resource replacement transaction", () => {
  it("keeps the current instance mounted when the candidate request fails", async () => {
    const h = modelInstanceHarness();
    const pending = deferred<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>();
    h.gltfLoader.loadAsync.mockReturnValue(pending.promise);
    const operation = h.engine.replaceModelManifest("instance", manifest());
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.removeModel).not.toHaveBeenCalled();
    pending.reject(new Error("network unavailable"));
    await expect(operation).rejects.toThrow("network unavailable");
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.removeModel).not.toHaveBeenCalled();
  });

  it("rejects incompatible subcomponents and releases only the candidate", async () => {
    const h = modelInstanceHarness();
    const candidate = modelObject("different-part");
    h.gltfLoader.loadAsync.mockResolvedValue({ scene: candidate, animations: [] });
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("结构不兼容");
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.removeModel).not.toHaveBeenCalled();
    expect(h.disposeObject).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it.each(["locked", "isolated", "read-only"])("does not load a candidate when initially %s", async mode => {
    const h = modelInstanceHarness();
    if (mode === "locked") h.controls.locked = true;
    if (mode === "isolated") h.controls.isolated = true;
    if (mode === "read-only") Object.assign(h.engine, { readOnlyMode: true });
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow();
    expect(h.gltfLoader.loadAsync).not.toHaveBeenCalled();
    expect(h.removeModel).not.toHaveBeenCalled();
  });

  it.each(["locked", "isolated", "read-only"])("does not commit if the scene becomes %s during loading", async mode => {
    const h = modelInstanceHarness();
    const candidate = modelObject();
    const pending = deferred<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>();
    h.gltfLoader.loadAsync.mockReturnValue(pending.promise);
    const operation = h.engine.replaceModelManifest("instance", manifest());
    if (mode === "locked") h.controls.locked = true;
    if (mode === "isolated") h.controls.isolated = true;
    if (mode === "read-only") Object.assign(h.engine, { readOnlyMode: true });
    pending.resolve({ scene: candidate, animations: [] });
    await expect(operation).rejects.toThrow();
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.removeModel).not.toHaveBeenCalled();
    expect(h.disposeObject).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it.each(["scene-switch", "instance-removed", "instance-replaced"])("discards a candidate after %s", async mode => {
    const h = modelInstanceHarness();
    const candidate = modelObject();
    const pending = deferred<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>();
    h.gltfLoader.loadAsync.mockReturnValue(pending.promise);
    const operation = h.engine.replaceModelManifest("instance", manifest());
    if (mode === "scene-switch") h.modelLoads.invalidate();
    if (mode === "instance-removed") h.models.delete("instance");
    if (mode === "instance-replaced") h.models.set("instance", { ...h.original, object: modelObject() });
    const expected = h.models.get("instance");
    pending.resolve({ scene: candidate, animations: [] });
    await expect(operation).rejects.toMatchObject({ name: "ModelLoadSupersededError" });
    expect(h.models.get("instance")).toBe(expected);
    expect(h.removeModel).not.toHaveBeenCalled();
    expect(h.disposeObject).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it("retains author state, current selection, camera, and every other instance floor", async () => {
    const h = modelInstanceHarness();
    const unrelated = { modelId: "other", level: "second", visible: true, expansion: 5 };
    const retainedFloor = { modelId: "instance", level: "first", visible: false, expansion: 3 };
    h.floors.set("other:second", unrelated);
    h.floors.set("instance:first", retainedFloor);
    const before = captureSceneModelState(h.engine, h.original)!;
    const camera = h.camera.position.toArray();
    const result = await h.engine.replaceModelManifest("instance", manifest());
    expect(result.id).toBe("instance"); expect(result.assetModelId).toBe("asset-new");
    expect(result.name).toBe(h.original.name);
    expect(h.applied.get("instance")).toEqual(before);
    expect(result.object.position.toArray()).toEqual([7, 2, 3]);
    expect(result.object.scale.toArray()).toEqual([2, 3, 4]);
    expect(h.floors.get("other:second")).toBe(unrelated);
    expect(h.floors.get("instance:first")).toEqual(retainedFloor);
    expect(h.controls.selected).toBe("instance"); expect(h.controls.selectedLayer).toBe("root/0");
    expect(h.camera.position.toArray()).toEqual(camera);
    expect(h.fitAll).not.toHaveBeenCalled();
    expect(h.gltfLoader.loadAsync).toHaveBeenCalledExactlyOnceWith("/asset-new.glb");
  });

  it("captures state edited while the candidate is loading", async () => {
    const h = modelInstanceHarness();
    const pending = deferred<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>();
    h.gltfLoader.loadAsync.mockReturnValue(pending.promise);
    const operation = h.engine.replaceModelManifest("instance", manifest());
    h.original.object.position.x = 23;
    h.original.name = "等待期间的新名称";
    pending.resolve({ scene: modelObject(), animations: [] });
    const result = await operation;
    expect(result.object.position.x).toBe(23);
    expect(result.name).toBe("等待期间的新名称");
  });

  it("preserves selection of another instance subcomponent during replacement", async () => {
    const h = modelInstanceHarness();
    h.models.set("other", { ...h.original, id: "other", object: modelObject() });
    h.controls.selected = "other"; h.controls.selectedLayer = "root/0";
    await h.engine.replaceModelManifest("instance", manifest());
    expect(h.controls.selected).toBe("other");
    expect(h.controls.selectedLayer).toBe("root/0");
  });

  it("preserves component paths when the original was loaded through a progressive LOD container", async () => {
    const h = modelInstanceHarness();
    Object.assign(h.engine, { streamGltfLevels: vi.fn() });
    h.gltfLoader.loadAsync.mockImplementation(async () => {
      const object = modelObject(); object.name = "source-scene";
      return { scene: object, animations: [] };
    });
    const original = await h.engine.loadManifest({ ...manifest("lod-source"), lods: [{ level: "low", ratio: 0.1, url: "/low.glb" }] }, "lod-instance");
    expect(original.object.children[0]!.children[0]!.name).toBe("part");
    h.fitAll.mockClear();
    const replacement = { ...manifest("full-replacement"), lods: [{ level: "low" as const, ratio: 0.1, url: "/replacement-low.glb" }] };
    const replaced = await h.engine.replaceModelManifest("lod-instance", replacement);
    expect(replaced.id).toBe("lod-instance");
    expect(replaced.object.children[0]!.children[0]!.name).toBe("part");
    expect(h.fitAll).not.toHaveBeenCalled();
    expect(h.gltfLoader.loadAsync.mock.calls.map(call => call[0])).toEqual(["/low.glb", "/full-replacement.glb"]);
  });

  it("rejects a container topology change that would lose component paths after reload", async () => {
    const h = modelInstanceHarness();
    Object.assign(h.engine, { streamGltfLevels: vi.fn() });
    const original = await h.engine.loadManifest({ ...manifest("lod-source"), lods: [{ level: "low", ratio: 0.1, url: "/low.glb" }] }, "lod-instance");
    await expect(h.engine.replaceModelManifest("lod-instance", manifest("no-lod"))).rejects.toThrow("结构不兼容");
    expect(h.models.get("lod-instance")).toBe(original);
    expect(h.removeModel).not.toHaveBeenCalled();
  });

  it("does not accept changed UUID identities of unnamed animation clips", async () => {
    const h = modelInstanceHarness();
    const previous = new THREE.AnimationClip("", 1, []);
    const candidate = new THREE.AnimationClip("", 1, []);
    h.animationClips.set("instance", [previous]);
    h.gltfLoader.loadAsync.mockResolvedValue({ scene: modelObject(), animations: [candidate] });
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("动画");
    expect(h.models.get("instance")).toBe(h.original);
    expect(h.removeModel).not.toHaveBeenCalled();
  });

  it("preserves the source when a named animation clip is missing", async () => {
    const h = modelInstanceHarness();
    h.animationClips.set("instance", [new THREE.AnimationClip("walk", 1, [])]);
    await expect(h.engine.replaceModelManifest("instance", manifest())).rejects.toThrow("动画");
    expect(h.removeModel).not.toHaveBeenCalled();
  });
});

describe("scene model state capture", () => {
  it("returns detached author state with resource identity separate from object identity", () => {
    const h = modelInstanceHarness();
    const snapshot = captureSceneModelState(h.engine, h.original)!;
    expect(snapshot).toMatchObject({ modelId: "instance", assetModelId: "asset-old", visible: false, opacity: 0.45, collisionEnabled: true, explosionFactor: 0.6 });
    h.state.material.roughness = 0.9;
    h.state.layers[0]!.opacity = 1;
    h.original.object.position.x = 0;
    expect(snapshot.material?.roughness).toBe(0.3);
    expect(snapshot.layers?.[0]?.opacity).toBe(0.6);
    expect(snapshot.transform.position.x).toBe(7);
  });
});
