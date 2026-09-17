import { describe, expect, it } from "vitest";
import { MeshStandardMaterial } from "three";
import { applySourceMaterialOpacity } from "./sourceMaterialOpacity";

describe("source material opacity", () => {
  it("preserves imported alpha, transparency and depth policy at default scene opacity", () => {
    const material = new MeshStandardMaterial({ opacity: 0.3, transparent: true, depthWrite: false });
    applySourceMaterialOpacity(material, 1);
    expect([material.opacity, material.transparent, material.depthWrite]).toEqual([0.3, true, false]);
  });
  it("does not compound repeated visits to shared material and restores its source", () => {
    const material = new MeshStandardMaterial({ opacity: 0.3, transparent: true });
    for (let i = 0; i < 64; i++) applySourceMaterialOpacity(material, 0.5);
    expect(material.opacity).toBe(0.15);
    expect(material.depthWrite).toBe(false);
    applySourceMaterialOpacity(material, 1);
    expect([material.opacity, material.transparent, material.depthWrite]).toEqual([0.3, true, true]);
  });
  it("restores opaque and alpha-mask policies without marking them transparent", () => {
    const material = new MeshStandardMaterial({ alphaTest: 0.5 });
    applySourceMaterialOpacity(material, 0);
    expect([material.opacity, material.transparent, material.depthWrite]).toEqual([0, true, false]);
    applySourceMaterialOpacity(material, 1);
    expect([material.opacity, material.transparent, material.depthWrite, material.alphaTest]).toEqual([1, false, true, 0.5]);
  });
  it("bounds invalid factors without corrupting a separate source material", () => {
    const first = new MeshStandardMaterial({ opacity: 0.3, transparent: true });
    const second = new MeshStandardMaterial();
    applySourceMaterialOpacity(first, -1); applySourceMaterialOpacity(second, 2);
    expect([first.opacity, second.opacity]).toEqual([0, 1]);
    applySourceMaterialOpacity(first, NaN);
    expect(first.opacity).toBe(0.3);
  });
  it("only invalidates the shader when the transparency mode changes", () => {
    const material = new MeshStandardMaterial();
    const version = material.version;
    applySourceMaterialOpacity(material, 1);
    expect(material.version).toBe(version);
    applySourceMaterialOpacity(material, 0.5);
    expect(material.version).toBe(version + 1);
    for (let i = 0; i < 64; i++) applySourceMaterialOpacity(material, 0.25);
    expect(material.version).toBe(version + 1);
    applySourceMaterialOpacity(material, 1);
    expect(material.version).toBe(version + 2);
  });
  it("never enables depth writes disabled by the imported material", () => {
    const material = new MeshStandardMaterial({ depthWrite: false });
    for (const factor of [0, 0.5, 1, Infinity, -Infinity]) {
      applySourceMaterialOpacity(material, factor);
      expect(material.depthWrite).toBe(false);
    }
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
  });
});
