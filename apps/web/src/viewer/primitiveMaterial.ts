import * as THREE from "three";

const sharedPrimitiveMaterials = new WeakSet<THREE.Material>();
const materialOwners = new WeakMap<THREE.Material, PrimitiveMaterialCache>();
const DEFAULT_MAX_IDLE_MATERIALS = 0;

/** 查看器内复用同色基础材质；对象被单独编辑时由 detachSharedPrimitiveMaterials 写时复制。 */
export class PrimitiveMaterialCache {
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly references = new Map<THREE.Material, number>();
  private readonly keys = new Map<THREE.Material, string>();
  private readonly idleMaterials = new Set<THREE.Material>();

  constructor(private readonly maxIdleMaterials = DEFAULT_MAX_IDLE_MATERIALS) {}

  get(color: string): THREE.MeshStandardMaterial {
    const key = new THREE.Color(color).getHexString(THREE.SRGBColorSpace);
    const cached = this.materials.get(key);
    if (cached) {
      this.idleMaterials.delete(cached);
      this.references.set(cached, (this.references.get(cached) ?? 0) + 1);
      return cached;
    }
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.05 });
    sharedPrimitiveMaterials.add(material);
    materialOwners.set(material, this);
    this.materials.set(key, material);
    this.keys.set(material, key);
    this.references.set(material, 1);
    return material;
  }

  release(material: THREE.Material): void {
    const current = this.references.get(material);
    if (current === undefined) return;
    if (current > 1) {
      this.references.set(material, current - 1);
      return;
    }
    if (current <= 0) return;

    // 场景切换会短暂清空全部基础体。有限空闲缓存避免 WebGPU 重复编译同一组材质，
    // 同时通过 LRU 上限约束用户连续试色时的内存占用。
    this.references.set(material, 0);
    this.idleMaterials.delete(material);
    this.idleMaterials.add(material);
    this.evictIdleMaterials();
  }

  /** 新场景使用新一代材质；旧代在其对象完成 GPU 退休后自然归零并释放。 */
  beginSceneGeneration(): void {
    this.materials.clear();
    this.idleMaterials.clear();
  }

  dispose(): void {
    for (const material of this.references.keys()) {
      sharedPrimitiveMaterials.delete(material);
      materialOwners.delete(material);
      material.dispose();
    }
    this.materials.clear();
    this.references.clear();
    this.keys.clear();
    this.idleMaterials.clear();
  }

  private evictIdleMaterials(): void {
    while (this.idleMaterials.size > Math.max(0, this.maxIdleMaterials)) {
      const material = this.idleMaterials.values().next().value as THREE.Material | undefined;
      if (!material) return;
      this.idleMaterials.delete(material);
      const key = this.keys.get(material);
      if (key && this.materials.get(key) === material) this.materials.delete(key);
      this.keys.delete(material);
      this.references.delete(material);
      sharedPrimitiveMaterials.delete(material);
      materialOwners.delete(material);
      material.dispose();
    }
  }
}

export function isSharedPrimitiveMaterial(material: THREE.Material): boolean {
  return sharedPrimitiveMaterials.has(material);
}

/**
 * 共享材质只用于未编辑的基础对象。首次修改前复制当前对象的材质，
 * 使颜色、透明度和纹理编辑继续保持对象级隔离。
 */
export function detachSharedPrimitiveMaterials(
  object: THREE.Object3D,
  collisionOriginalMaterials?: Map<THREE.Mesh, THREE.Material | THREE.Material[]>,
): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const collisionSource = collisionOriginalMaterials?.get(mesh);
    const source = collisionSource ?? mesh.material;
    if (!source) return;
    const materials = Array.isArray(source) ? source : [source];
    if (!materials.some(isSharedPrimitiveMaterial)) return;
    const detached = materials.map((material) => {
      if (!isSharedPrimitiveMaterial(material)) return material;
      const clone = material.clone();
      releaseSharedPrimitiveMaterial(material);
      return clone;
    });
    const next = Array.isArray(source) ? detached : detached[0]!;
    if (collisionSource) collisionOriginalMaterials?.set(mesh, next);
    else mesh.material = next;
  });
}

/** 对象移除时归还共享材质引用；最后一个引用会触发 WebGPU RenderObject 清理。 */
export function releaseSharedPrimitiveMaterials(object: THREE.Object3D): void {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const item of materials) releaseSharedPrimitiveMaterial(item);
  });
}

export function releaseSharedPrimitiveMaterial(material: THREE.Material): void {
  materialOwners.get(material)?.release(material);
}
