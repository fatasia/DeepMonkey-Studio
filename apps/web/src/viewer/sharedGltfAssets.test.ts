import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { closeSharedGltfPool, detachSharedGltfResources, loadSharedGltf, sharedGltfLoadState } from "./sharedGltfAssets";
import { disposeViewerObject } from "./sceneOverlayVisuals";

function asset() {
  const texture = new THREE.Texture();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture });
  const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, material));
  return { gltf: { scene, scenes: [scene], animations: [] } as unknown as GLTF, geometry, material, texture };
}

describe("shared glTF assets", () => {
  it("coalesces parsing while keeping instance trees and materials independent", async () => {
    const owner = {}, source = asset(), loader = { loadAsync: vi.fn(async () => source.gltf) };
    expect(sharedGltfLoadState(owner,"/device.glb","v1")).toBe("miss");
    const firstLoad = loadSharedGltf(owner,loader,"/device.glb","v1");
    expect(sharedGltfLoadState(owner,"/device.glb","v1")).toBe("pending");
    const [a,b] = await Promise.all([firstLoad,loadSharedGltf(owner,loader,"/device.glb","v1")]);
    expect(sharedGltfLoadState(owner,"/device.glb","v1")).toBe("ready");
    expect(loader.loadAsync).toHaveBeenCalledTimes(1);
    const first = a.scene.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
    const second = b.scene.children[0] as typeof first;
    expect(first).not.toBe(second); expect(first.geometry).toBe(second.geometry);
    expect(first.material).not.toBe(second.material); expect(first.material.map).toBe(second.material.map);
    first.material.color.set("red"); first.position.x = 42;
    expect(second.material.color.getHex()).toBe(0xffffff); expect(second.position.x).toBe(0);
    disposeViewerObject(a.scene); disposeViewerObject(b.scene);
  });

  it("keeps shared GPU resources until the final instance is retired", async () => {
    const owner = {}, source = asset(), loader = { loadAsync: vi.fn(async () => source.gltf) };
    const geometryDispose = vi.spyOn(source.geometry,"dispose"), textureDispose = vi.spyOn(source.texture,"dispose");
    const a = await loadSharedGltf(owner,loader,"/device.glb"), b = await loadSharedGltf(owner,loader,"/device.glb");
    disposeViewerObject(a.scene); expect(geometryDispose).not.toHaveBeenCalled(); expect(textureDispose).not.toHaveBeenCalled();
    disposeViewerObject(b.scene); expect(geometryDispose).toHaveBeenCalledTimes(1); expect(textureDispose).toHaveBeenCalledTimes(1);
    closeSharedGltfPool(owner); expect(geometryDispose).toHaveBeenCalledTimes(1);
  });

  it("isolates mutable raw-object access from other instances", async () => {
    const owner = {}, source = asset(), loader = { loadAsync: vi.fn(async () => source.gltf) };
    const a = await loadSharedGltf(owner,loader,"/device.glb"), b = await loadSharedGltf(owner,loader,"/device.glb");
    detachSharedGltfResources(a.scene);
    const first = a.scene.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
    const second = b.scene.children[0] as typeof first;
    expect(first.geometry).not.toBe(second.geometry); expect(first.material.map).not.toBe(second.material.map);
    first.geometry.translate(100,0,0); first.material.map!.repeat.set(4,4);
    expect(second.geometry.getAttribute("position").getX(0)).toBeLessThan(1);
    expect(second.material.map!.repeat.x).toBe(1);
    disposeViewerObject(a.scene); disposeViewerObject(b.scene);
  });

  it("does not share across asset versions or viewer owners", async () => {
    const owner = {}, loader = { loadAsync: vi.fn(async () => asset().gltf) };
    const a = await loadSharedGltf(owner,loader,"/same.glb","v1");
    const b = await loadSharedGltf(owner,loader,"/same.glb","v2");
    const c = await loadSharedGltf({},loader,"/same.glb","v1");
    expect(loader.loadAsync).toHaveBeenCalledTimes(3);
    [a,b,c].forEach(gltf=>disposeViewerObject(gltf.scene));
  });

  it("isolates raw DataTexture pixels, compressed mipmaps and Source ownership", async () => {
    const source = asset(), owner = {};
    const pixels = new THREE.DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1);
    const compressed = new THREE.CompressedTexture([{ data: new Uint8Array([4, 5, 6, 7]), width: 4, height: 4 }], 4, 4, THREE.RGBA_S3TC_DXT1_Format);
    source.material.map = pixels; source.material.normalMap = compressed;
    const loader = { loadAsync: async () => source.gltf };
    const a = await loadSharedGltf(owner, loader, "/pixels.glb"), b = await loadSharedGltf(owner, loader, "/pixels.glb");
    detachSharedGltfResources(a.scene);
    const first = (a.scene.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
    const second = (b.scene.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
    const firstPixels = first.map as THREE.DataTexture, secondPixels = second.map as THREE.DataTexture;
    expect(firstPixels.source).not.toBe(secondPixels.source);
    firstPixels.image.data![0] = 200;
    expect(secondPixels.image.data![0]).toBe(1);
    const firstMips = (first.normalMap as THREE.CompressedTexture).mipmaps;
    (firstMips[0]!.data as Uint8Array)[0] = 201;
    expect(((second.normalMap as THREE.CompressedTexture).mipmaps[0]!.data as Uint8Array)[0]).toBe(4);
    const sourceVersion = secondPixels.source.version;
    firstPixels.needsUpdate = true; expect(secondPixels.source.version).toBe(sourceVersion);
    disposeViewerObject(a.scene); disposeViewerObject(b.scene);
  });

  it("retries a failed parse and disposes a load completing after viewer close", async () => {
    const owner = {}, source = asset();
    let resolve!: (gltf:GLTF)=>void;
    const loader = { loadAsync: vi.fn().mockRejectedValueOnce(new Error("bad file"))
      .mockImplementationOnce(()=>new Promise<GLTF>(done=>{resolve=done;})) };
    await expect(loadSharedGltf(owner,loader,"/device.glb")).rejects.toThrow("bad file");
    const geometryDispose = vi.spyOn(source.geometry,"dispose");
    const pending = loadSharedGltf(owner,loader,"/device.glb");
    closeSharedGltfPool(owner); resolve(source.gltf);
    await expect(pending).rejects.toThrow("查看器已关闭");
    expect(geometryDispose).toHaveBeenCalledOnce();
    await expect(loadSharedGltf(owner,loader,"/device.glb")).rejects.toThrow("查看器已关闭");
  });
});
