/** T08 GPU 联测切片 · 扩展材质参数的 GPU 存储 ABI(单一来源)。
 * 打包顺序即 MATERIAL_PARAMETER_KEYS 顺序,由 materialParameters.packMaterialParameterArray
 * 产出 6 个 f32;本模块声明该块在 WGSL 中的结构体文本、字节 stride,以及与
 * 既有 v5 实例 ABI(materialInstanceAbi:MATERIAL_IOR_FLOAT_OFFSET=15,即 normalColumn0.w)
 * 的 IOR 对齐规则。实例 stride(144B)内并无其余 5 个参数的空位,实例嵌入需要 ABI 修订,
 * 本切片只钉死 6-float 独立块的布局,不静默改 stride。 */

import { MATERIAL_IOR_FLOAT_OFFSET, packMaterialIor } from "../materialInstanceAbi.js";
import { MATERIAL_PARAMETER_KEYS, packMaterialParameterArray,
  type ExtendedMaterialParameters } from "./materialParameters.js";

/** 6-float 扩展参数块;顺序 = MATERIAL_PARAMETER_KEYS = [ior, clearcoatFactor, clearcoatRoughness,
 * anisotropyStrength, anisotropyRotation, transmissionFactor]。 */
export const EXTENDED_PARAMETER_FLOAT_COUNT = MATERIAL_PARAMETER_KEYS.length as 6;
/** f32 块字节长度;WGSL 结构体各成员 align=4,作为 storage 数组元素时 stride 即 24B。 */
export const EXTENDED_PARAMETER_STRIDE_BYTES = EXTENDED_PARAMETER_FLOAT_COUNT * 4;

/** WGSL 结构体文本(求值核按名引用;修改打包顺序必须先改这里再改 schema)。 */
export const EXTENDED_PARAMETER_WGSL_STRUCT = `struct DeepMaterialEvalParams {
  ior: f32,
  clearcoatFactor: f32,
  clearcoatRoughness: f32,
  anisotropyStrength: f32,
  anisotropyRotation: f32,
  transmissionFactor: f32,
}`;

/** 打包为可上传 GPU 的 f32 块(f32array 形态;数值语义与 packMaterialParameterArray 逐位一致)。 */
export function packExtendedParameterBlock(params: ExtendedMaterialParameters): Float32Array {
  const packed = packMaterialParameterArray(params);
  if (packed.length !== EXTENDED_PARAMETER_FLOAT_COUNT) {
    throw new Error("Extended parameter block ABI mismatch against MATERIAL_PARAMETER_KEYS.");
  }
  return Float32Array.from(packed);
}

/** v5 实例 ABI 的 IOR 槽位期望值:1.5 编码为哨兵 0(legacy 语义),其余为 fround(ior)。 */
export function expectedV5InstanceIorSlot(params: ExtendedMaterialParameters): number {
  return packMaterialIor(params.ior, { materialAbi: "deep.pbr.mesh.v5" });
}

/** 交叉校验:6-float 块的 ior 与 v5 实例槽位(normalColumn0.w)必须描述同一折射率。
 * 打包错/双写漂移在此 fail-closed,而不是在 GPU 上静默求值出错误 lobe。 */
export function assertIorAbiAlignment(
  params: ExtendedMaterialParameters, instanceFloats: ArrayLike<number>,
): void {
  const block = packExtendedParameterBlock(params);
  if (block[0] !== Math.fround(params.ior)) {
    throw new Error("Extended parameter block IOR slot does not match schema value.");
  }
  const slot = instanceFloats[MATERIAL_IOR_FLOAT_OFFSET];
  const expected = expectedV5InstanceIorSlot(params);
  if (slot !== expected) {
    throw new Error(`v5 instance IOR slot mismatch: got ${slot}, expected ${expected}.`);
  }
}

/** 实例嵌入状态声明:剩余 5 参数在 v5 144B stride 内无槽位,嵌入需显式 ABI 修订(v6)。 */
export const EXTENDED_PARAMETER_INSTANCE_EMBEDDING = "requires-abi-revision-v6" as const;
