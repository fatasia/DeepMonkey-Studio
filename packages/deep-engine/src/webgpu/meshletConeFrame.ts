import { invertAffineSceneMatrix } from "../scene/math.js";
import type { SceneMatrix4 } from "../scene/types.js";

export interface MeshletConeFrame {
  /** 局部相机 xyz；w 保留变换后几何绕序的行列式符号。 */
  readonly camera: readonly number[];
  readonly radiusError: number;
  readonly valid: boolean;
}
const DISABLED: MeshletConeFrame = Object.freeze({ camera: Object.freeze([0, 0, 0, 1]), radiusError: 0, valid: false });

/** 仿射变换不保锥角；逆变换相机可在原始局部球/法线锥内准确判断背面。 */
export function prepareMeshletConeFrame(world: readonly number[], camera: readonly number[]): MeshletConeFrame {
  if (world.length !== 16 || camera.length !== 3 || ![...world, ...camera].every(Number.isFinite)) return DISABLED;
  const m = world.map(Math.fround), eye = camera.map(Math.fround);
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1 || ![...m, ...eye].every(Number.isFinite)) return DISABLED;
  const inverse = invertAffineSceneMatrix(m as unknown as SceneMatrix4);
  if (!inverse) return DISABLED;
  const delta = eye.map((value, index) => value - m[12 + index]!);
  const local = [0, 1, 2].map(row => Math.fround(inverse[row]! * delta[0]! + inverse[row + 4]! * delta[1]! + inverse[row + 8]! * delta[2]!));
  if (!local.every(value => Number.isFinite(value) && Math.abs(value) < 1e30)) return DISABLED;
  const determinant = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!)
    - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);

  // 以解的残差包住逆矩阵误差及上传为 f32 时的相机误差，膨胀局部球保持保守性。
  let inverseNorm = 0, inverseResidual = 0, positionResidual = 0;
  for (let row = 0; row < 3; row += 1) {
    inverseNorm = Math.max(inverseNorm, Math.abs(inverse[row]!) + Math.abs(inverse[row + 4]!) + Math.abs(inverse[row + 8]!));
    let residualRow = 0;
    for (let column = 0; column < 3; column += 1) {
      let product = 0, magnitude = 0;
      for (let k = 0; k < 3; k += 1) {
        const term = m[k * 4 + row]! * inverse[column * 4 + k]!;
        product += term; magnitude += Math.abs(term);
      }
      residualRow += Math.abs((row === column ? 1 : 0) - product) + Number.EPSILON * 8 * magnitude;
    }
    inverseResidual = Math.max(inverseResidual, residualRow);
    let position = 0, magnitude = Math.abs(eye[row]!) + Math.abs(m[row + 12]!);
    for (let k = 0; k < 3; k += 1) {
      const term = m[k * 4 + row]! * local[k]!;
      position += term; magnitude += Math.abs(term);
    }
    positionResidual = Math.max(positionResidual, Math.abs(delta[row]! - position) + Number.EPSILON * 8 * magnitude);
  }
  if (inverseResidual >= 0.5 || determinant === 0) return DISABLED;
  const error = Math.sqrt(3) * inverseNorm / (1 - inverseResidual) * positionResidual;
  const radiusError = Math.fround(error * (1 + 2 ** -22) + 2 ** -126);
  if (!Number.isFinite(radiusError) || radiusError >= 1e30) return DISABLED;
  return { camera: [...local, determinant < 0 ? -1 : 1], radiusError, valid: true };
}
