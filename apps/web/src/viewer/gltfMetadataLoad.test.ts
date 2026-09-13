import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { loadGltfWithMetadata } from "./gltfMetadataLoad";
import { closeSharedGltfPool, loadSharedGltf, sharedGltfLoadState } from "./sharedGltfAssets";
import { disposeViewerObject } from "./sceneOverlayVisuals";

describe("glTF and metadata ownership", () => {
  it("releases the real shared clone if properties fail, including a geometry result that arrives later", async () => {
    const owner = {}, scene = new THREE.Group(), geometry = new THREE.BoxGeometry();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
    const gltf = { scene, scenes: [scene], animations: [] } as unknown as GLTF;
    let resolve!: (value: GLTF) => void;
    const loader = { loadAsync: () => new Promise<GLTF>(done => { resolve = done; }) };
    const disposed = vi.spyOn(geometry, "dispose");
    const pending = loadGltfWithMetadata(() => loadSharedGltf(owner, loader, "/broken-properties.glb"), async () => { throw new Error("properties 404"); }, disposeViewerObject);
    await vi.waitFor(() => expect(resolve).toBeDefined()); resolve(gltf);
    await expect(pending).rejects.toThrow("properties 404");
    expect(sharedGltfLoadState(owner, "/broken-properties.glb")).toBe("miss");
    expect(disposed).toHaveBeenCalledOnce(); closeSharedGltfPool(owner); expect(disposed).toHaveBeenCalledOnce();
  });

  it("keeps ownership on success and does not dispose a nonexistent failed parse", async () => {
    const scene = new THREE.Group(), gltf = { scene } as GLTF, dispose = vi.fn();
    expect(await loadGltfWithMetadata(async () => gltf, async () => ({ schema: 1 }), dispose)).toEqual([gltf, { schema: 1 }]);
    await expect(loadGltfWithMetadata(async () => { throw new Error("bad glTF"); }, async () => undefined, dispose)).rejects.toThrow("bad glTF");
    expect(dispose).not.toHaveBeenCalled();
  });
});
