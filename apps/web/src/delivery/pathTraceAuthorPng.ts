export interface PathTraceRgbaImage { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray<ArrayBuffer> }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Declares the file as sRGB (perceptual intent) so viewers do not guess the transfer curve. */
export function withSrgbChunk(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(12) !== 0x49484452) throw new Error("PNG 编码结果无效。");
  const chunk = new Uint8Array(13);
  chunk.set([0, 0, 0, 1, 0x73, 0x52, 0x47, 0x42, 0], 0);
  new DataView(chunk.buffer).setUint32(9, crc32(chunk.subarray(4, 9)));
  const result = new Uint8Array(png.length + chunk.length);
  result.set(png.subarray(0, 33), 0); result.set(chunk, 33); result.set(png.subarray(33), 33 + chunk.length);
  return result;
}

async function canvasBlob(image: PathTraceRgbaImage): Promise<Blob> {
  const pixels = new ImageData(image.data, image.width, image.height);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建 PNG 画布。");
    context.putImageData(pixels, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  }
  const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建 PNG 画布。");
  context.putImageData(pixels, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG 编码失败。")), "image/png"));
}

/** Browser Canvas PNG encoder (no dependency) plus an explicit sRGB chunk. Input is already display-referred sRGB. */
export async function encodePathTracePng(image: PathTraceRgbaImage,
  encode: (image: PathTraceRgbaImage) => Promise<Blob> = canvasBlob): Promise<Uint8Array> {
  const blob = await encode(image);
  return withSrgbChunk(new Uint8Array(await blob.arrayBuffer()));
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer> | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
