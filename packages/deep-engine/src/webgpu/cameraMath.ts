export type Vec3 = readonly [number, number, number];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  if (length < 1e-8 || !Number.isFinite(length)) throw new Error("Camera basis is degenerate.");
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Camera-relative view 矩阵：eye/target 先在 Float64 域减去 cameraWorldPosition（减法在
 * double 域完成，相对结果量级小、无精度损失），再构建 view。基向量与 world-space lookAt
 * 完全一致；平移列从大坐标量级（1e7 处 float32 ulp=1.0，亚单位相机运动被整体吞掉）
 * 降到原点附近量级，float32 存储不再引发顶点抖动。origin 全零时与 lookAt 逐位一致。
 */
export function lookAtRelative(eye: Vec3, target: Vec3, up: Vec3,
  cameraWorldPosition: Vec3): Float32Array<ArrayBuffer> {
  if (cameraWorldPosition.length !== 3 || !cameraWorldPosition.every(Number.isFinite)) {
    throw new Error("Camera world position must contain 3 finite numbers.");
  }
  const eyeRelative = subtract(eye, cameraWorldPosition);
  const targetRelative = subtract(target, cameraWorldPosition);
  const z = normalize(subtract(eyeRelative, targetRelative));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eyeRelative), -dot(y, eyeRelative), -dot(z, eyeRelative), 1,
  ]);
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Float32Array<ArrayBuffer> {
  return lookAtRelative(eye, target, up, [0, 0, 0]);
}

/** 右手系、列主序、WebGPU 深度区间 0..1。 */
export function perspective(fov: number, aspect: number, near: number, far: number): Float32Array<ArrayBuffer> {
  if (![fov, aspect, near, far].every(Number.isFinite) || fov <= 0 || fov >= Math.PI || aspect <= 0 || near <= 0 || far <= near) {
    throw new Error("Invalid perspective camera.");
  }
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, far * near / (near - far), 0]);
}

export function orthographic(radius: number, near: number, far: number): Float32Array<ArrayBuffer> {
  if (![radius, near, far].every(Number.isFinite) || radius <= 0 || near < 0 || far <= near) throw new Error("Invalid orthographic camera.");
  return new Float32Array([1 / radius, 0, 0, 0, 0, 1 / radius, 0, 0, 0, 0, 1 / (near - far), 0, 0, 0, near / (near - far), 1]);
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
  }
  return out;
}
