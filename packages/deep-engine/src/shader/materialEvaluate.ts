/** T08 材质覆盖切片 1 · CPU 直接光照求值参考(GPU 求值的黄金对照)。
 * 复用并扩展既有路径:GGX/Smith/Schlick 主干与 surfaceLowering 逐项对齐;
 * clearcoat 层叠直接调用 shaderAuthoring 的 evaluateClearcoatReference(v3 参考),
 * 介电 F0 复用 materialDielectric.dielectricF0(ior=1.5 精确退化为 legacy 0.04)。
 * 输出线性 RGB;radiance=[1,1,1] 时 rgb 即 BRDF·cosθL,可直接做半球能量积分。 */

import { dielectricF0 } from "../materialDielectric.js";
import { evaluateClearcoatReference } from "../shaderAuthoring/packageClearcoat.js";
import { normalizeExtendedMaterialParameters, type ExtendedMaterialParameters } from "./materialParameters.js";

export type Vec3 = readonly [number, number, number];

/** 既有 stock PBR 的直接光 radiance(surfaceLowering directRadiance),黄金表沿用。 */
export const STOCK_DIRECT_RADIANCE: Vec3 = Object.freeze([2.5, 2.4, 2.25]);

export interface StandardSurfaceInputs {
  /** 线性空间 0..1。 */
  readonly baseColor: Vec3;
  readonly metallic: number;
  readonly roughness: number;
}

export interface MaterialEvaluationGeometry {
  readonly normal: Vec3;
  readonly view: Vec3;
  readonly light: Vec3;
  /** 各向异性切线方向;默认 [1,0,0],与法线正交化后使用。 */
  readonly tangent?: Vec3;
}

export interface MaterialEvaluationComponents {
  /** 各 lobe 已含层叠衰减与 radiance·nDotL,四分量之和恒等于 rgb。 */
  readonly diffuse: Vec3;
  readonly specular: Vec3;
  readonly clearcoat: Vec3;
  readonly transmission: Vec3;
}

export interface MaterialEvaluationResult {
  /** 线性 RGB,直接光照、shadow=1;不含 IBL 与 emission。 */
  readonly rgb: Vec3;
  readonly components: MaterialEvaluationComponents;
}

const PI = Math.PI;
const ROUGHNESS_FLOOR = 0.045;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const map3 = (a: Vec3, f: (value: number) => number): Vec3 => [f(a[0]), f(a[1]), f(a[2])];
const mul3 = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

