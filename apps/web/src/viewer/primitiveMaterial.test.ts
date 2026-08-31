import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { detachSharedPrimitiveMaterials, isSharedPrimitiveMaterial, PrimitiveMaterialCache, releaseSharedPrimitiveMaterials } from "./primitiveMaterial";

describe("PrimitiveMaterialCache", () => {
  it("reuses equivalent colors and releases the cache once", () => {
    const cache = new PrimitiveMaterialCache();
    const first = cache.get("#ff0000");
    const second = cache.get("rgb(255, 0, 0)");
    const disposed = vi.fn();
    first.addEventListener("dispose", disposed);
    expect(second).toBe(first);
    expect(isSharedPrimitiveMaterial(first)).toBe(true);
    cache.dispose();
    expect(disposed).toHaveBeenCalledOnce();
    expect(isSharedPrimitiveMaterial(first)).toBe(false);
  });

  it("clones a shared material before an object-level edit", () => {
    const cache = new PrimitiveMaterialCache();
    const shared = cache.get("#336699");
    const first = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const second = new THREE.Mesh(new THREE.BoxGeometry(), cache.get("#336699"));
    detachSharedPrimitiveMaterials(first);
    (first.material as THREE.MeshStandardMaterial).color.set("#ffffff");
    expect(first.material).not.toBe(shared);
    expect((second.material as THREE.MeshStandardMaterial).color.getHexString()).not.toBe("ffffff");
    cache.dispose();
  });

  it("keeps a released material available for the next scene", () => {
    const cache = new PrimitiveMaterialCache(1);
    const material = cache.get("#d6a94c");
    cache.get("#d6a94c");
    const disposed = vi.fn();
    material.addEventListener("dispose", disposed);
    releaseSharedPrimitiveMaterials(new THREE.Mesh(new THREE.BoxGeometry(), material));
    expect(disposed).not.toHaveBeenCalled();
    releaseSharedPrimitiveMaterials(new THREE.Mesh(new THREE.BoxGeometry(), material));
    expect(disposed).not.toHaveBeenCalled();
    expect(cache.get("#d6a94c")).toBe(material);
    cache.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("evicts only the oldest idle material when the bounded cache is full", () => {
    const cache = new PrimitiveMaterialCache(1);
    const first = cache.get("#d6a94c");
    const second = cache.get("#54a994");
    const firstDisposed = vi.fn();
    const secondDisposed = vi.fn();
    first.addEventListener("dispose", firstDisposed);
    second.addEventListener("dispose", secondDisposed);

    releaseSharedPrimitiveMaterials(new THREE.Mesh(new THREE.BoxGeometry(), first));
    releaseSharedPrimitiveMaterials(new THREE.Mesh(new THREE.BoxGeometry(), second));

    expect(firstDisposed).toHaveBeenCalledOnce();
    expect(secondDisposed).not.toHaveBeenCalled();
    expect(isSharedPrimitiveMaterial(first)).toBe(false);
    expect(cache.get("#54a994")).toBe(second);
    cache.dispose();
  });

  it("separates material generations so retired WebGPU render objects can be released", () => {
    const cache = new PrimitiveMaterialCache();
    const previous = cache.get("#557f9f");
    const previousDisposed = vi.fn();
    previous.addEventListener("dispose", previousDisposed);

    cache.beginSceneGeneration();
    const current = cache.get("#557f9f");
    releaseSharedPrimitiveMaterials(new THREE.Mesh(new THREE.BoxGeometry(), previous));

    expect(current).not.toBe(previous);
    expect(previousDisposed).toHaveBeenCalledOnce();
    expect(isSharedPrimitiveMaterial(current)).toBe(true);
    cache.dispose();
  });
});
