import { deflateSync } from "node:zlib";
import type { JtTextureImage } from "@bim-studio/jt-reader";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length);
  return output;
}

/** Wrap source JT raw RGBA/RGB texels as PNG for glTF; never label raw pixels as PNG. */
export function encodeJtTexturePng(image: JtTextureImage): Uint8Array {
  const stride = image.width * image.channels;
  if (image.pixels.length !== stride * image.height) throw new Error("JT 图像字节数与尺寸不一致");
  const scanlines = Buffer.alloc((stride + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    const target = row * (stride + 1);
    scanlines[target] = 0;
    Buffer.from(image.pixels.subarray(row * stride, (row + 1) * stride)).copy(scanlines, target + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = image.channels === 4 ? 6 : 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
