import * as THREE from "three";
import type { PbrRendererOptions } from "@bim-studio/deep-engine/webgpu";

/** Scheduling hints only: actual packet admission remains authoritative. No pixel/vertex reads. */
export function studioDeepPipelineHints(root: THREE.Object3D, cameraMask: number): PbrRendererOptions["pipelines"] | undefined {
  const staticKeys = new Set<string>(), posedKeys = new Set<string>();
  let unsupported = false;
  root.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !(object.layers.mask & cameraMask)) return;
    const posed = (mesh as THREE.SkinnedMesh).isSkinnedMesh === true
      || (mesh.morphTargetInfluences?.length ?? 0) > 0;
    const keys = posed ? posedKeys : staticKeys;
    for (const value of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const material = value as THREE.MeshPhysicalMaterial;
      if (!material.isMeshStandardMaterial && !(value as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
        unsupported = true; continue;
      }
      const textured = !!(material.map || material.normalMap || material.roughnessMap || material.metalnessMap
        || material.aoMap || material.emissiveMap || material.specularIntensityMap || material.specularColorMap)
        || (material.isMeshPhysicalMaterial && ((material.clearcoat ?? 0) > 0 || (material.transmission ?? 0) > 0
          || (material.sheen ?? 0) > 0 || (material.iridescence ?? 0) > 0 || (material.specularIntensity ?? 1) !== 1
          || (material.specularColor && material.specularColor.getHex() !== 0xffffff)));
      const mode = material.normalMap ? "normal" : textured ? "material" : "plain";
      const raster = material.side === THREE.DoubleSide ? "double" : object.matrixWorld.determinant() < 0 ? "cw" : "ccw";
      const blend = material.transparent === true;
      keys.add(`${mode}/${blend ? "blend" : "depth"}/${raster}${material.alphaToCoverage && !blend ? "/a2c" : ""}`);
    }
  });
  if (unsupported || !staticKeys.size && !posedKeys.size) return undefined;
  return { firstFrameSubset: true, firstFrameMainKeys: [...staticKeys],
    ...(posedKeys.size ? { deferDeformation: false, deformationFirstFrameMainKeys: [...posedKeys] } : {}) };
}
