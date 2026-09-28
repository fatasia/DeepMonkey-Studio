/** T08 材质覆盖切片 1 · 扩展材质参数 schema(CPU 黄金对照的唯一参数来源)。
 * 覆盖 clearcoat、各向异性、薄壁透射三类工业优先模型;全部字段为 float32 语义,
 * 序列化用 Math.fround 保证「schema→序列化→反序列化」逐位往返一致。
 * 全默认值时求值结果必须与既有 stock PBR(surfaceLowering)路径完全一致。 */

export const MATERIAL_PARAMETER_SCHEMA_VERSION = 1 as const;

export interface MaterialClearcoatParameters {
  /** 清漆强度 0..1;0 = 无层(Khronos KHR_materials_clearcoat 默认)。 */
  readonly factor: number;
  /** 清漆粗糙度 0..1;求值时再夹取到既有路径的 0.045 下限。 */
  readonly roughness: number;
}

export interface MaterialAnisotropyParameters {
  /** 各向异性强度 0..1;0 = 各向同性(Burley D 的连续退化)。 */
  readonly strength: number;
  /** 切线方向绕法线的旋转角(弧度,-π..π)。 */
  readonly rotation: number;
}

export interface MaterialTransmissionParameters {
  /** 薄壁透射比例 0..1;1 且 metallic=0 时为纯透射玻璃。 */
  readonly factor: number;
}

export interface ExtendedMaterialParameters {
  /** 介电 F0 使用的折射率,≥1;1.5 精确退化为既有 0.04 常量(materialDielectric)。 */
  readonly ior: number;
  readonly clearcoat: MaterialClearcoatParameters;
  readonly anisotropy: MaterialAnisotropyParameters;
  readonly transmission: MaterialTransmissionParameters;
}

/** 局部覆盖输入;exactOptionalPropertyTypes 下允许显式 undefined(按默认处理)。 */
export type MaterialParameterOverrides = {
  readonly ior?: number | undefined;
  readonly clearcoat?: Readonly<{ readonly factor?: number | undefined; readonly roughness?: number | undefined }> | undefined;
  readonly anisotropy?: Readonly<{ readonly strength?: number | undefined; readonly rotation?: number | undefined }> | undefined;
  readonly transmission?: Readonly<{ readonly factor?: number | undefined }> | undefined;
};

export const DEFAULT_EXTENDED_MATERIAL_PARAMETERS: ExtendedMaterialParameters = Object.freeze({
  ior: 1.5,
  clearcoat: Object.freeze({ factor: 0, roughness: 0 }),
  anisotropy: Object.freeze({ strength: 0, rotation: 0 }),
  transmission: Object.freeze({ factor: 0 }),
});

/** 扁平序列化布局;顺序即打包顺序,GPU 材质实例布局在联测切片按此对齐。 */
export const MATERIAL_PARAMETER_KEYS = [
  "ior", "clearcoatFactor", "clearcoatRoughness", "anisotropyStrength",
  "anisotropyRotation", "transmissionFactor",
] as const;
export type MaterialParameterKey = (typeof MATERIAL_PARAMETER_KEYS)[number];
export type SerializedMaterialParameters = Readonly<Record<MaterialParameterKey, number>>;

const PI = Math.PI;

function finite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function unit(value: number): boolean {
  return finite(value) && value >= 0 && value <= 1;
}

/** 校验并夹紧旋转角到 (-π, π];这是唯一允许的规范化的字段。 */
export function normalizeAnisotropyRotation(rotation: number): number {
  if (!finite(rotation)) throw new RangeError("Anisotropy rotation must be a finite number of radians.");
  let result = rotation % (2 * PI);
  if (result > PI) result -= 2 * PI;
  if (result <= -PI) result += 2 * PI;
  if (Object.is(result, -0)) return 0;
  return result;
}

