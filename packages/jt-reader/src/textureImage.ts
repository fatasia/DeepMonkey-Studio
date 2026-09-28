import { BinaryReader, JtFormatError } from "./binaryReader.js";
import type { JtByteOrder, JtLogicalElement, JtTextureImage } from "./types.js";

export const TEXTURE_IMAGE_ATTRIBUTE = "10dd1073-2ac8-11d1-9b6b-0080c7bb5997";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** PSI 14-1 V3 §6.2.2: deliberately accept only inline, single-mipmap 2D RGB/RGBA U8. */
export function parseJtTextureImage(element: JtLogicalElement, order: JtByteOrder, major: number): JtTextureImage | undefined {
  if (element.objectTypeId !== TEXTURE_IMAGE_ATTRIBUTE) return undefined;
  if (major !== 10 || order !== "little-endian") throw new JtFormatError("JT 贴图仅验证 10.x 小端布局", "shape-version-unsupported");
  const reader = new BinaryReader(element.payload, order);
  const baseVersion = reader.u8(0, "贴图属性基类版本");
  const state = reader.u8(1, "贴图属性状态");
  const inhibit = reader.u32(2, "贴图属性抑制位");
  const final = reader.u32(6, "贴图属性终止位");
  const textureVersion = reader.u8(10, "贴图属性版本");
  // Unknown accumulation flags may change semantics; never publish a plausible but wrong image.
  if (baseVersion !== 1 || state !== 0 || inhibit !== 0 || final !== 0 || textureVersion !== 1) {
    throw new JtFormatError("JT 贴图属性版本或继承标志超出已验证子集", "attribute-encoding-unsupported");
  }
  let cursor = 11;
  const textureType = reader.i32(cursor, "贴图类型"); cursor += 4;
  // Environment: 8 I32 controls, two RGBA colours and 4x4 F32 transform.
  const environment = Array.from({ length: 8 }, (_, i) => reader.i32(cursor + i * 4, "贴图环境"));
  cursor += 32;
  reader.ensure(cursor, 32, "贴图环境颜色"); cursor += 32;
  for (let i = 0; i < 16; i += 1) {
    const value = reader.f32(cursor + i * 4, "贴图坐标变换");
    if (value !== (i % 5 === 0 ? 1 : 0)) throw new JtFormatError("暂不支持非恒等 JT 贴图坐标变换", "attribute-encoding-unsupported");
  }
  cursor += 64;
  for (let i = 0; i < 4; i += 1) {
    if (reader.i32(cursor + i * 4, "自动纹理坐标生成") !== 0) throw new JtFormatError("暂不支持自动 JT 纹理坐标生成", "attribute-encoding-unsupported");
  }
  cursor += 16 + 64; // Four PlaneF32 reference planes, ignored only when all generation modes are zero.
  const textureChannel = reader.i32(cursor, "纹理通道"); cursor += 4;
  const coordinateSet = reader.i32(cursor, "纹理坐标通道"); cursor += 4;
  const emptyField = reader.u32(cursor, "纹理保留字段"); cursor += 4;
  const inlineFlag = reader.u8(cursor, "贴图内联标志"); cursor += 1;
  const imageCount = reader.i32(cursor, "贴图图片数量"); cursor += 4;
  if (textureType !== 2 || textureChannel !== 0 || coordinateSet < 0 || coordinateSet > 3
      || emptyField !== 0 || inlineFlag !== 1 || imageCount !== 1 || environment[0] !== 0
      || environment[6] !== 2 || environment[7] !== 0
      || ![1, 2].includes(environment[1]!) || ![1, 2].includes(environment[2]!)
      || ![1, 2, 3, 4].includes(environment[3]!) || ![1, 2, 3, 4].includes(environment[4]!)
      || environment[5] !== 1) {
    throw new JtFormatError("JT 贴图类型、通道、采样或外部存储不在安全映射范围", "attribute-encoding-unsupported");
  }
  const pixelFormat = reader.u32(cursor, "像素格式"); cursor += 4;
  const pixelType = reader.u32(cursor, "像素类型"); cursor += 4;
  const dimensionality = reader.i16(cursor, "图片维度"); cursor += 2;
  const alignment = reader.i16(cursor, "行对齐"); cursor += 2;
  const width = reader.i16(cursor, "图片宽度"); cursor += 2;
  const height = reader.i16(cursor, "图片高度"); cursor += 2;
  const depth = reader.i16(cursor, "图片深度"); cursor += 2;
  const border = reader.i16(cursor, "边界像素"); cursor += 2;
  reader.u32(cursor, "图片共享标志"); cursor += 4;
  const mipCount = reader.i16(cursor, "Mip 数量"); cursor += 2;
  const totalBytes = reader.i32(cursor, "图片字节数"); cursor += 4;
  const mipBytes = reader.i32(cursor, "Mip 字节数"); cursor += 4;
  const channels = pixelFormat === 1 ? 3 : pixelFormat === 2 ? 4 : 0;
  if (!channels || pixelType !== 3 || dimensionality !== 2 || alignment !== 1 || depth !== 1 || border !== 0
      || width < 1 || height < 1 || mipCount !== 1 || totalBytes !== width * height * channels
      || totalBytes !== mipBytes || totalBytes > MAX_IMAGE_BYTES || cursor + totalBytes !== reader.length) {
    throw new JtFormatError("JT 图片布局或长度不支持，拒绝推测解码", "attribute-encoding-unsupported");
  }
  return { objectId: element.objectId, textureChannel, textureSetIndex: coordinateSet,
    width, height, channels: channels as 3 | 4, pixels: reader.bytes(cursor, totalBytes, "贴图真实像素字节"),
    wrapS: environment[3]!, wrapT: environment[4]!, filter: environment[1]! };
}
