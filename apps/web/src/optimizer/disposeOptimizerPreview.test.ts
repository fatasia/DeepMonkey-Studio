import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { disposeOptimizerPreview } from "./disposeOptimizerPreview";

describe("optimizer owned preview resources", () => {
  it("releases shared geometry/material/textures/bitmaps exactly once across loaded scenes", () => {
    const bitmap = { close: vi.fn() }; const texture = new THREE.Texture(bitmap as never);
    const geometry = new THREE.BoxGeometry(); const material = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture });
    const first = new THREE.Group().add(new THREE.Mesh(geometry, [material, material]));
    const second = new THREE.Group().add(new THREE.Mesh(geometry, material));
    const disposeTexture = vi.spyOn(texture, "dispose"), disposeGeometry = vi.spyOn(geometry, "dispose"), disposeMaterial = vi.spyOn(material, "dispose");
    disposeOptimizerPreview([first, second]);
    expect(disposeTexture).toHaveBeenCalledOnce(); expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce(); expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("also frees grid line geometry and materials", () => {
    const grid = new THREE.GridHelper(); const geometry = vi.spyOn(grid.geometry, "dispose");
    disposeOptimizerPreview([grid]); expect(geometry).toHaveBeenCalledOnce();
  });
});
