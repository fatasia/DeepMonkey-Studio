/** T08 材质覆盖切片 1 · 线性色块黄金表(冻结的测试向量)。
 * 输入全部为线性 RGB;期望值由 materialEvaluate 的 CPU 参考生成后冻结,
 * 量化单位 1/255:int = round(component × 255),比较容差 ±1 量子。
 * GPU 联测直接导入本表作为对照,不得在 GPU 侧重新生成期望值。 */

import { evaluateExtendedMaterialDirect, type MaterialEvaluationGeometry, type StandardSurfaceInputs, type Vec3 } from "./materialEvaluate.js";
import type { ExtendedMaterialParameters } from "./materialParameters.js";

export type { Vec3 };

/** 固定直接光方向(单位化后使用)。 */
export const GOLDEN_LIGHT_DIRECTION: Vec3 = [0.45, 0.3, 0.84];
/** 黄金表统一使用单位 radiance,保证 BRDF 级对照且便于 1/255 量化。 */
export const GOLDEN_RADIANCE: Vec3 = [1, 1, 1];

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** 三个观察角:正入射 / 36.9° / 70°( grazing 但 nDotV=0.342,远离数值退化区)。 */
export interface GoldenViewLabel { readonly label: string; readonly view: Vec3 }
export const GOLDEN_VIEW_DIRECTIONS: readonly GoldenViewLabel[] = Object.freeze([
  { label: "normal", view: [0, 0, 1] },
  { label: "mid", view: normalize([0.6, 0, 0.8]) },
  { label: "grazing", view: normalize([0.94, 0, 0.342]) },
]);

export interface GoldenSwatch {
  readonly id: string;
  readonly surface: StandardSurfaceInputs;
  readonly extended: Partial<ExtendedMaterialParameters>;
}

/** 9 个纯线性色块 + 5 个工业材质(拉丝金属/工业玻璃/车漆/阳极氧化铝/清漆碳纤维)。 */
export const GOLDEN_SWATCHES: readonly GoldenSwatch[] = Object.freeze([
  { id: "white-dielectric", surface: { baseColor: [1, 1, 1], metallic: 0, roughness: 0.5 }, extended: {} },
  { id: "gray50-dielectric", surface: { baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 }, extended: {} },
  { id: "black-dielectric", surface: { baseColor: [0, 0, 0], metallic: 0, roughness: 0.5 }, extended: {} },
  { id: "red-dielectric", surface: { baseColor: [1, 0, 0], metallic: 0, roughness: 0.5 }, extended: {} },
  { id: "green-dielectric", surface: { baseColor: [0, 1, 0], metallic: 0, roughness: 0.5 }, extended: {} },
  { id: "blue-dielectric", surface: { baseColor: [0, 0, 1], metallic: 0, roughness: 0.5 }, extended: {} },
  { id: "yellow-metal", surface: { baseColor: [1, 0.766, 0.336], metallic: 1, roughness: 0.25 }, extended: {} },
  { id: "cyan-metal", surface: { baseColor: [0.336, 0.766, 1], metallic: 1, roughness: 0.4 }, extended: {} },
  { id: "magenta-metal", surface: { baseColor: [1, 0.336, 0.9], metallic: 1, roughness: 0.6 }, extended: {} },
  { id: "brushed-steel", surface: { baseColor: [0.55, 0.57, 0.6], metallic: 1, roughness: 0.35 },
    extended: { anisotropy: { strength: 0.8, rotation: 0.6 } } },
  { id: "industrial-glass", surface: { baseColor: [0.92, 0.95, 0.97], metallic: 0, roughness: 0.35 },
    extended: { transmission: { factor: 1 }, ior: 1.52 } },
  { id: "car-paint", surface: { baseColor: [0.043, 0.14, 0.42], metallic: 0.9, roughness: 0.4 },
    extended: { clearcoat: { factor: 1, roughness: 0.45 } } },
  { id: "anodized-alu", surface: { baseColor: [0.3, 0.32, 0.35], metallic: 1, roughness: 0.25 },
    extended: { anisotropy: { strength: 0.5, rotation: -1.2 } } },
  { id: "coated-carbon", surface: { baseColor: [0.02, 0.02, 0.022], metallic: 0, roughness: 0.55 },
    extended: { clearcoat: { factor: 0.9, roughness: 0.3 } } },
]);

export function goldenGeometry(view: Vec3): MaterialEvaluationGeometry {
  return { normal: [0, 0, 1], view, light: GOLDEN_LIGHT_DIRECTION, tangent: [1, 0, 0] };
}