function safeNormalize(value: Vec3, fallback: Vec3): Vec3 {
  const lengthSquared = dot3(value, value);
  if (lengthSquared <= 1e-8) return fallback;
  const scale = 1 / Math.sqrt(lengthSquared);
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function schlickScalar(f0: number, cosine: number): number {
  return f0 + (1 - f0) * (1 - cosine) ** 5;
}

function schlickVector(f0: Vec3, cosine: number): Vec3 {
  return map3(f0, (channel) => schlickScalar(channel, cosine));
}

function distributionGgx(nDotH: number, roughness: number): number {
  const alpha = roughness * roughness, alpha2 = alpha * alpha;
  const denominator = nDotH * nDotH * (alpha2 - 1) + 1;
  return alpha2 / Math.max(PI * denominator * denominator, 1e-6);
}

/** Burley 各向异性 GGX;ax=alpha·(1+strength),ay=alpha。strength=0 时精确等于各向同性 D。 */
function distributionGgxAnisotropic(
  tDotH: number, bDotH: number, nDotH: number, alpha: number, strength: number,
): number {
  const ax = Math.max(alpha * (1 + strength), 1e-3), ay = Math.max(alpha, 1e-3);
  const d = (tDotH / ax) ** 2 + (bDotH / ay) ** 2 + nDotH * nDotH;
  return 1 / Math.max(PI * ax * ay * d * d, 1e-12);
}

function geometrySchlick(nDotX: number, roughness: number): number {
  const k = (roughness + 1) ** 2 / 8;
  return nDotX / Math.max(nDotX * (1 - k) + k, 1e-4);
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 切线绕法线旋转 rotation 弧度,并正交化;退化时回退 [1,0,0]/[0,1,0]。 */
function anisotropicFrame(rotation: number, tangent: Vec3 | undefined, normal: Vec3): { readonly t: Vec3; readonly b: Vec3 } {
  const raw = tangent ?? [1, 0, 0];
  const projection = dot3(raw, normal);
  const projected = safeNormalize([raw[0] - normal[0] * projection, raw[1] - normal[1] * projection,
    raw[2] - normal[2] * projection], [1, 0, 0]);
  const cosRotation = Math.cos(rotation), sinRotation = Math.sin(rotation);
  const bitangent = safeNormalize(cross3(normal, projected), [0, 1, 0]);
  return {
    t: [projected[0] * cosRotation + bitangent[0] * sinRotation,
      projected[1] * cosRotation + bitangent[1] * sinRotation,
      projected[2] * cosRotation + bitangent[2] * sinRotation],
    b: [bitangent[0] * cosRotation - projected[0] * sinRotation,
      bitangent[1] * cosRotation - projected[1] * sinRotation,
      bitangent[2] * cosRotation - projected[2] * sinRotation],
  };
}

/** 直接光照求值参考。参数 fail-closed 校验;向量按 backend-normalizes 语义归一化。 */
export function evaluateExtendedMaterialDirect(
  surface: StandardSurfaceInputs,
  extended: Partial<ExtendedMaterialParameters>,
  geometry: MaterialEvaluationGeometry,
  radiance: Vec3 = STOCK_DIRECT_RADIANCE,
): MaterialEvaluationResult {
  const params = normalizeExtendedMaterialParameters(extended);
  if (![surface.metallic, surface.roughness, ...surface.baseColor, ...geometry.normal, ...geometry.view,
    ...geometry.light, ...radiance].every(Number.isFinite)) {
    throw new RangeError("Material evaluation inputs must be finite.");
  }
  const normal = safeNormalize(geometry.normal, [0, 1, 0]);
  const view = safeNormalize(geometry.view, [0, 0, 1]);
  const light = safeNormalize(geometry.light, [0, 1, 0]);
  const halfVector = safeNormalize([view[0] + light[0], view[1] + light[1], view[2] + light[2]], normal);

  const metallic = clamp(surface.metallic, 0, 1);
  const roughness = clamp(surface.roughness, ROUGHNESS_FLOOR, 1);
  const baseColor = map3(surface.baseColor, (value) => Math.max(0, value));
  const nDotL = clamp(dot3(normal, light), 0, 1);
  const nDotV = clamp(dot3(normal, view), 1e-4, 1);
  const nDotH = clamp(dot3(normal, halfVector), 0, 1);
  const vDotH = clamp(dot3(view, halfVector), 0, 1);

  const f0Dielectric = dielectricF0(params.ior);
  const f0: Vec3 = [f0Dielectric + (baseColor[0] - f0Dielectric) * metallic,
    f0Dielectric + (baseColor[1] - f0Dielectric) * metallic,
    f0Dielectric + (baseColor[2] - f0Dielectric) * metallic];
  const fresnel = schlickVector(f0, vDotH);

  const alpha = roughness * roughness;
  let distribution = distributionGgx(nDotH, roughness);
  if (params.anisotropy.strength !== 0) {
    const frame = anisotropicFrame(params.anisotropy.rotation, geometry.tangent, normal);
    distribution = distributionGgxAnisotropic(dot3(frame.t, halfVector), dot3(frame.b, halfVector),
      nDotH, alpha, params.anisotropy.strength);
  }
  const geometryTerm = geometrySchlick(nDotV, roughness) * geometrySchlick(nDotL, roughness);
  const specularScalar = distribution * geometryTerm / Math.max(4 * nDotV * nDotL, 1e-4);
  const specular = scale3(mul3(fresnel, [specularScalar, specularScalar, specularScalar]), 1);

  const diffuse = scale3(mul3(map3(fresnel, (value) => 1 - value), baseColor),
    (1 - metallic) / PI);

  const transmission = params.transmission.factor;
  const transmittance = schlickScalar(f0Dielectric, nDotV);
  /** 朗伯型透射 BRDF(与 diffuse 同构);nDotL 由外部统一乘,避免双重计入。 */
  const transmissionLobe = scale3(mul3(baseColor, [1 - metallic, 1 - metallic, 1 - metallic]),
    transmission * (1 - transmittance) / PI);

  const scaledDiffuse = scale3(diffuse, 1 - transmission);
  const coat = evaluateClearcoatReference({
    factor: params.clearcoat.factor, roughness: params.clearcoat.roughness,
    nDotL, nDotV, nDotH, vDotH, dfg: [0, 0] as const,
  });
  const base: Vec3 = [scaledDiffuse[0] + specular[0] + transmissionLobe[0],
    scaledDiffuse[1] + specular[1] + transmissionLobe[1],
    scaledDiffuse[2] + specular[2] + transmissionLobe[2]];
  const layered: Vec3 = [base[0] * coat.directBaseAttenuation + coat.directLobe,
    base[1] * coat.directBaseAttenuation + coat.directLobe,
    base[2] * coat.directBaseAttenuation + coat.directLobe];
  const factor = radiance[0] * nDotL, factorG = radiance[1] * nDotL, factorB = radiance[2] * nDotL;
  const attenuation = coat.directBaseAttenuation;
  const components: MaterialEvaluationComponents = {
    diffuse: [scaledDiffuse[0] * attenuation * factor, scaledDiffuse[1] * attenuation * factorG,
      scaledDiffuse[2] * attenuation * factorB],
    specular: [specular[0] * attenuation * factor, specular[1] * attenuation * factorG,
      specular[2] * attenuation * factorB],
    clearcoat: [coat.directLobe * factor, coat.directLobe * factorG, coat.directLobe * factorB],
    transmission: [transmissionLobe[0] * attenuation * factor, transmissionLobe[1] * attenuation * factorG,
      transmissionLobe[2] * attenuation * factorB],
  };
  const rgb: Vec3 = [layered[0] * factor, layered[1] * factorG, layered[2] * factorB];
  return { rgb: Object.freeze(rgb), components: Object.freeze(components) };
}
