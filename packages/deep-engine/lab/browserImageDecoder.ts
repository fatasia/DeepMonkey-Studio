import type { GltfDecodedImage, GltfImageDecoder } from "@bim-studio/deep-engine/gltf";

function cancellation(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Browser host adapter. The glTF core remains DOM/IO free and owns the returned copy. */
export const browserImageDecoder: GltfImageDecoder = {
  async decode(image, signal): Promise<GltfDecodedImage> {
    cancellation(signal);
    const source = image.data.slice().buffer;
    const bitmap = await createImageBitmap(new Blob([source], { type: image.mimeType }), {
      colorSpaceConversion: "none",
      imageOrientation: "none",
      premultiplyAlpha: "none",
    });
    try {
      cancellation(signal);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("浏览器没有提供纹理像素解码上下文。");
      context.clearRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
      cancellation(signal);
      return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(pixels.data) };
    } finally {
      bitmap.close();
    }
  },
};
