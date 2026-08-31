import * as THREE from "three";
import type { SceneAnnotationState } from "@bim-studio/contracts";

/**
 * 将标签的世界坐标转换为绑定对象局部坐标。
 * 局部锚点只存在于运行时；场景文件仍保存世界坐标，兼容既有数据与导出格式。
 */
export function annotationLocalAnchor(
  annotation: SceneAnnotationState,
  target: THREE.Object3D | undefined,
): THREE.Vector3 | undefined {
  if (!annotation.modelId || !target) return undefined;
  target.updateWorldMatrix(true, false);
  return target.worldToLocal(
    new THREE.Vector3(
      annotation.position.x,
      annotation.position.y,
      annotation.position.z,
    ),
  );
}

/** 根据绑定对象的最新变换刷新标签世界坐标。 */
export function annotationWorldAnchor(
  target: THREE.Object3D | undefined,
  localAnchor: THREE.Vector3 | undefined,
): THREE.Vector3 | undefined {
  if (!target || !localAnchor) return undefined;
  target.updateWorldMatrix(true, false);
  return target.localToWorld(localAnchor.clone());
}
