import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { rendererPipelineSignature } from "./rendererPipelineSignature";

describe("rendererPipelineSignature", () => {
  it("reuses a pipeline when only object identity and color change", () => {
    const first = primitiveScene("#ff0000");
    const second = primitiveScene("#00ff00");
    expect(rendererPipelineSignature(first, "webgpu")).toBe(rendererPipelineSignature(second, "webgpu"));
  });

  it("distinguishes shader-affecting geometry and texture features", () => {
    const scene = primitiveScene("#ff0000");
    const baseline = rendererPipelineSignature(scene, "webgl");
    const mesh = scene.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    mesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Array(24).fill(1), 3));
    mesh.material.vertexColors = true;
    expect(rendererPipelineSignature(scene, "webgl")).not.toBe(baseline);

    const withTexture = primitiveScene("#ff0000");
    (withTexture.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.map = new THREE.Texture();
    expect(rendererPipelineSignature(withTexture, "webgl")).not.toBe(baseline);
  });

  it("includes the authored quality profile in the renderer identity", () => {
    const scene = primitiveScene("#ff0000");
    const baseline = rendererPipelineSignature(scene, "webgpu");
    const postProcessing = { enabled: true, smaa: true, ssao: false, ssaoIntensity: 1, bloom: false, bloomStrength: 0.35, bloomThreshold: 0.9, qualityProfile: "quality" as const };
    const quality = rendererPipelineSignature(scene, "webgpu", postProcessing);
    expect(quality).not.toBe(baseline);
  });
});

function primitiveScene(color: string): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#111111");
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return scene;
}
