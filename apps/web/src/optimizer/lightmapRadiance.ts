/** 单张 HDR 辐射图归一到 PNG，强度通过标准 emissive-strength 恢复，不截断高光。 */
export function packLightmapRadiance(linear: Float32Array): { pixels: Uint8ClampedArray; strength: number } {
  if (linear.length % 4) throw new Error("光照贴图通道数量无效");
  let strength = 1;
  for (let index = 0; index < linear.length; index++) {
    if (index % 4 === 3) continue;
    const value = linear[index]!;
    if (!Number.isFinite(value) || value < 0 || value > 256) throw new Error("光照贴图辐射值超过已验证的 0–256 范围");
    strength = Math.max(strength, value);
  }
  const pixels = new Uint8ClampedArray(linear.length);
  for (let index = 0; index < linear.length; index++) {
    if (index % 4 === 3) { pixels[index] = 255;continue; }
    const value = linear[index]! / strength;
    pixels[index] = Math.round((value <= .0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - .055) * 255);
  }
  return { pixels, strength };
}
