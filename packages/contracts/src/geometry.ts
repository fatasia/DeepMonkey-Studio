/** 跨模型、场景和视觉领域复用的基础几何值对象。 */
export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}

export interface ModelTransform {
  position: Vector3Value;
  rotation: Vector3Value;
  scale: Vector3Value;
}

export function createDefaultTransform(): ModelTransform {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }
  };
}
