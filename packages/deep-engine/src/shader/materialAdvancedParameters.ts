/** 高级 PBR 材质参数(sheen / iridescence / volume):对齐 three r185 MeshPhysicalMaterial 语义。
 * 独立于 6-float 扩展参数块(MATERIAL_PARAMETER_KEYS 不变),打包为 12 float 的 advanced 带,
 * 仅在 advancedMaterials 管线变体里占用 uniform(偏移 48..59)。全部字段 float32 语义。 */

export type Rgb = readonly [number, number, number];

export interface MaterialSheenParameters {
  /** 光泽层颜色,线性 0..1;全 0 = 无 sheen(three 默认)。 */
  readonly color: Rgb;
  /** 0..1;求值时夹取到 [0.0001, 1]。 */
  readonly roughness: number;
}

export interface MaterialIridescenceParameters {
  /** 0..1;0 = 无薄膜干涉。 */
  readonly factor: number;
  /** 薄膜折射率 1..3(three 默认 1.3)。 */
  readonly ior: number;
  /** 薄膜厚度(nm);three 无贴图时取 iridescenceThicknessRange[1]。0 时 three 关闭 iridescence。 */
  readonly thickness: number;
}

export interface MaterialVolumeParameters {
  /** 体积厚度(世界单位);three `thickness`。仅 transmission>0 时有意义。 */
  readonly thickness: number;
  /** Beer-Lambert 衰减色,(0,1];three `attenuationColor`。 */
  readonly attenuationColor: Rgb;
  /** 衰减距离;缺省/Infinity = 不衰减(three 默认)。缺省形态可经 JSON 往返。 */
  readonly attenuationDistance?: number | undefined;
}

export interface AdvancedMaterialParameters {
  readonly sheen?: MaterialSheenParameters | undefined;
  readonly iridescence?: MaterialIridescenceParameters | undefined;
  readonly volume?: MaterialVolumeParameters | undefined;
}

export interface NormalizedAdvancedMaterialParameters {
  readonly sheen: MaterialSheenParameters;
  readonly iridescence: MaterialIridescenceParameters;
  readonly volume: Required<MaterialVolumeParameters>;
}

export const DEFAULT_ADVANCED_MATERIAL_PARAMETERS: NormalizedAdvancedMaterialParameters = Object.freeze({
  sheen: Object.freeze({ color: Object.freeze([0, 0, 0] as const), roughness: 1 }),
  iridescence: Object.freeze({ factor: 0, ior: 1.3, thickness: 400 }),
  volume: Object.freeze({ thickness: 0, attenuationColor: Object.freeze([1, 1, 1] as const), attenuationDistance: Infinity }),
});

/** advanced 带 float 数;顺序:sheen.rgb, sheen.roughness, irid.factor, irid.ior, irid.thickness,
 * volume.thickness, attenuation.rgb, attenuationDistance(0 = Infinity 哨兵)。 */
export const ADVANCED_PARAMETER_FLOAT_COUNT = 12 as const;
/** 材质 uniform 内 advanced 带起始 float 偏移(紧随 40..47 扩展带)。 */
export const MATERIAL_PARAMETER_ADVANCED_BAND_FLOAT_OFFSET = 48 as const;
/** advanced 管线变体的材质 uniform 总 float 数(240B,16B 对齐)。 */
export const MATERIAL_PARAMETER_ADVANCED_FLOATS = 60 as const;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const f32 = (value: number): number => Math.fround(value);

function rgb(value: Rgb | undefined, fallback: Rgb, label: string, min: number, max: number): Rgb {
  const source = value ?? fallback;
  if (!Array.isArray(source) || source.length !== 3
    || !source.every(component => finite(component) && component >= min && component <= max)) {
    throw new RangeError(`${label} must be three finite floats in ${min}..${max}.`);
  }
  return Object.freeze([f32(source[0]!), f32(source[1]!), f32(source[2]!)] as const);
}

function ranged(value: number | undefined, fallback: number, label: string, min: number, max: number): number {
  const source = value ?? fallback;
  if (!finite(source) || source < min || source > max) throw new RangeError(`${label} must be a finite float in ${min}..${max}.`);
  return f32(source);
}

/** fail-closed 归一化:越界/非有限值抛 RangeError,不静默夹取。 */
export function normalizeAdvancedMaterialParameters(raw: AdvancedMaterialParameters): NormalizedAdvancedMaterialParameters {
  const d = DEFAULT_ADVANCED_MATERIAL_PARAMETERS;
  const distance = raw.volume?.attenuationDistance ?? Infinity;
  if (distance !== Infinity && (!finite(distance) || distance <= 0 || !Number.isFinite(f32(distance)))) {
    throw new RangeError("Volume attenuationDistance must be Infinity or a positive finite float32.");
  }
  const thickness = raw.volume?.thickness ?? 0;
  if (!finite(thickness) || thickness < 0 || !Number.isFinite(f32(thickness))) {
    throw new RangeError("Volume thickness must be a nonnegative finite float32.");
  }
  return Object.freeze({
    sheen: Object.freeze({
      color: rgb(raw.sheen?.color, d.sheen.color, "Sheen color", 0, 1),
      roughness: ranged(raw.sheen?.roughness, d.sheen.roughness, "Sheen roughness", 0, 1),
    }),
    iridescence: Object.freeze({
      factor: ranged(raw.iridescence?.factor, d.iridescence.factor, "Iridescence factor", 0, 1),
      ior: ranged(raw.iridescence?.ior, d.iridescence.ior, "Iridescence IOR", 1, 3),
      thickness: ranged(raw.iridescence?.thickness, d.iridescence.thickness, "Iridescence thickness (nm)", 0, 10000),
    }),
    volume: Object.freeze({
      thickness: f32(thickness),
      attenuationColor: rgb(raw.volume?.attenuationColor, d.volume.attenuationColor, "Volume attenuationColor", 1e-6, 1),
      attenuationDistance: distance === Infinity ? Infinity : f32(distance),
    }),
  });
}

/** 任一高级特性在场才为 true;全默认材质不应进入高级着色分支。 */
export function hasAdvancedMaterialFeatures(params: NormalizedAdvancedMaterialParameters): boolean {
  return Math.max(...params.sheen.color) > 0
    || (params.iridescence.factor > 0 && params.iridescence.thickness > 0)
    || params.volume.thickness > 0;
}

export function packAdvancedParameterBlock(params: AdvancedMaterialParameters): Float32Array {
  const n = normalizeAdvancedMaterialParameters(params);
  return Float32Array.from([
    ...n.sheen.color, n.sheen.roughness,
    n.iridescence.factor, n.iridescence.ior, n.iridescence.thickness, n.volume.thickness,
    ...n.volume.attenuationColor, n.volume.attenuationDistance === Infinity ? 0 : n.volume.attenuationDistance,
  ]);
}
