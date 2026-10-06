import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerEngine } from "./ViewerEngine";
import { cacheBustedUrl } from "./assetReloadUrls";

const TEXTURE_URL = "/assets/projects/p/assets/a/tex.png";

/** 构造带 managed 纹理的模型:userData.studioManagedTextureUrl 指向来源 URL。 */
function managedTexture(url: string, srgb: boolean): THREE.Texture {
  const texture = new THREE.Texture();
  texture.userData.studioManagedTextureUrl = url;
  texture.userData.studioManagedTextureSrgb = srgb;
  return texture;
}

function textureHarness(existing: THREE.Texture) {
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: existing }));
  const root = new THREE.Group();
  root.add(mesh);
  const models = new Map([["instance", { id: "instance", name: "m", object: root, kind: "model" as const, visible: true, opacity: 1 }]]);
  const fetched: Array<{ url: string; srgb: boolean }> = [];
  const loadedSource = new THREE.Texture();
  const loadMaterialTextureSource = vi.fn(async (url: string, isSrgb: boolean) => {
    fetched.push({ url, srgb: isSrgb });
    return loadedSource;
  });
  const markShadowMapDirty = vi.fn();
  Object.assign(engine, { models, loadMaterialTextureSource, markShadowMapDirty, collisionOriginalMaterials: new Map() });
  const material = mesh.material as THREE.MeshStandardMaterial;
  return { engine, material, fetched, loadedSource, loadMaterialTextureSource, markShadowMapDirty, disposeSpy: vi.spyOn(existing, "dispose") };
}

/** 纹理热重载(refreshManagedTextures):managed 纹理按干净 URL 匹配、击穿重取、写回干净 URL、失败保留。 */
describe("managed texture hot refresh", () => {
  it("swaps matching managed textures in place and writes the clean url back", async () => {
    const h = textureHarness(managedTexture(TEXTURE_URL, true));
    const report = await h.engine.refreshManagedTextures(TEXTURE_URL, "token-1");
    expect(report).toMatchObject({ url: TEXTURE_URL, refreshed: 1, failures: [] });
    expect(h.fetched).toEqual([{ url: cacheBustedUrl(TEXTURE_URL, "token-1"), srgb: true }]);
    const next = h.material.map!;
    expect(next).not.toBe(h.loadedSource);
    expect(next.userData.studioManagedTextureUrl).toBe(TEXTURE_URL);
    expect(next.userData.studioManagedTextureSrgb).toBe(true);
    expect(next.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(h.disposeSpy).toHaveBeenCalledTimes(1);
    expect(h.markShadowMapDirty).toHaveBeenCalledTimes(1);
  });

  it("keeps the old texture when the refetch fails", async () => {
    const h = textureHarness(managedTexture(TEXTURE_URL, false));
    h.loadMaterialTextureSource.mockRejectedValue(new Error("502"));
    const report = await h.engine.refreshManagedTextures(TEXTURE_URL, "token-2");
    expect(report.refreshed).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("502");
    expect(h.material.map?.userData.studioManagedTextureUrl).toBe(TEXTURE_URL);
    expect(h.disposeSpy).not.toHaveBeenCalled();
    expect(h.markShadowMapDirty).not.toHaveBeenCalled();
  });

  it("reports unused without fetching when no managed texture matches", async () => {
    const h = textureHarness(managedTexture("/other.png", true));
    const report = await h.engine.refreshManagedTextures(TEXTURE_URL, "token-3");
    expect(report.refreshed).toBe(0);
    expect(h.fetched).toEqual([]);
  });

  it("fetches at most once per colour-space for many materials sharing the url", async () => {
    const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
    const root = new THREE.Group();
    for (let index = 0; index < 3; index += 1) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: managedTexture("/t.png", true) }));
      root.add(mesh);
    }
    const fetched = vi.fn(async () => new THREE.Texture());
    Object.assign(engine, {
      models: new Map([["m", { id: "m", name: "m", object: root, kind: "model" as const, visible: true, opacity: 1 }]]),
      loadMaterialTextureSource: fetched,
      markShadowMapDirty: vi.fn(),
      collisionOriginalMaterials: new Map(),
    });
    const report = await engine.refreshManagedTextures("/t.png", "token-4");
    expect(report.refreshed).toBe(3);
    expect(fetched).toHaveBeenCalledTimes(1);
    const materials = root.children.map(child => (child as THREE.Mesh).material as THREE.MeshStandardMaterial);
    expect(new Set(materials.map(material => material.map)).size).toBe(3);
  });
});