export interface GoldenExpectedRow {
  readonly swatch: string;
  readonly view: string;
  /** 每通道 round(component×255);分量顺序 [diffuse, specular, clearcoat, transmission]×RGB。 */
  readonly quantized: readonly number[];
}

/** 冻结期望表:由生成流程写入,禁止手改;测试断言重算值在 ±1 量子内。 */
export const GOLDEN_EXPECTED: readonly GoldenExpectedRow[] = Object.freeze([
  { swatch: "white-dielectric", view: "normal", quantized: [66, 66, 66, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "white-dielectric", view: "mid", quantized: [66, 66, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "white-dielectric", view: "grazing", quantized: [66, 66, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "gray50-dielectric", view: "normal", quantized: [33, 33, 33, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "gray50-dielectric", view: "mid", quantized: [33, 33, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "gray50-dielectric", view: "grazing", quantized: [33, 33, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "black-dielectric", view: "normal", quantized: [0, 0, 0, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "black-dielectric", view: "mid", quantized: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "black-dielectric", view: "grazing", quantized: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "red-dielectric", view: "normal", quantized: [66, 0, 0, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "red-dielectric", view: "mid", quantized: [66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "red-dielectric", view: "grazing", quantized: [66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "green-dielectric", view: "normal", quantized: [0, 66, 0, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "green-dielectric", view: "mid", quantized: [0, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "green-dielectric", view: "grazing", quantized: [0, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "blue-dielectric", view: "normal", quantized: [0, 0, 66, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "blue-dielectric", view: "mid", quantized: [0, 0, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "blue-dielectric", view: "grazing", quantized: [0, 0, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "yellow-metal", view: "normal", quantized: [0, 0, 0, 11, 8, 4, 0, 0, 0, 0, 0, 0] },
  { swatch: "yellow-metal", view: "mid", quantized: [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "yellow-metal", view: "grazing", quantized: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "cyan-metal", view: "normal", quantized: [0, 0, 0, 16, 36, 47, 0, 0, 0, 0, 0, 0] },
  { swatch: "cyan-metal", view: "mid", quantized: [0, 0, 0, 2, 4, 6, 0, 0, 0, 0, 0, 0] },
  { swatch: "cyan-metal", view: "grazing", quantized: [0, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "magenta-metal", view: "normal", quantized: [0, 0, 0, 63, 21, 56, 0, 0, 0, 0, 0, 0] },
  { swatch: "magenta-metal", view: "mid", quantized: [0, 0, 0, 18, 6, 16, 0, 0, 0, 0, 0, 0] },
  { swatch: "magenta-metal", view: "grazing", quantized: [0, 0, 0, 11, 4, 10, 0, 0, 0, 0, 0, 0] },
  { swatch: "brushed-steel", view: "normal", quantized: [0, 0, 0, 61, 63, 66, 0, 0, 0, 0, 0, 0] },
  { swatch: "brushed-steel", view: "mid", quantized: [0, 0, 0, 7, 7, 7, 0, 0, 0, 0, 0, 0] },
  { swatch: "brushed-steel", view: "grazing", quantized: [0, 0, 0, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "industrial-glass", view: "normal", quantized: [0, 0, 0, 1, 1, 1, 0, 0, 0, 60, 62, 63] },
  { swatch: "industrial-glass", view: "mid", quantized: [0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 62, 63] },
  { swatch: "industrial-glass", view: "grazing", quantized: [0, 0, 0, 0, 0, 0, 0, 0, 0, 53, 54, 56] },
  { swatch: "car-paint", view: "normal", quantized: [0, 1, 2, 2, 6, 17, 2, 2, 2, 0, 0, 0] },
  { swatch: "car-paint", view: "mid", quantized: [0, 1, 2, 0, 1, 2, 0, 0, 0, 0, 0, 0] },
  { swatch: "car-paint", view: "grazing", quantized: [0, 1, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0] },
  { swatch: "anodized-alu", view: "normal", quantized: [0, 0, 0, 2, 2, 3, 0, 0, 0, 0, 0, 0] },
  { swatch: "anodized-alu", view: "mid", quantized: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "anodized-alu", view: "grazing", quantized: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { swatch: "coated-carbon", view: "normal", quantized: [1, 1, 1, 3, 3, 3, 1, 1, 1, 0, 0, 0] },
  { swatch: "coated-carbon", view: "mid", quantized: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0] },
  { swatch: "coated-carbon", view: "grazing", quantized: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
]);
