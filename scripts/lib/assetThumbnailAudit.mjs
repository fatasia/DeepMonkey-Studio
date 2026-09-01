import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const TARGET_WIDTH = 480;
const TARGET_HEIGHT = 360;
const CONTENT_WIDTH = 432;
const CONTENT_HEIGHT = 312;
const MIN_SHORT_SIDE_RATIO = 0.14;
const MIN_VISIBLE_PIXEL_RATIO = 0.04;

/**
 * 将来源不一的透明缩略图裁去空白并统一到 4:3 安全画布。
 * 只处理预览图，不改动模型和材质，因此不会影响资产本身的视觉质量。
 */
export async function normalizeAssetThumbnail(sourcePath, targetPath) {
  const source = sharp(sourcePath, { failOn: "error", limitInputPixels: 80_000_000 }).rotate().ensureAlpha();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) return invalid("无法读取缩略图尺寸");
  if (metadata.width < 240 || metadata.height < 160) return invalid("缩略图分辨率低于 240×160");

  const trimmed = await source
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 6 })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (trimmed.info.width < 8 || trimmed.info.height < 8) return invalid("缩略图主体为空或过小");

  const scale = Math.min(CONTENT_WIDTH / trimmed.info.width, CONTENT_HEIGHT / trimmed.info.height, 4);
  const renderedWidth = Math.max(1, Math.round(trimmed.info.width * scale));
  const renderedHeight = Math.max(1, Math.round(trimmed.info.height * scale));
  const subjectOpacity = await opaquePixelRatio(trimmed.data);
  const visiblePixelRatio = subjectOpacity * renderedWidth * renderedHeight / (TARGET_WIDTH * TARGET_HEIGHT);
  const shortSideRatio = Math.min(renderedWidth / TARGET_WIDTH, renderedHeight / TARGET_HEIGHT);
  const left = Math.floor((TARGET_WIDTH - renderedWidth) / 2);
  const top = Math.floor((TARGET_HEIGHT - renderedHeight) / 2);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await sharp(trimmed.data)
    .resize(renderedWidth, renderedHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .extend({
      top,
      bottom: TARGET_HEIGHT - renderedHeight - top,
      left,
      right: TARGET_WIDTH - renderedWidth - left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(targetPath);

  const sourceResolutionScore = Math.min(25, (metadata.width / 480) * 12.5 + (metadata.height / 360) * 12.5);
  const sourceSubjectScore = Math.min(25, (trimmed.info.width / 180) * 12.5 + (trimmed.info.height / 90) * 12.5);
  const normalizedFill = Math.max(renderedWidth / TARGET_WIDTH, renderedHeight / TARGET_HEIGHT);
  const visibilityScore = Math.min(15, visiblePixelRatio / 0.12 * 15);
  const qualityScore = Math.round(Math.min(100, sourceResolutionScore + sourceSubjectScore + normalizedFill * 35 + visibilityScore));
  const issues = [
    ...(shortSideRatio < MIN_SHORT_SIDE_RATIO ? ["主体短边占比不足"] : []),
    ...(visiblePixelRatio < MIN_VISIBLE_PIXEL_RATIO ? ["主体有效像素占比不足"] : []),
    ...(qualityScore < 70 ? ["缩略图主体清晰度不足"] : []),
  ];

  return {
    valid: issues.length === 0,
    qualityScore,
    source: { width: metadata.width, height: metadata.height },
    subject: { width: trimmed.info.width, height: trimmed.info.height },
    normalized: {
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      renderedWidth,
      renderedHeight,
      shortSideRatio: roundRatio(shortSideRatio),
      visiblePixelRatio: roundRatio(visiblePixelRatio),
    },
    ...(issues.length ? { reason: issues.join("；") } : {}),
  };
}

async function opaquePixelRatio(image) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaOffset = info.channels - 1;
  let visible = 0;
  for (let index = alphaOffset; index < data.length; index += info.channels) {
    if (data[index] > 8) visible += 1;
  }
  return visible / Math.max(1, info.width * info.height);
}

function roundRatio(value) {
  return Math.round(value * 10_000) / 10_000;
}

function invalid(reason) {
  return { valid: false, qualityScore: 0, reason };
}
