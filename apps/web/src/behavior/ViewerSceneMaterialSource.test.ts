import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ViewerEngine } from "../viewer/ViewerEngine";
import { SceneCommandExecutor } from "./SceneCommandExecutor";
import { ViewerSceneCommandPort } from "./ViewerSceneCommandPort";

const source = `shader deep.material {
  surface standard;
  baseColor [0.2, 0.4, 0.6, 1];
  metallic 0;
  roughness 0.5;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;

function fixture() {
  const viewer = Object.create(ViewerEngine.prototype) as ViewerEngine;
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: "#ffffff" });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  root.add(mesh);
  const model = { id: "box", object: root, kind: "primitive", visible: true };
  const internal = viewer as unknown as Record<string, unknown>;
  internal.models = new Map([["box", model]]);
  internal.modelMaterialOverrides = new Map();
  internal.collisionOriginalMaterials = new Map();
  internal.originalMaterialTextures = new Map();
  internal.modelScreenOriginals = new Map();
  internal.restoreModelEffectMaterials = () => {};
  internal.rebuildModelEffects = () => {};
  internal.markShadowMapDirty = () => {};
  internal.isModelLocked = () => false;
  internal.listModels = () => [model];
  // 换装后原材质被替换并释放;真实可观测面 = 网格当前材质 + override 数据态。
  const currentMaterial = () => (root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  return { viewer, currentMaterial, executor: new SceneCommandExecutor("scene", new ViewerSceneCommandPort(viewer)) };
}
const target = { kind: "object", sceneId: "scene", objectId: "box" } as const;

describe("material source author consumption", () => {
  it("writes a compiler-validated source through the real viewer override and snapshot readback", async () => {
    const { viewer, currentMaterial, executor } = fixture();
    const results = await executor.execute([{ id: "author", type: "material.set", target, patch: { customShader: { source } } }]);
    expect(results[0]?.success).toBe(true);
    expect(viewer.getModelMaterialOverride("box")?.customShader).toEqual({ source });
    const state = viewer.getModelMaterialState("box");
    expect(state?.customShader).toEqual({ source });
    expect(JSON.parse(JSON.stringify(state)).customShader).toEqual({ source });
    expect(currentMaterial().userData.studioCustomShader).toEqual({ source });
  });

  it("coated declarative source swaps the slot to Physical with real clearcoat (visible response path)", async () => {
    const { viewer, currentMaterial, executor } = fixture();
    const coated = source.replace("roughness 0.5;", "roughness 0.5;\n  clearcoatFactor 0.85;\n  clearcoatRoughness 0.08;");
    const results = await executor.execute([{ id: "coat", type: "material.set", target, patch: { customShader: { source: coated } } }]);
    expect(results[0]?.success).toBe(true);
    const swapped = currentMaterial() as unknown as THREE.MeshPhysicalMaterial;
    expect(swapped.isMeshPhysicalMaterial).toBe(true);
    expect(swapped.clearcoat).toBeCloseTo(0.85, 6);
    expect(swapped.clearcoatRoughness).toBeCloseTo(0.08, 6);
    expect(swapped.userData.studioUngradedColor).toBeTruthy();
  });

  it("clearing the source restores the original material class and drops the author tag", async () => {
    const { viewer, currentMaterial, executor } = fixture();
    await executor.execute([{ id: "coat", type: "material.set", target, patch: { customShader: { source } } }]);
    await executor.execute([{ id: "clear", type: "material.set", target, patch: { customShader: undefined } }]);
    const restored = currentMaterial() as unknown as THREE.Material & Record<string, unknown>;
    expect(restored.isMeshPhysicalMaterial ?? restored.isMeshBasicMaterial).toBeFalsy();
    expect(restored.userData.studioCustomShader).toBeUndefined();
    expect(viewer.getModelMaterialOverride("box")?.customShader).toBeUndefined();
  });

  it("rejects invalid source without overwriting an existing author source", async () => {
    const { viewer, currentMaterial, executor } = fixture();
    await executor.execute([{ id: "first", type: "material.set", target, patch: { customShader: { source } } }]);
    const before = viewer.getModelMaterialOverride("box");
    const materialBefore = currentMaterial();
    const results = await executor.execute([{ id: "bad", type: "material.set", target, patch: { color: "#ff0000", customShader: { source: "shader broken {" } } }]);
    expect(results[0]).toMatchObject({ success: false, code: "unsupported" });
    expect(viewer.getModelMaterialOverride("box")).toEqual(before);
    expect(currentMaterial()).toBe(materialBefore);
  });
});
