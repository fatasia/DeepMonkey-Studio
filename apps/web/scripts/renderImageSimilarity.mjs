import sharp from "sharp";
import { resolve } from "node:path";

const backendPairs = [["three-webgl", "three-webgpu"]];

/**
 * 比较同一引擎 WebGL/WebGPU 的最终画面。
 * SSIM 衡量结构一致性，MAE/PSNR 暴露整体色调和像素级偏差；不拿主观截图代替数据。
 */
export async function compareBackendImages(outputRoot) {
  const comparisons = [];
  for (const [reference, candidate] of backendPairs) {
    comparisons.push(await compareImageFiles(
      resolve(outputRoot, `${reference}-canvas.png`),
      resolve(outputRoot, `${candidate}-canvas.png`),
      reference,
      candidate,
      { differencePath: resolve(outputRoot, `${reference}-vs-${candidate}-diff.png`) },
    ));
  }
  return comparisons;
}

/** 比较任意两张同尺寸截图，供裸引擎与完整产品门禁共享同一统计口径。 */
export async function compareImageFiles(referencePath, candidatePath, reference = referencePath, candidate = candidatePath, options = {}) {
  const referenceImage = await readRgb(referencePath);
  const candidateImage = await readRgb(candidatePath);
  if (referenceImage.width !== candidateImage.width || referenceImage.height !== candidateImage.height) {
    throw new Error(`${reference}/${candidate} 截图尺寸不一致`);
  }
  const result = {
    reference,
    candidate,
    width: referenceImage.width,
    height: referenceImage.height,
    ...imageMetrics(referenceImage.data, candidateImage.data),
  };
  if (options.regions?.length) {
    result.regions = compareImageRegions(referenceImage, candidateImage, options.regions);
  }
  if (options.differencePath) {
    await writeDifferenceImage(referenceImage, candidateImage, options.differencePath);
    result.differencePath = options.differencePath;
  }
  return result;
}

async function readRgb(path) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function imageMetrics(reference, candidate) {
  const pixelCount = reference.length / 3;
  let absoluteError = 0;
  let squaredError = 0;
  let referenceMean = 0;
  let candidateMean = 0;
  let changedPixels = 0;
  let severePixels = 0;
  let maximumChannelError = 0;
  for (let offset = 0; offset < reference.length; offset += 3) {
    const referenceLuma = luminance(reference, offset);
    const candidateLuma = luminance(candidate, offset);
    referenceMean += referenceLuma;
    candidateMean += candidateLuma;
    let pixelMaximumError = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = reference[offset + channel] - candidate[offset + channel];
      absoluteError += Math.abs(delta);
      squaredError += delta * delta;
      pixelMaximumError = Math.max(pixelMaximumError, Math.abs(delta));
    }
    maximumChannelError = Math.max(maximumChannelError, pixelMaximumError);
    if (pixelMaximumError > 8) changedPixels += 1;
    if (pixelMaximumError > 32) severePixels += 1;
  }
  referenceMean /= pixelCount;
  candidateMean /= pixelCount;
  let referenceVariance = 0;
  let candidateVariance = 0;
  let covariance = 0;
  for (let offset = 0; offset < reference.length; offset += 3) {
    const left = luminance(reference, offset) - referenceMean;
    const right = luminance(candidate, offset) - candidateMean;
    referenceVariance += left * left;
    candidateVariance += right * right;
    covariance += left * right;
  }
  const denominator = Math.max(pixelCount - 1, 1);
  referenceVariance /= denominator;
  candidateVariance /= denominator;
  covariance /= denominator;
  const meanAbsoluteError = absoluteError / reference.length / 255;
  const meanSquaredError = squaredError / reference.length;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssim =
    ((2 * referenceMean * candidateMean + c1) * (2 * covariance + c2)) /
    ((referenceMean ** 2 + candidateMean ** 2 + c1) * (referenceVariance + candidateVariance + c2));
  return {
    ssim,
    meanAbsoluteError,
    changedPixelRatio: changedPixels / pixelCount,
    severePixelRatio: severePixels / pixelCount,
    maximumChannelError,
    psnrDb: meanSquaredError === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / meanSquaredError),
  };
}

/**
 * 按归一化矩形比较固定视觉区域，避免大面积背景掩盖 HUD、远景网格或选择高亮退化。
 * 一个区域可由多个不相邻矩形组成，例如左上标题与右下指标共同构成 HUD。
 */
function compareImageRegions(reference, candidate, regions) {
  return regions.map((region) => {
    if (!region.id || !region.label || !region.rectangles?.length) throw new Error("视觉区域必须提供 id、label 和 rectangles");
    const referencePixels = [];
    const candidatePixels = [];
    for (const rectangle of region.rectangles) {
      const bounds = normalizedBounds(rectangle, reference.width, reference.height);
      for (let y = bounds.top; y < bounds.bottom; y += 1) {
        const start = (y * reference.width + bounds.left) * 3;
        const end = (y * reference.width + bounds.right) * 3;
        referencePixels.push(reference.data.subarray(start, end));
        candidatePixels.push(candidate.data.subarray(start, end));
      }
    }
    const referenceData = Buffer.concat(referencePixels);
    const candidateData = Buffer.concat(candidatePixels);
    return {
      id: region.id,
      label: region.label,
      pixelCount: referenceData.length / 3,
      ...imageMetrics(referenceData, candidateData),
    };
  });
}

function normalizedBounds(rectangle, width, height) {
  const values = [rectangle.x, rectangle.y, rectangle.width, rectangle.height];
  if (!values.every(Number.isFinite) || rectangle.x < 0 || rectangle.y < 0 || rectangle.width <= 0 || rectangle.height <= 0
    || rectangle.x + rectangle.width > 1 || rectangle.y + rectangle.height > 1) {
    throw new Error("视觉区域矩形必须位于 0–1 归一化画布内");
  }
  const left = Math.floor(rectangle.x * width);
  const top = Math.floor(rectangle.y * height);
  const right = Math.max(left + 1, Math.ceil((rectangle.x + rectangle.width) * width));
  const bottom = Math.max(top + 1, Math.ceil((rectangle.y + rectangle.height) * height));
  return { left, top, right: Math.min(width, right), bottom: Math.min(height, bottom) };
}

async function writeDifferenceImage(reference, candidate, outputPath) {
  const difference = Buffer.alloc(reference.data.length);
  for (let offset = 0; offset < difference.length; offset += 3) {
    const red = Math.abs(reference.data[offset] - candidate.data[offset]);
    const green = Math.abs(reference.data[offset + 1] - candidate.data[offset + 1]);
    const blue = Math.abs(reference.data[offset + 2] - candidate.data[offset + 2]);
    const magnitude = Math.max(red, green, blue);
    difference[offset] = Math.min(255, magnitude * 4);
    difference[offset + 1] = Math.min(96, magnitude);
    difference[offset + 2] = Math.min(96, magnitude);
  }
  await sharp(difference, { raw: { width: reference.width, height: reference.height, channels: 3 } })
    .png()
    .toFile(outputPath);
}

function luminance(buffer, offset) {
  return buffer[offset] * 0.2126 + buffer[offset + 1] * 0.7152 + buffer[offset + 2] * 0.0722;
}
