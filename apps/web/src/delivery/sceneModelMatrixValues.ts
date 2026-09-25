import type { ModelTransform } from "@bim-studio/contracts";
import { localTransformMatrix, type SceneMatrix4 } from "@bim-studio/deep-engine/scene";

/** 作者 XYZ Euler 到 Deep 场景矩阵的纯数据边界；不依赖 Three 对象。 */
export function sceneModelMatrixValues(transform: ModelTransform, id: string): SceneMatrix4 {
  const { position: p, rotation: r, scale: s } = transform;
  for (const vector of [p, r, s]) for (const value of [vector.x, vector.y, vector.z]) {
    if (!Number.isFinite(value)) throw new Error(`对象 ${id} 包含非有限数值`);
  }

  const c1 = Math.cos(r.x / 2), c2 = Math.cos(r.y / 2), c3 = Math.cos(r.z / 2);
  const s1 = Math.sin(r.x / 2), s2 = Math.sin(r.y / 2), s3 = Math.sin(r.z / 2);
  const matrix = localTransformMatrix({
    kind: "trs",
    translation: [p.x, p.y, p.z],
    rotation: [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    ],
    scale: [s.x, s.y, s.z],
  });
  if (matrix.some(value => !Number.isFinite(Math.fround(value)))) {
    throw new Error(`对象 ${id} 的变换超出运行时范围`);
  }
  return matrix;
}
