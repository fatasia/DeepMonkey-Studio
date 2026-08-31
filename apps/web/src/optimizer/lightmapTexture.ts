/** 扩张已覆盖 texel，避免纹理过滤后在 UV 岛边缘出现黑缝。 */
export function dilateTexture(pixels: Uint8ClampedArray, covered: Uint8Array, resolution: number, iterations: number): void {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sourcePixels = pixels.slice();
    const sourceCovered = covered.slice();
    for (let y = 1; y < resolution - 1; y += 1) for (let x = 1; x < resolution - 1; x += 1) {
      const index = y * resolution + x;
      if (sourceCovered[index]) continue;
      const neighbor = [index - 1, index + 1, index - resolution, index + resolution].find((candidate) => sourceCovered[candidate]);
      if (neighbor === undefined) continue;
      pixels.set(sourcePixels.subarray(neighbor * 4, neighbor * 4 + 4), index * 4);
      covered[index] = 1;
    }
  }
}

/** 保边降噪：空间邻近且颜色接近的 texel 权重更高，不跨越未覆盖区域。 */
export function denoiseTexture(pixels: Uint8ClampedArray, covered: Uint8Array, resolution: number, iterations: number): void {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const source = pixels.slice();
    for (let y = 1; y < resolution - 1; y += 1) for (let x = 1; x < resolution - 1; x += 1) {
      const index = y * resolution + x;
      if (!covered[index]) continue;
      const center = index * 4;
      let weightSum = 0;
      const sums: [number, number, number] = [0, 0, 0];
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const sampleIndex = (y + offsetY) * resolution + x + offsetX;
        if (!covered[sampleIndex]) continue;
        const channel = sampleIndex * 4;
        const difference = (Math.abs(source[channel]! - source[center]!) + Math.abs(source[channel + 1]! - source[center + 1]!) + Math.abs(source[channel + 2]! - source[center + 2]!)) / 3;
        const spatialWeight = offsetX === 0 && offsetY === 0 ? 4 : offsetX === 0 || offsetY === 0 ? 2 : 1;
        const weight = spatialWeight / (1 + difference * 0.035);
        sums[0] += source[channel]! * weight;
        sums[1] += source[channel + 1]! * weight;
        sums[2] += source[channel + 2]! * weight;
        weightSum += weight;
      }
      if (weightSum <= 0) continue;
      pixels[center] = Math.round(sums[0] / weightSum);
      pixels[center + 1] = Math.round(sums[1] / weightSum);
      pixels[center + 2] = Math.round(sums[2] / weightSum);
    }
  }
}

export async function encodeLightmapPng(pixels: Uint8ClampedArray, resolution: number): Promise<Uint8Array> {
  const imagePixels = Uint8ClampedArray.from(pixels);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(resolution, resolution);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持光照贴图 Canvas 编码");
    const imageData = context.createImageData(resolution, resolution);
    imageData.data.set(imagePixels);
    context.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = resolution;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持光照贴图 Canvas 编码");
    const imageData = context.createImageData(resolution, resolution);
    imageData.data.set(imagePixels);
    context.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("光照贴图 PNG 编码失败")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("光照贴图烘焙仅支持浏览器环境");
}
