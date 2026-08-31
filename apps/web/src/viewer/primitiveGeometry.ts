import * as THREE from "three";
import type { PrimitiveKind } from "@bim-studio/contracts";

const SHARED_GEOMETRY_FLAG = "studioSharedGeometry";

export function primitiveGeometry(kind: PrimitiveKind): THREE.BufferGeometry {
  switch (kind) {
    case "sphere": return new THREE.SphereGeometry(1, 32, 20);
    case "cylinder": return new THREE.CylinderGeometry(1, 1, 2, 32);
    case "cone": return new THREE.ConeGeometry(1, 2, 32);
    case "torus": return new THREE.TorusGeometry(1, 0.32, 18, 48);
    case "plane": {
      const geometry = new THREE.PlaneGeometry(3, 3);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    case "capsule": return new THREE.CapsuleGeometry(0.65, 1.4, 8, 16);
    default: return new THREE.BoxGeometry(2, 2, 2);
  }
}

export function primitiveGroundOffset(kind: PrimitiveKind): number {
  if (kind === "plane") return 0.01;
  if (kind === "torus") return 0.35;
  if (kind === "capsule") return 1.35;
  return 1;
}

export function primitiveKindName(kind: PrimitiveKind): string {
  return ({ box: "立方体", sphere: "球体", cylinder: "圆柱体", cone: "圆锥体", torus: "圆环", plane: "平面", capsule: "胶囊体" })[kind];
}

/** 查看器级基础几何缓存；设备阵列复用顶点数据，仍保留独立对象、材质和交互。 */
export class PrimitiveGeometryCache {
  private readonly geometries = new Map<PrimitiveKind, THREE.BufferGeometry>();

  get(kind: PrimitiveKind): THREE.BufferGeometry {
    const cached = this.geometries.get(kind);
    if (cached) return cached;
    const geometry = primitiveGeometry(kind);
    geometry.userData[SHARED_GEOMETRY_FLAG] = true;
    this.geometries.set(kind, geometry);
    return geometry;
  }

  size(): number {
    return this.geometries.size;
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) {
      delete geometry.userData[SHARED_GEOMETRY_FLAG];
      geometry.dispose();
    }
    this.geometries.clear();
  }
}

export function isSharedPrimitiveGeometry(geometry: THREE.BufferGeometry): boolean {
  return geometry.userData[SHARED_GEOMETRY_FLAG] === true;
}
