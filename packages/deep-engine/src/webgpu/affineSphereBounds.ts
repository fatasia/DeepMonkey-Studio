/** Conservative maximum stretch of the packed 3×4 affine rows, including shear. */
export function conservativeAffineScale(data: Float32Array, offset: number): number {
  const a = data[offset]!, b = data[offset + 1]!, c = data[offset + 2]!;
  const d = data[offset + 4]!, e = data[offset + 5]!, f = data[offset + 6]!;
  const g = data[offset + 8]!, h = data[offset + 9]!, i = data[offset + 10]!;
  const normInf = Math.max(Math.abs(a) + Math.abs(b) + Math.abs(c),
    Math.abs(d) + Math.abs(e) + Math.abs(f), Math.abs(g) + Math.abs(h) + Math.abs(i));
  const normOne = Math.max(Math.abs(a) + Math.abs(d) + Math.abs(g),
    Math.abs(b) + Math.abs(e) + Math.abs(h), Math.abs(c) + Math.abs(f) + Math.abs(i));
  const ab = Math.abs(a * b + d * e + g * h);
  const ac = Math.abs(a * c + d * f + g * i);
  const bc = Math.abs(b * c + e * f + h * i);
  // Gershgorin on AᵀA bounds σ². Unlike ||A||₁||A||∞, rotation alone does not
  // enlarge the sphere and force a finer LOD. Both bounds remain valid for shear.
  const gramBound = Math.max(a * a + d * d + g * g + ab + ac,
    b * b + e * e + h * h + ab + bc, c * c + f * f + i * i + ac + bc);
  // Inputs are float32; evaluate in double, then leave room for its short sums.
  // packGpuLodScene separately rounds radius outward and absorbs center error.
  return Math.sqrt(Math.min(normInf * normOne, gramBound)) * (1 + 8 * Number.EPSILON);
}
