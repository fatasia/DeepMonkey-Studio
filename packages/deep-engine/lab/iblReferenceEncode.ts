/**
 * I-C19 对拍编码与比较：把 lab/iblPrefilterReference 的期望平面编成合法
 * RuntimePrefilteredIbl（rgba16float/base64-le，过 validateRuntimePrefilteredIbl），
 * 并提供 GPU 读回平面的对拍比较（maxAbs/maxRel/均值，RGB 三通道）。
 * 半精度编码合同与 runtimePackage/environmentBytes.visitIblBytes 一致：非负、非 Inf/NaN。
 */
import { visitIblBytes } from "../src/runtimePackage/environmentBytes.js";
import type { RuntimePrefilteredIbl } from "../src/runtimePackage/environmentTypes.js";
import { brdfLutReference, type IblPrefilterReference } from "./iblPrefilterReference.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** float32 → float16（round-to-nearest-even）；负值/NaN/Inf 一律钳 0，上溢钳最大有限 0x7BFF。 */
export function floatToHalf(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 65504) return 0x7bff;
  const f32 = new Float32Array(1); f32[0] = value;
  const bits = new Uint32Array(f32.buffer)[0]!;
  const exponent = ((bits >>> 23) & 0xff) - 112, mantissa = bits & 0x7fffff;
  if (exponent >= 0x1f) return 0x7bff;
  if (exponent > 0) {
    let half = (exponent << 10) | (mantissa >>> 13);
    const roundBit = mantissa & 0x1000, sticky = mantissa & 0x0fff;
    if (roundBit !== 0 && (sticky !== 0 || (half & 1) !== 0)) half++;
    return half;
  }
  if (exponent < -10) return 0;
  const full = 0x800000 | mantissa, shift = 14 - exponent;
  let half = full >>> shift;
  const remainder = full & ((1 << shift) - 1), halfway = 1 << (shift - 1);
  if (remainder > halfway || (remainder === halfway && (half & 1) !== 0)) half++;
  return half;
}

export function base64Encode(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset]!, second = offset + 1 < bytes.length ? bytes[offset + 1]! : 0;
    const third = offset + 2 < bytes.length ? bytes[offset + 2]! : 0;
    text += ALPHABET.charAt(first >>> 2) + ALPHABET.charAt(((first & 3) << 4) | (second >>> 4))
      + (offset + 1 < bytes.length ? ALPHABET.charAt(((second & 15) << 2) | (third >>> 6)) : "=")
      + (offset + 2 < bytes.length ? ALPHABET.charAt(third & 63) : "=");
  }
  return text;
}

/** RGB（alpha=1）或 RGBA 平面 → rgba16float 小端 base64；faces=6 为 cube mip，1 为 LUT 面。 */
export function encodeIblPlaneBase64(plane: Float32Array, size: number, faces: number,
  channels: 3 | 4): string {
  const expected = size * size * faces * channels;
  if (plane.length !== expected) throw new Error(`Reference plane holds ${plane.length} channels, expected ${expected}.`);
  const bytes = new Uint8Array(size * size * faces * 8);
  const view = new DataView(bytes.buffer);
  let texel = 0;
  for (let index = 0; index < expected; index += channels) for (let channel = 0; channel < 4; channel++, texel += 2) {
    const value = channel === 3 ? (channels === 4 ? plane[index + 3]! : 1) : plane[index + channel]!;
    view.setUint16(texel, floatToHalf(value), true);
  }
  return base64Encode(bytes);
}

export interface IblReferenceIdentity {
  readonly id: string;
  readonly revision: number;
  readonly contentHash: { readonly algorithm: "sha256"; readonly value: string };
  readonly license: string;
}

/** 期望生成器：参考预滤波 + DFG LUT → 合法 RuntimePrefilteredIbl（fail-closed 校验由消费方执行）。 */
export function encodeRuntimeIblReference(reference: IblPrefilterReference, identity: IblReferenceIdentity,
  lutWidth = 128): RuntimePrefilteredIbl {
  if (lutWidth > reference.specularSize) throw new Error("LUT width must not exceed the specular base size.");
  const lut = brdfLutReference(lutWidth);
  return {
    schema: "deep-engine.ibl-prefiltered", schemaVersion: 1, kind: "prefiltered-hdri",
    format: "rgba16float", encoding: "base64-le", faceOrder: "px-nx-py-ny-pz-nz",
    id: identity.id, revision: identity.revision,
    source: { contentHash: identity.contentHash, license: identity.license },
    specular: { mips: reference.specular.map((plane, level) => ({
      size: reference.specularSize >> level, dataBase64: encodeIblPlaneBase64(plane, reference.specularSize >> level, 6, 3) })) },
    diffuse: { mips: [{ size: reference.diffuseSize, dataBase64: encodeIblPlaneBase64(reference.diffuse, reference.diffuseSize, 6, 3) }] },
    brdfLut: { width: lutWidth, height: lutWidth, dataBase64: encodeIblPlaneBase64(lut, lutWidth, 1, 4) },
  };
}

export interface IblComparison {
  readonly samples: number;
  readonly maxAbsError: number;
  readonly meanAbsError: number;
  readonly maxRelError: number;
  readonly pass: boolean;
}

/**
 * GPU 读回对拍：expected 为 RGB 交错参考；actual 默认 rgba 读回（stride 4），
 * tolerance 沿 J3 经验值 0.002（fp16 存储 + fp32 采样差异）。
 */
export function compareIblReference(expected: ArrayLike<number>, actual: ArrayLike<number>,
  options: { readonly actualStride?: number; readonly actualOffset?: number; readonly tolerance?: number } = {}): IblComparison {
  const stride = options.actualStride ?? 4, offset = options.actualOffset ?? 0;
  const tolerance = options.tolerance ?? 0.002;
  const samples = expected.length / 3;
  if (!Number.isInteger(samples) || actual.length < samples * stride + offset) {
    throw new Error("IBL comparison inputs have inconsistent lengths.");
  }
  let maxAbs = 0, sum = 0, maxRel = 0;
  for (let index = 0; index < samples; index++) for (let channel = 0; channel < 3; channel++) {
    const expectedValue = expected[index * 3 + channel]!, actualValue = actual[offset + index * stride + channel]!;
    const difference = Math.abs(expectedValue - actualValue);
    maxAbs = Math.max(maxAbs, difference); maxRel = Math.max(maxRel, difference / Math.max(Math.abs(expectedValue), 1e-6));
    sum += difference;
  }
  return { samples, maxAbsError: maxAbs, meanAbsError: sum / (samples * 3), maxRelError: maxRel, pass: maxAbs <= tolerance };
}

/** 便于 GPU 探针直接消费的重定基 mip 期望（链尾保留，语义与 rebasedReferenceMips 相同）。 */
export function encodeRebasedMipBase64(reference: IblPrefilterReference, keptMips: number, level: number): string {
  const raw = reference.specular.length;
  if (level < 0 || level >= keptMips) throw new Error("Rebased level escapes the kept chain.");
  const size = reference.specularSize >> (raw - keptMips + level);
  return encodeIblPlaneBase64(reference.specular[raw - keptMips + level]!, size, 6, 3);
}
