import type { ModelTransform } from "@bim-studio/contracts";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";

/** 作者使用 XYZ Euler；保留根变换以便与模型内部 world matrix 相乘。 */
export function sceneModelMatrix(transform: ModelTransform, id: string): Matrix4 {
  const { position: p, rotation: r, scale: s } = transform;
  for (const vector of [p, r, s]) for (const value of [vector.x, vector.y, vector.z]) {
    if (!Number.isFinite(value)) throw new Error(`对象 ${id} 包含非有限数值`);
  }
  const rotation = new Quaternion().setFromEuler(new Euler(r.x, r.y, r.z, "XYZ"));
  const matrix = new Matrix4().compose(new Vector3(p.x, p.y, p.z), rotation, new Vector3(s.x, s.y, s.z));
  if (matrix.elements.some(value => !Number.isFinite(Math.fround(value)))) {
    throw new Error(`对象 ${id} 的变换超出运行时范围`);
  }
  return matrix;
}
