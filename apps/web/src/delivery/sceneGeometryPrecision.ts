import type { RenderPacket } from "@bim-studio/deep-engine";
import { SCENE_LOCAL_COORDINATE_PROFILE } from "./sceneLocalCoordinates";

type Geometry = RenderPacket["geometries"][number];
type Bounds = { maxAbs: readonly number[]; subnormalAbs: readonly number[] };
const unitRoundoff = 2 ** -24;
const gamma7 = 7 * unitRoundoff / (1 - 7 * unitRoundoff);
const maxFloat32 = (2 - 2 ** -23) * 2 ** 127;
const minNormalFloat32 = 2 ** -126;
// FTZ implementations may discard a subnormal result; cover that absolute error too.
const underflowAllowance = 7 * 2 ** -126;

/** 缓存仅属于一次编译，以几何对象身份隔离同 ID 的不同内容；调用期间几何必须不可变。 */
export function createSceneGeometryPrecisionValidator() {
  const cached = new WeakMap<Geometry, Bounds>();
  return (geometry: Geometry, matrix: ArrayLike<number>, path: string): void => {
    const reject = (reason: string): never => {
      throw new Error(`${path}.geometry[${geometry.id}] 无法在当前局部坐标精度预算内验证：${reason}`);
    };
    if (matrix.length !== 16 || Array.from(matrix).some(value => !Number.isFinite(value))
      || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) reject("变换必须为有限仿射矩阵");
    let bounds = cached.get(geometry);
    if (!bounds) {
      if (!geometry.indices.length || geometry.vertices.length % 6 !== 0) reject("几何布局无效");
      const values = [0, 0, 0], subnormalAbs = [0, 0, 0];
      for (const index of geometry.indices) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= geometry.vertices.length / 6) reject("顶点索引无效");
        for (let axis = 0; axis < 3; axis++) {
          const value = geometry.vertices[index * 6 + axis]!;
          if (!Number.isFinite(value)) reject("顶点不是有限数值");
          values[axis] = Math.max(values[axis]!, Math.abs(value));
          if (Math.abs(value) < minNormalFloat32) subnormalAbs[axis] = Math.max(subnormalAbs[axis]!, Math.abs(value));
        }
      }
      bounds = { maxAbs: values, subnormalAbs }; cached.set(geometry, bounds);
    }
    for (let row = 0; row < 3; row++) {
      let quantization = 0, magnitude = 0;
      for (let column = 0; column < 4; column++) {
        const coefficient = matrix[column * 4 + row]!, rounded = Math.fround(coefficient);
        const extent = column === 3 ? 1 : bounds.maxAbs[column]!;
        if (!Number.isFinite(rounded)) reject(`矩阵第 ${row + 1} 行超出 Float32 范围`);
        quantization += Math.abs(rounded - coefficient) * extent;
        if (Math.abs(rounded) < minNormalFloat32) quantization += Math.abs(rounded) * extent;
        if (column < 3) quantization += Math.abs(rounded) * bounds.subnormalAbs[column]!;
        magnitude += Math.abs(rounded) * extent;
      }
      // 4 次乘法 + 3 次加法的非 FMA 上界也覆盖 FMA 路径；绝对项和保守覆盖抵消。
      const errorBound = quantization + gamma7 * magnitude + underflowAllowance;
      const budget = SCENE_LOCAL_COORDINATE_PROFILE.maxFloat32CoordinateError;
      if (!Number.isFinite(errorBound) || magnitude > maxFloat32 || errorBound > budget) {
        reject(`第 ${row + 1} 行保守误差上界 ${errorBound} 超过 ${budget} 场景单位，或中间结果可能溢出；请重设几何局部原点或调整尺度后重新检查`);
      }
    }
  };
}
