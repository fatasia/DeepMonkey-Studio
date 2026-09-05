import * as THREE from "three";

/** 仅用于优化器独占的加载结果；不释放其他场景共享的缓存素材。 */
export function disposeOptimizerPreview(roots: THREE.Object3D[]): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<{ close: () => void }>();
  for (const root of roots) root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
    if (object instanceof THREE.SkinnedMesh && object.skeleton.boneTexture) textures.add(object.skeleton.boneTexture);
  });
  for (const texture of textures) {
    const data = texture.source.data;
    for (const image of Array.isArray(data) ? data : [data]) if (image && typeof image.close === "function") images.add(image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
