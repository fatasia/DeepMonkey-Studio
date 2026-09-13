import type { Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { getTextureColorSpace, listTextureSlots } from "@gltf-transform/functions";

export type Ktx2Quality = "ktx2-uastc" | "ktx2-etc1s";
interface BasisEncoder {
  setCreateKTX2File(value: boolean): void; setKTX2UASTCSupercompression(value: boolean): void;
  setUASTC(value: boolean): void; setQualityLevel(value: number): void; setETC1SCompressionLevel(value: number): void;
  setPerceptual(value: boolean): void; setKTX2AndBasisSRGBTransferFunc(value: boolean): void; setMipSRGB(value: boolean): void;
  setNormalMapPreset(): void; setMipRenormalize(value: boolean): void;
  setMipGen(value: boolean): void; setYFlip(value: boolean): void; setDebug(value: boolean): void; setStatusOutput(value: boolean): void;
  setSliceSourceImage(index: number, image: Uint8Array, width: number, height: number, type: number): boolean;
  encode(output: Uint8Array): number; delete(): void;
}
interface BasisModule { initializeBasis(): void; BasisEncoder: new () => BasisEncoder }
let basisPromise: Promise<BasisModule> | undefined;
async function basis(): Promise<BasisModule> {
  basisPromise ??= (async () => {
    const root = `${import.meta.env.BASE_URL}basis/`;
    const [script, response] = await Promise.all([import(/* @vite-ignore */ `${root}basis_encoder.mjs`), fetch(`${root}basis_encoder.wasm`)]);
    if (!response.ok) throw new Error("本地 KTX2 编码器未就绪，请重试");
    const module = await script.default({ wasmBinary: new Uint8Array(await response.arrayBuffer()) }) as BasisModule;
    module.initializeBasis(); return module;
  })().catch(error => { basisPromise = undefined; throw error; });
  return basisPromise;
}

/** KHR_texture_basisu 要求宽高为 4 的倍数；保持长宽比例到一个像素块内。 */
export function ktx2Dimensions(width: number, height: number, maximum: number): [number, number] {
  const ratio = Math.min(1, maximum / Math.max(width, height));
  return [Math.max(4, Math.floor(width * ratio / 4) * 4), Math.max(4, Math.floor(height * ratio / 4) * 4)];
}

/** 在已有优化 Worker 内顺序编码，取消处理会终止 Worker，原件和上一结果都不会被改写。 */
export async function compressKtx2Textures(document: Document, quality: Ktx2Quality, maximum: number, progress?: (message: string) => void): Promise<void> {
  const textures = document.getRoot().listTextures().filter(texture => texture.getMimeType() !== "image/ktx2" && texture.getImage());
  if (!textures.length) return;
  const module = await basis();
  for (const [index, texture] of textures.entries()) {
    progress?.(`正在压缩 KTX2 贴图 ${index + 1}/${textures.length}`);
    const source = texture.getImage()!;
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(source)], { type: texture.getMimeType() }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const [width, height] = ktx2Dimensions(bitmap.width, bitmap.height, maximum);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) { bitmap.close(); throw new Error("当前浏览器无法读取贴图像素"); }
    context.drawImage(bitmap, 0, 0, width, height); bitmap.close();
    const rgba = new Uint8Array(context.getImageData(0, 0, width, height).data);
    const encoder = new module.BasisEncoder();
    try {
      const normal = listTextureSlots(texture).some(slot => /normalTexture/i.test(slot));
      const srgb = getTextureColorSpace(texture) === "srgb";
      encoder.setCreateKTX2File(true); encoder.setUASTC(normal || quality === "ktx2-uastc");
      encoder.setKTX2UASTCSupercompression(true);
      encoder.setQualityLevel(160); encoder.setETC1SCompressionLevel(2);
      if (normal) { encoder.setNormalMapPreset(); encoder.setMipRenormalize(true); }
      encoder.setPerceptual(srgb); encoder.setKTX2AndBasisSRGBTransferFunc(srgb); encoder.setMipSRGB(srgb);
      encoder.setMipGen(true); encoder.setYFlip(false); encoder.setDebug(false); encoder.setStatusOutput(false);
      if (!encoder.setSliceSourceImage(0, rgba, width, height, 0)) throw new Error("KTX2 贴图像素输入无效");
      const output = new Uint8Array(width * height * 4 + 65536);
      const length = encoder.encode(output);
      if (!length) throw new Error("KTX2 编码失败，原始贴图已保留");
      texture.setImage(output.slice(0, length)).setMimeType("image/ktx2").setURI("");
    } finally { encoder.delete(); }
  }
  document.createExtension(KHRTextureBasisu).setRequired(true);
}
