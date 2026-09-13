/** 列主序仿射矩阵；上传模型行和逆转置法线列，支持非均匀缩放、剪切与镜像。 */
export function packTransform(matrix: ArrayLike<number>, output: Float32Array, offset = 0): boolean {
  if (matrix.length !== 16) throw new Error("Transform must contain 16 components.");
  for (let i = 0; i < 16; i++) if (!Number.isFinite(matrix[i])) throw new Error("Transform components must be finite numbers.");
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) throw new Error("Transform must be affine before float32 conversion.");
  const a0 = Math.fround(matrix[0]!), a1 = Math.fround(matrix[1]!), a2 = Math.fround(matrix[2]!);
  const b0 = Math.fround(matrix[4]!), b1 = Math.fround(matrix[5]!), b2 = Math.fround(matrix[6]!);
  const c0 = Math.fround(matrix[8]!), c1 = Math.fround(matrix[9]!), c2 = Math.fround(matrix[10]!);
  const tx = Math.fround(matrix[12]!), ty = Math.fround(matrix[13]!), tz = Math.fround(matrix[14]!);
  if (!Number.isFinite(a0 + a1 + a2 + b0 + b1 + b2 + c0 + c1 + c2 + tx + ty + tz)) {
    throw new Error("Transform must be a finite float32 affine matrix.");
  }
  const n00 = b1 * c2 - b2 * c1, n01 = b2 * c0 - b0 * c2, n02 = b0 * c1 - b1 * c0;
  const n10 = c1 * a2 - c2 * a1, n11 = c2 * a0 - c0 * a2, n12 = c0 * a1 - c1 * a0;
  const n20 = a1 * b2 - a2 * b1, n21 = a2 * b0 - a0 * b2, n22 = a0 * b1 - a1 * b0;
  const determinant = a0 * n00 + a1 * n01 + a2 * n02;
  const scale = Math.hypot(a0, a1, a2) * Math.hypot(b0, b1, b2) * Math.hypot(c0, c1, c2);
  if (!scale || Math.abs(determinant) / scale < 1e-8) throw new Error("Transform is singular or ill-conditioned.");
  const x0 = Math.fround(n00 / determinant), x1 = Math.fround(n01 / determinant), x2 = Math.fround(n02 / determinant);
  const y0 = Math.fround(n10 / determinant), y1 = Math.fround(n11 / determinant), y2 = Math.fround(n12 / determinant);
  const z0 = Math.fround(n20 / determinant), z1 = Math.fround(n21 / determinant), z2 = Math.fround(n22 / determinant);
  // 有限 float32 的少量求和不会溢出 double；任何 Inf/NaN 均使结果非有限。
  if (!Number.isFinite(x0 + x1 + x2 + y0 + y1 + y2 + z0 + z1 + z2)) throw new Error("Normal transform exceeds float32 range.");
  const start = Math.trunc(offset) || 0;
  if (start < 0 || start + 24 > output.length) throw new RangeError("Transform output is too small.");
  // 所有校验完成后才写入，失败不会留下部分模型/法线数据。
  output[start] = a0; output[start + 1] = b0; output[start + 2] = c0; output[start + 3] = tx;
  output[start + 4] = a1; output[start + 5] = b1; output[start + 6] = c1; output[start + 7] = ty;
  output[start + 8] = a2; output[start + 9] = b2; output[start + 10] = c2; output[start + 11] = tz;
  output[start + 12] = x0; output[start + 13] = x1; output[start + 14] = x2; output[start + 15] = 0;
  output[start + 16] = y0; output[start + 17] = y1; output[start + 18] = y2; output[start + 19] = 0;
  output[start + 20] = z0; output[start + 21] = z1; output[start + 22] = z2; output[start + 23] = 0;
  return determinant < 0;
}
