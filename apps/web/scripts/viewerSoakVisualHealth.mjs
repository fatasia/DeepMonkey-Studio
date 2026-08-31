import sharp from "sharp";

/** 从真实浏览器截图判断渲染画面是否退化为全黑或近似纯色。 */
export async function analyzeRenderFrame(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let visiblePixelCount = 0;
  for (let offset = 0; offset < data.length; offset += 3) {
    const luminance = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
    if (luminance >= 24) visiblePixelCount += 1;
  }
  const meanLuminance = luminanceSum / pixelCount;
  const variance = Math.max(0, luminanceSquaredSum / pixelCount - meanLuminance ** 2);
  return {
    width: info.width,
    height: info.height,
    meanLuminance,
    luminanceStdDev: Math.sqrt(variance),
    visiblePixelRatio: visiblePixelCount / pixelCount
  };
}

export function isBlankRenderFrame(frame) {
  return frame.meanLuminance < 5
    || frame.luminanceStdDev < 1.5
    || frame.visiblePixelRatio < 0.005;
}
