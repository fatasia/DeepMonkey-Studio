import * as THREE from "three";
import type { OffscreenSceneInventory } from "./offscreenSceneCompatibility";
import type { OffscreenContext, OffscreenFrame, OffscreenJson } from "./offscreenRenderProtocol";
import { offscreenSerializationMeta } from "./offscreenSceneSnapshot";
import type { JSONMeta } from "three/src/core/Object3D.js";

export class OffscreenFrameCollector {
  private objects = new Map<string, string>();
  private materials = new Map<string, string>();
  collect(context: OffscreenContext, inventory: OffscreenSceneInventory, sequence: number, collectMaterials = true): OffscreenFrame {
    context.scene.updateMatrixWorld(true); context.camera.updateWorldMatrix(true, false);
    const objects: OffscreenFrame["objects"] = []; const materials: OffscreenJson[] = [];
    for (const object of inventory.objects.values()) {
      const matrix = object.matrix.toArray(); const signature = `${matrix}:${object.visible}:${object.layers.mask}:${object.renderOrder}`;
      if (this.objects.get(object.uuid) !== signature) {
        objects.push({ uuid: object.uuid, matrix, visible: object.visible, layers: object.layers.mask, renderOrder: object.renderOrder }); this.objects.set(object.uuid, signature);
      }
    }
    // material.toJSON + JSON.stringify 逐帧全量成本过高；未采样帧跳过材质，Worker 保留上次应用的材质。
    if (collectMaterials) {
      const meta = offscreenSerializationMeta(inventory) as JSONMeta;
      for (const material of inventory.materials.values()) {
        const json = material.toJSON(meta) as unknown as OffscreenJson; delete json.userData; delete json.metadata;
        const signature = JSON.stringify(json);
        if (this.materials.get(material.uuid) !== signature) { materials.push(json); this.materials.set(material.uuid, signature); }
      }
    }
    const renderer = context.renderer as THREE.WebGLRenderer;
    return { sequence, width: context.width, height: context.height, pixelRatio: renderer.getPixelRatio(), delta: context.delta,
      camera: { matrix: context.camera.matrixWorld.toArray(), projection: context.camera.projectionMatrix.toArray(), near: context.camera.near, far: context.camera.far, fov: context.camera.fov, aspect: context.camera.aspect },
      objects, materials, postProcessing: structuredClone(context.postProcessing), outlined: [...context.outlined],
      renderer: { outputColorSpace: renderer.outputColorSpace, toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
        shadowEnabled: renderer.shadowMap.enabled, shadowType: renderer.shadowMap.type, clearColor: renderer.getClearColor(new THREE.Color()).getHex(), clearAlpha: renderer.getClearAlpha() } };
  }
}

/** 单在途时合并增量，而非只替换最后一帧，避免遗漏中间帧的物体变化。 */
export function mergeOffscreenFrames(previous: OffscreenFrame | undefined, latest: OffscreenFrame): OffscreenFrame {
  if (!previous) return latest;
  const objects = new Map(previous.objects.map(object => [object.uuid, object]));
  for (const object of latest.objects) objects.set(object.uuid, object);
  const materials = new Map(previous.materials.map(material => [material.uuid, material]));
  for (const material of latest.materials) materials.set(material.uuid, material);
  return { ...latest, objects: [...objects.values()], materials: [...materials.values()] };
}

export function applyOffscreenFrame(scene: THREE.Scene, camera: THREE.PerspectiveCamera, frame: OffscreenFrame): void {
  const objects = new Map<string, THREE.Object3D>(); const materials = new Map<string, THREE.Material>(); const textures: Record<string, THREE.Texture> = {};
  scene.traverse(object => {
    objects.set(object.uuid, object); const assigned = (object as THREE.Mesh).material;
    for (const material of assigned ? Array.isArray(assigned) ? assigned : [assigned] : []) {
      materials.set(material.uuid, material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures[value.uuid] = value;
    }
  });
  for (const update of frame.objects) {
    const object = objects.get(update.uuid); if (!object) throw new Error("Scene update is stale");
    object.matrixAutoUpdate = false; object.matrix.fromArray(update.matrix); object.matrixWorldNeedsUpdate = true;
    object.visible = update.visible; object.layers.mask = update.layers; object.renderOrder = update.renderOrder;
  }
  const loader = new THREE.MaterialLoader().setTextures(textures);
  for (const update of frame.materials) {
    const material = materials.get(String(update.uuid)); if (!material) throw new Error("Material update is stale");
    const parsed = loader.parse(update); material.copy(parsed); material.needsUpdate = true; parsed.dispose();
  }
  camera.matrixAutoUpdate = false; camera.matrix.fromArray(frame.camera.matrix); camera.matrixWorldNeedsUpdate = true;
  camera.projectionMatrix.fromArray(frame.camera.projection); camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.near = frame.camera.near; camera.far = frame.camera.far; camera.fov = frame.camera.fov; camera.aspect = frame.camera.aspect;
}
