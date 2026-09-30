import * as THREE from "three";
import { ThreeProjectionBridge } from "../src/threeBridge/ThreeProjectionBridge.js";
import { projectThreeWorldLights } from "../src/threeBridge/threeWorldLights.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";

export const sharedProfile = Object.freeze({ width: 320, height: 192, exposures: [.5, 2],
  cameras: [{ name: "front", eye: [0, 0, 9] }, { name: "oblique", eye: [3, 2, 9] }],
  target: [0, 0, 0], up: [0, 1, 0], verticalFovRadians: Math.PI / 4, near: .1, far: 100,
  toneMapping: "three-aces-r185", colorSpace: "srgb", radiance: [1, .95, .9], intensity: 3,
  lightPosition: [-3, 4, 5], authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0 } },
  emission: [[.03, .15, .8], [.5, .08, .02], [.1, .65, .15], [.8, .4, .1], [.2, .05, .7], [.08, .3, .55]] });
export type SharedStage = "strict-emissive" | "direct-diagnostic";

export function sharedProjection() {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  } });
}

export function createSharedSceneFixture() {
  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const geometries = [new THREE.SphereGeometry(.65, 24, 16), new THREE.BoxGeometry(1.05, 1.05, 1.05)];
  const materials: THREE.MeshStandardMaterial[] = [];
  for (let index = 0; index < 6; index++) {
    const emission = sharedProfile.emission[index]!;
    const material = new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(emission[0]!, emission[1]!, emission[2]!),
      roughness: [.15, .55, .9][index % 3]!, metalness: [0, .5, 1][index % 3]! }); materials.push(material);
    const mesh = new THREE.Mesh(geometries[index % 2]!, material); mesh.name = `fixture-${index}`;
    mesh.position.set((index % 3 - 1) * 2, index < 3 ? 1 : -1, 0);
    if (index % 2) mesh.rotation.set(.15, .3, .08);
    root.add(mesh);
  }
  const light = new THREE.DirectionalLight(new THREE.Color(...sharedProfile.radiance as [number, number, number]), sharedProfile.intensity);
  light.position.fromArray(sharedProfile.lightPosition); light.visible = false; light.castShadow = false;
  scene.add(light, light.target); scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(45, sharedProfile.width / sharedProfile.height, sharedProfile.near, sharedProfile.far);
  function setStage(stage: SharedStage) {
    light.visible = stage === "direct-diagnostic";
    materials.forEach((material, index) => material.color.setRGB(stage === "strict-emissive" ? 0 : .45,
      stage === "strict-emissive" ? 0 : .2 + (index % 3) * .1, stage === "strict-emissive" ? 0 : .12));
    scene.updateMatrixWorld(true);
  }
  function view(cameraIndex: number, exposure: number): RenderView {
    const eye = sharedProfile.cameras[cameraIndex]!.eye as [number, number, number]; camera.position.fromArray(eye); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
    const lights = projectThreeWorldLights(scene, { cameraLayerMask: 1 }); if (!lights.ok) throw Error(JSON.stringify(lights.issues));
    return { eye, target: [0, 0, 0], up: [0, 1, 0], extent: 4, background: [0, 0, 0], floor: [0, 0, 0],
      width: sharedProfile.width, height: sharedProfile.height, pixelRatio: 1, exposure, roughness: .5, environmentIntensity: 0, fog: null,
      verticalFovRadians: sharedProfile.verticalFovRadians, near: sharedProfile.near, far: sharedProfile.far, lights: lights.lights,
      authorColorEffects: sharedProfile.authorColorEffects };
  }
  function rootHash() {
    return sha256Utf8(JSON.stringify(root.children.map(object => {
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      return { name: mesh.name, matrix: mesh.matrixWorld.elements, position: Array.from(mesh.geometry.attributes.position!.array),
        normal: Array.from(mesh.geometry.attributes.normal!.array), indices: Array.from(mesh.geometry.index!.array),
        color: mesh.material.color.toArray(), emission: mesh.material.emissive.toArray(), roughness: mesh.material.roughness, metal: mesh.material.metalness };
    })));
  }
  return { scene, root, camera, materials, setStage, view, rootHash,
    dispose() { materials.forEach(material => material.dispose()); geometries.forEach(geometry => geometry.dispose()); } };
}
