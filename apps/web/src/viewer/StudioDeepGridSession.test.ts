import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { StudioDeepGridSession } from "./StudioDeepGridSession";

function fixture() {
  const pixels = new Uint8ClampedArray(16).fill(128), getImageData = vi.fn(() => ({ data: pixels }));
  const canvas = { width: 2, height: 2, getContext: () => ({ getImageData }) };
  const texture = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), material); grid.name = "helper:grid"; grid.renderOrder = -10;
  grid.rotation.x = -Math.PI / 2; grid.updateMatrixWorld(true);
  const owner = new StudioDeepGridSession(), camera = new THREE.PerspectiveCamera();
  return { owner, grid, camera, canvas, pixels, texture, material, getImageData, read: (composer = true) => owner.read(grid, camera, composer) };
}
describe("Studio fixed author grid projection", () => {
  it("owns texture bytes and caches only unchanged source versions/dimensions", () => {
    const f = fixture(), first = f.read()!; f.pixels[0] = 0;
    expect(first.texture.data[0]).toBe(128); expect(f.read()!.texture).toBe(first.texture);
    f.texture.needsUpdate = true; expect(f.read()!.texture.data[0]).toBe(0);
    expect(f.getImageData).toHaveBeenCalledTimes(2); f.owner.dispose(); f.read(); expect(f.getImageData).toHaveBeenCalledTimes(3);
  });
  it("invalidates same-version image/sampler changes and rejects unsupported dimensions or edited geometry", () => {
    const f = fixture(), first = f.read()!;
    f.texture.anisotropy = 4; expect(f.read()!.texture).not.toBe(first.texture);
    const second = f.read()!.texture;
    f.texture.image = { ...f.canvas } as unknown as HTMLCanvasElement; expect(f.read()!.texture).not.toBe(second);
    f.texture.image.width = 3; expect(() => f.read()).toThrow("尺寸"); f.texture.image.width = 2;
    f.grid.geometry.getAttribute("position").setX(0, 99); expect(() => f.read()).toThrow("顶点");
  });
  it("follows visibility, layers, matrix, color and close-up opacity without author mutation", () => {
    const f = fixture(), first = f.read()!; f.material.opacity = 0.1; f.grid.position.y = 2; f.grid.updateMatrixWorld(true);
    const next = f.read()!; expect(next.color[3]).toBe(0.1); expect(next.model[13]).toBe(2); expect(first.model[13]).toBe(0);
    f.grid.layers.set(2); expect(f.read()).toBeUndefined(); f.camera.layers.enable(2); expect(f.read()).toBeDefined();
    const parent = new THREE.Group(); parent.add(f.grid); parent.visible = false; expect(f.read()).toBeUndefined();
    expect(f.grid.parent).toBe(parent);
  });
  it("rejects unsupported color paths, bad transforms, material drift and tainted pixels", () => {
    const f = fixture(); expect(() => f.read(false)).toThrow("WebGL");
    f.grid.matrixWorld.elements[0] = NaN; expect(() => f.read()).toThrow("矩阵"); f.grid.updateMatrixWorld(true);
    f.material.depthWrite = true; expect(() => f.read()).toThrow("合同"); f.material.depthWrite = false;
    f.getImageData.mockImplementationOnce(() => { throw new Error("tainted"); }); expect(() => f.read()).toThrow("tainted");
    expect(f.read()).toBeDefined();
  });
});
