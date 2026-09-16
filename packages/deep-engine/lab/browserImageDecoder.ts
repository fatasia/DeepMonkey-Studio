import { createBrowserImageDecoder } from "@bim-studio/deep-engine/browser-image-decoder";

export const browserImageDecoder = createBrowserImageDecoder<ImageBitmap>({
  decode(image) {
    return createImageBitmap(new Blob([image.data], { type: image.mimeType }), {
      colorSpaceConversion: "none", imageOrientation: "none", premultiplyAlpha: "none",
    });
  },
  readPixels(bitmap) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器没有提供纹理像素解码上下文。");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  },
});
