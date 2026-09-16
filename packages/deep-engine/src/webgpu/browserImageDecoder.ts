import type { GltfEncodedImage, GltfImageDecoder } from "../gltf/textureTypes.js";

export interface DecodedImageHandle {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** 宿主提供实际解码与像素读取；核心只管理取消、临时资源和字节所有权。 */
export interface ImageDecoderHost<T extends DecodedImageHandle> {
  decode(image: GltfEncodedImage): Promise<T>;
  readPixels(image: T): Uint8ClampedArray;
}

export function createBrowserImageDecoder<T extends DecodedImageHandle>(host: ImageDecoderHost<T>): GltfImageDecoder {
  return {
    async decode(image, signal) {
      signal?.throwIfAborted();
      const bitmap = await host.decode({ ...image, data: image.data.slice() });
      try {
        signal?.throwIfAborted();
        const pixels = host.readPixels(bitmap);
        signal?.throwIfAborted();
        return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(pixels) };
      } finally {
        bitmap.close();
      }
    },
  };
}
