/** three r185 sheen / iridescence / volume 数学的 CPU 参考(GLSL 逐式移植,float64)。
 * 仅供测试与真机对拍使用;生产渲染不引用本模块。 */

import type { Rgb } from "./materialAdvancedParameters.js";

const PI = Math.PI;
const mapRgb = (a: Rgb, f: (v: number, i: number) => number): Rgb => [f(a[0], 0), f(a[1], 1), f(a[2], 2)];
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** three F_Schlick(f0, 1.0, cosine):exp2 近似形式。 */
export function fSchlick(f0: number, cosine: number): number {
  const f = Math.pow(2, (-5.55473 * cosine - 6.98316) * cosine);
  return f0 * (1 - f) + f;
}

export function evalSensitivity(opd: number, shift: Rgb): Rgb {
  const phase = 2 * PI * opd * 1e-9;
  const val = [5.4856e-13, 4.4201e-13, 5.2481e-13], pos = [1.6810e+06, 1.7953e+06, 2.2084e+06];
  const vr = [4.3278e+09, 9.3046e+09, 6.6121e+09];
  const xyz = [0, 1, 2].map(i => val[i]! * Math.sqrt(2 * PI * vr[i]!) * Math.cos(pos[i]! * phase + shift[i]!)
    * Math.exp(-phase * phase * vr[i]!)) as [number, number, number];
  xyz[0] += 9.7470e-14 * Math.sqrt(2 * PI * 4.5282e+09) * Math.cos(2.2399e+06 * phase + shift[0]) * Math.exp(-4.5282e+09 * phase * phase);
  for (let i = 0; i < 3; i++) xyz[i] = xyz[i]! / 1.0685e-7;
  return [
    3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2],
    -0.9692660 * xyz[0] + 1.8760108 * xyz[1] + 0.0415560 * xyz[2],
    0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2],
  ];
}

export function evalIridescence(outsideIor: number, eta2: number, cosTheta1: number, thickness: number, baseF0: Rgb): Rgb {
  const iridIor = outsideIor + (eta2 - outsideIor) * smoothstep(0, 0.03, thickness);
  const sinTheta2Sq = (outsideIor / iridIor) ** 2 * (1 - cosTheta1 * cosTheta1);
  const cosTheta2Sq = 1 - sinTheta2Sq;
  if (cosTheta2Sq < 0) return [1, 1, 1];
  const cosTheta2 = Math.sqrt(cosTheta2Sq);
  const r0 = ((iridIor - outsideIor) / (iridIor + outsideIor)) ** 2;
  const r12 = fSchlick(r0, cosTheta1);
  const t121 = 1 - r12;
  const phi12 = iridIor < outsideIor ? PI : 0, phi21 = PI - phi12;
  const sqrtF0 = mapRgb(baseF0, v => Math.sqrt(clamp(v, 0, 0.9999)));
  const baseIor = mapRgb(sqrtF0, v => (1 + v) / (1 - v));
  const r1 = mapRgb(baseIor, v => ((v - iridIor) / (v + iridIor)) ** 2);
  const r23 = mapRgb(r1, v => fSchlick(v, cosTheta2));
  const phi23 = mapRgb(baseIor, v => (v < iridIor ? PI : 0));
  const opd = 2 * iridIor * thickness * cosTheta2;
  const phi = mapRgb(phi23, v => phi21 + v);
  const r123 = mapRgb(r23, v => clamp(r12 * v, 1e-5, 0.9999));
  const rt123 = mapRgb(r123, Math.sqrt);
  const rs = mapRgb(r23, (v, i) => t121 * t121 * v / (1 - r123[i]!));
  const out: [number, number, number] = [r12 + rs[0], r12 + rs[1], r12 + rs[2]];
  let cm = mapRgb(rs, v => v - t121);
  for (let m = 1; m <= 2; m++) {
    cm = mapRgb(cm, (v, i) => v * rt123[i]!);
    const sm = evalSensitivity(m * opd, mapRgb(phi, v => m * v));
    for (let i = 0; i < 3; i++) out[i] = out[i]! + cm[i]! * 2 * sm[i]!;
  }
  return mapRgb(out, v => Math.max(v, 0));
}

/** three Schlick_to_F0(f, f90=1, dotVH)。 */
export function schlickToF0(f: Rgb, cosine: number): Rgb {
  const x = clamp(1 - cosine, 0, 1);
  const x5 = clamp(x * x * x * x * x, 0, 0.9999);
  return mapRgb(f, v => (v - x5) / (1 - x5));
}

export function dCharlie(roughness: number, nh: number): number {
  const invAlpha = 1 / (roughness * roughness);
  const sin2h = Math.max(1 - nh * nh, 0.0078125);
  return (2 + invAlpha) * Math.pow(sin2h, invAlpha * 0.5) / (2 * PI);
}

export function vNeubelt(nv: number, nl: number): number {
  return clamp(1 / (4 * Math.max(nl + nv - nl * nv, 1e-6)), 0, 1);
}

/** three IBLSheenBRDF:Charlie sheen 半球积分的曲线拟合。 */
export function iblSheenBrdf(nv: number, roughness: number): number {
  const r2 = roughness * roughness, rInv = 1 / (roughness + 0.1);
  const a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * rInv;
  const b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * rInv;
  return clamp(Math.exp(a * nv + b), 0, 1);
}

/** three volumeAttenuation(Beer-Lambert);attenuationDistance=Infinity → 不衰减。 */
export function volumeAttenuation(distance: number, color: Rgb, attenuationDistance: number): Rgb {
  if (!Number.isFinite(attenuationDistance)) return [1, 1, 1];
  return mapRgb(color, v => Math.exp(Math.log(Math.max(v, 1e-6)) * (distance / attenuationDistance)));
}

/** three 直射 sheen 项(不含 irradiance 与 sheenColor 以外的因子):sheenColor·D·V。 */
export function sheenDirectBrdf(color: Rgb, roughness: number, nv: number, nl: number, nh: number): Rgb {
  const scale = dCharlie(roughness, nh) * vNeubelt(nv, nl);
  return mapRgb(color, v => v * scale);
}

/** three 直射 sheen 能量补偿:1 - max3(sheenColor)·max(A(nv), A(nl))。 */
export function sheenDirectEnergy(color: Rgb, roughness: number, nv: number, nl: number): number {
  return 1 - Math.max(...color) * Math.max(iblSheenBrdf(nv, roughness), iblSheenBrdf(nl, roughness));
}

export function sheenIndirectEnergy(color: Rgb, roughness: number, nv: number): number {
  return 1 - Math.max(...color) * iblSheenBrdf(nv, roughness);
}
