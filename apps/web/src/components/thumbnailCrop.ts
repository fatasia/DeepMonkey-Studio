export interface ThumbnailCrop { zoom: number; x: number; y: number }
export const initialThumbnailCrop: ThumbnailCrop = { zoom: 1, x: .5, y: .5 };

export function thumbnailSourceRect(width: number, height: number, crop: ThumbnailCrop) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("图片尺寸无效");
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const zoom = clamp(crop.zoom, 1, 4);
  const sourceWidth = Math.min(width, height * 4 / 3) / zoom;
  const sourceHeight = sourceWidth * 3 / 4;
  return { x: (width - sourceWidth) * clamp(crop.x, 0, 1), y: (height - sourceHeight) * clamp(crop.y, 0, 1), width: sourceWidth, height: sourceHeight };
}

export async function loadThumbnailImage(source: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(source);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error("图片像素过大，请选择 4000 万像素以内的图片");
    return image;
  } finally { URL.revokeObjectURL(url); }
}

export function drawThumbnail(canvas: HTMLCanvasElement, image: HTMLImageElement, crop: ThumbnailCrop) {
  const rect = thumbnailSourceRect(image.naturalWidth, image.naturalHeight, crop);
  canvas.width = 640; canvas.height = 480;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理图片");
  context.clearRect(0, 0, 640, 480);
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, 640, 480);
}

export function thumbnailBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("缩略图生成失败，请重试")), "image/webp", .88));
}

export function captureThumbnailSource(source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Promise<Blob> {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!width || !height) throw new Error("预览尚未就绪，请加载完成后重试");
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1600 / Math.max(width, height));
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法截取预览");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return thumbnailBlob(canvas);
}