/** fail-closed 校验:任何字段缺失、非有限或越界都抛 RangeError,不做静默夹取。 */
export function normalizeExtendedMaterialParameters(
  raw: MaterialParameterOverrides,
): ExtendedMaterialParameters {
  const ior = raw.ior ?? DEFAULT_EXTENDED_MATERIAL_PARAMETERS.ior;
  if (!finite(ior) || !Number.isFinite(Math.fround(ior)) || ior < 1) {
    throw new RangeError("Material IOR must be a finite float32 value at least 1.");
  }
  const factor = raw.clearcoat?.factor ?? 0;
  const roughness = raw.clearcoat?.roughness ?? 0;
  if (!unit(factor)) throw new RangeError("Clearcoat factor must be in 0..1.");
  if (!unit(roughness)) throw new RangeError("Clearcoat roughness must be in 0..1.");
  const strength = raw.anisotropy?.strength ?? 0;
  if (!unit(strength)) throw new RangeError("Anisotropy strength must be in 0..1.");
  const rotation = normalizeAnisotropyRotation(raw.anisotropy?.rotation ?? 0);
  const transmission = raw.transmission?.factor ?? 0;
  if (!unit(transmission)) throw new RangeError("Transmission factor must be in 0..1.");
  return Object.freeze({
    ior: Math.fround(ior),
    clearcoat: Object.freeze({ factor: Math.fround(factor), roughness: Math.fround(roughness) }),
    anisotropy: Object.freeze({ strength: Math.fround(strength), rotation: Math.fround(rotation) }),
    transmission: Object.freeze({ factor: Math.fround(transmission) }),
  });
}

export function isDefaultExtendedMaterialParameters(params: ExtendedMaterialParameters): boolean {
  return params.ior === 1.5 && params.clearcoat.factor === 0 && params.clearcoat.roughness === 0
    && params.anisotropy.strength === 0 && params.transmission.factor === 0;
}

/** schema → 扁平 f32 记录;每个值先 fround,反序列化可逐位还原。 */
export function serializeMaterialParameters(
  params: ExtendedMaterialParameters,
): SerializedMaterialParameters {
  const normalized = normalizeExtendedMaterialParameters(params);
  return Object.freeze({
    ior: Math.fround(normalized.ior),
    clearcoatFactor: Math.fround(normalized.clearcoat.factor),
    clearcoatRoughness: Math.fround(normalized.clearcoat.roughness),
    anisotropyStrength: Math.fround(normalized.anisotropy.strength),
    anisotropyRotation: Math.fround(normalized.anisotropy.rotation),
    transmissionFactor: Math.fround(normalized.transmission.factor),
  });
}

/** 扁平记录 → schema;未知键与越界值 fail-closed。 */
export function deserializeMaterialParameters(
  record: Readonly<Record<string, unknown>>,
): ExtendedMaterialParameters {
  for (const name of Object.keys(record)) {
    if (!(MATERIAL_PARAMETER_KEYS as readonly string[]).includes(name)) {
      throw new RangeError(`Unknown serialized material parameter key: ${name}`);
    }
  }
  const asNumber = (key: MaterialParameterKey): number | undefined => {
    const value = record[key];
    return typeof value === "number" ? value : undefined;
  };
  return normalizeExtendedMaterialParameters({
    ior: asNumber("ior"),
    clearcoat: { factor: asNumber("clearcoatFactor"), roughness: asNumber("clearcoatRoughness") },
    anisotropy: { strength: asNumber("anisotropyStrength"), rotation: asNumber("anisotropyRotation") },
    transmission: { factor: asNumber("transmissionFactor") },
  });
}

/** 打包为固定顺序的 f32 数组(GPU 材质实例上传形态;联测切片按此对齐 stride)。 */
export function packMaterialParameterArray(params: ExtendedMaterialParameters): readonly number[] {
  const record = serializeMaterialParameters(params);
  return MATERIAL_PARAMETER_KEYS.map(key => Math.fround(record[key]));
}
