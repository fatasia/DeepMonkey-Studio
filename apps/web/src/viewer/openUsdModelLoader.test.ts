import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOpenUsdModel } from "./openUsdModelLoader";
import {
  OFFICIAL_GEOM_USDC_BASE64,
  OFFICIAL_SKINNED_ARM_USDA,
  OFFICIAL_SIMPLE_MESH_USDZ_BASE64,
  OFFICIAL_SPHERE_USDA,
} from "./openUsdOfficialSamples";

afterEach(() => vi.unstubAllGlobals());

describe("official Three.js USDLoader integration", () => {
  it.each([
    ["Sphere.usda", new TextEncoder().encode(OFFICIAL_SPHERE_USDA), 1, 960, 0],
    ["skinnedArm.usda", new TextEncoder().encode(OFFICIAL_SKINNED_ARM_USDA), 1, 20, 1],
    ["geom.usdc", decodeBase64(OFFICIAL_GEOM_USDC_BASE64), 5, 3_276, 0],
    ["simpleMesh.usdz", decodeBase64(OFFICIAL_SIMPLE_MESH_USDZ_BASE64), 1, 12, 0],
  ])("loads licensed OpenUSD sample %s through the viewer asset boundary", async (name, bytes, minimumMeshes, triangles, animations) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    const loaded = await loadOpenUsdModel(`/assets/openusd/${name}?revision=1`);
    const evidence = inspect(loaded.object);

    expect(evidence.meshes).toBeGreaterThanOrEqual(minimumMeshes);
    expect(evidence.triangles).toBe(triangles);
    expect(evidence.materials).toBeGreaterThanOrEqual(minimumMeshes);
    expect(evidence.namedNodes).toBeGreaterThan(0);
    expect(loaded.animations).toHaveLength(animations);
    expect(loaded.object.name).toBe(name);
  });

  it("reports transport failures before parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    await expect(loadOpenUsdModel("/assets/missing.usdc")).rejects.toThrow("OpenUSD 下载失败：404");
  });
});

function inspect(root: THREE.Object3D): { meshes: number; triangles: number; materials: number; namedNodes: number } {
  let meshes = 0;
  let triangles = 0;
  let materials = 0;
  let namedNodes = 0;
  root.traverse((object) => {
    if (object.name) namedNodes += 1;
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute("position");
    if (!positions) return;
    meshes += 1;
    triangles += Math.floor((object.geometry.getIndex()?.count ?? positions.count) / 3);
    materials += Array.isArray(object.material) ? object.material.length : 1;
  });
  return { meshes, triangles, materials, namedNodes };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
