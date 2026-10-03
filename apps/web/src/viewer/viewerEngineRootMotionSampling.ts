import * as THREE from "three";

/** 回绕校正的根运动采样:全部使用模块级 scratch,帧内零分配。 */
const startQuat = new THREE.Quaternion();
const endQuat = new THREE.Quaternion();
const segmentQuat = new THREE.Quaternion();

/**
 * 未包裹时间 (from,to] 内的平移与旋转增量,逐段求和。段端点落在回绕边界时取"整圈末姿态"
 * (`evaluate(duration)` 钳到末关键帧),而非下一圈起点,因此循环 clip 的回绕不产生跳变量。
 *
 * - 平移累加进 `outTranslation`(调用方先清零)。
 * - 旋转按段 `q(end)·q(start)⁻¹`(父空间左乘增量)依次左乘进 `outRotation`(调用方先置单位)。
 *   增量形式与四元数符号无关,slerp 的双覆盖不会产生翻转。
 */
export function sampleCycleCorrectedDelta(
  position: THREE.Interpolant | null,
  rotation: THREE.Interpolant | null,
  from: number,
  to: number,
  duration: number,
  outTranslation: THREE.Vector3,
  outRotation: THREE.Quaternion,
): void {
  const wrapEpsilon = duration * 1e-9;
  let cursor = from;
  while (cursor < to - wrapEpsilon) {
    const segEnd = Math.min(to, (Math.floor(cursor / duration) + 1) * duration);
    const startWrapped = cursor % duration;
    const rawEnd = segEnd % duration;
    const endWrapped = rawEnd <= wrapEpsilon || duration - rawEnd <= wrapEpsilon ? duration : rawEnd;
    if (position) {
      const start = position.evaluate(startWrapped) as ArrayLike<number>;
      // evaluate 复用同一 resultBuffer:第二次求值前必须先拷贝首样本。
      const startX = start[0] ?? 0;
      const startY = start[1] ?? 0;
      const startZ = start[2] ?? 0;
      const end = position.evaluate(endWrapped) as ArrayLike<number>;
      outTranslation.x += (end[0] ?? 0) - startX;
      outTranslation.y += (end[1] ?? 0) - startY;
      outTranslation.z += (end[2] ?? 0) - startZ;
    }
    if (rotation) {
      const start = rotation.evaluate(startWrapped) as ArrayLike<number>;
      startQuat.set(start[0] ?? 0, start[1] ?? 0, start[2] ?? 0, start[3] ?? 1);
      const end = rotation.evaluate(endWrapped) as ArrayLike<number>;
      endQuat.set(end[0] ?? 0, end[1] ?? 0, end[2] ?? 0, end[3] ?? 1);
      segmentQuat.copy(startQuat).invert().premultiply(endQuat);
      outRotation.premultiply(segmentQuat);
    }
    cursor = segEnd;
  }
  outRotation.normalize();
}

/** 增量是否为单位旋转(w 绝对值≈1);单位增量不写回实例,避免空转与欧拉往返噪声。 */
export function isIdentityRotation(quaternion: THREE.Quaternion): boolean {
  return Math.abs(quaternion.w) >= 1 - 1e-12;
}
