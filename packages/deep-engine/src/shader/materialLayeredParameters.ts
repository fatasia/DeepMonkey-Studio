/** I 级 C23 分层材质首刀 · 层栈合同(ExtendedMaterialParameters 家族的分层扩展)。
 * 与 C9 的边界:C9 是 base 求值核内**固定结构的清漆单层**(F0=0.04 硬编码、无覆盖率、
 * 无混合语义选择,衰减+瓣转移恒等式见 clearcoatSemantics);本合同是**求值响应级的层栈**:
 * base + ≤2 层,每层自带一套完整 ExtendedMaterialParameters(层内可再含各自 clearcoat,
 * 那是层自身的 C9 行为,与栈混合正交)+ 覆盖率 + 混合语义。
 * fail-closed:层数、覆盖率、混合语义白名单、每层参数集(复用
 * normalizeExtendedMaterialParameters)任一非法整份抛 RangeError,不做静默夹取。
 * float32 语义与家族纪律一致:所有标量 Math.fround,「schema→序列化→反序列化」逐位往返。 */

import {
  MATERIAL_PARAMETER_KEYS,
  deserializeMaterialParameters,
  normalizeExtendedMaterialParameters,
  serializeMaterialParameters,
  type ExtendedMaterialParameters,
  type MaterialParameterOverrides,
  type SerializedMaterialParameters,
} from "./materialParameters.js";

/** 混合语义(首刀两种,白名单校验);两者都是凸混合,权重只由层总响应 rgb 派生:
 * - replace(遮蔽替换):w = c,out = (1−w)·U + w·L。覆盖区无条件接管,透明层也挖底
 *   (蒙版/贴花语义)。
 * - overlay(自遮蔽叠加):w = c·clamp01(L_rgb),out = (1−w)·U + w·L。能量自适应:
 *   层响应弱(L_rgb→0)底材全保留,层响应饱和(L_rgb≥1)收敛于 replace;
 *   用于蜡膜/染色等非遮蔽性表面改性。
 * 两种模式逐通道权重和恒 1,输出 ≤ max(双亲),半球反射率不增(白炉口径 ≤1 可证)。 */
export const MATERIAL_LAYER_BLEND_MODES = ["replace", "overlay"] as const;
export type MaterialLayerBlendMode = (typeof MATERIAL_LAYER_BLEND_MODES)[number];

/** 混合语义 → GPU 打包码(定值,序列化与 WGSL 常量互钉)。 */
export const MATERIAL_LAYER_BLEND_MODE_CODES = { replace: 0, overlay: 1 } as const;
export const MATERIAL_LAYER_BLEND_MODE_NAMES: Readonly<Record<number, MaterialLayerBlendMode>> =
  Object.freeze({ 0: "replace", 1: "overlay" });

/** 层栈深度上限(首刀 ≤2;扩栈是显式合同修订,不是静默放宽)。 */
export const MATERIAL_LAYER_MAX_COUNT = 2 as const;

export type MaterialLayerResponseModel = "legacy" | "microfacet-metal-reflection";

export interface MaterialLayerDefinition {
  readonly responseModel?: MaterialLayerResponseModel;
  /** 层自身的扩展材质参数(规范化后形态,与 base 同一 schema/校验/默认值家族)。 */
  readonly params: ExtendedMaterialParameters;
  /** 覆盖率 0..1;0 = 层剪枝(求值逐位等于跳过该层)。 */
  readonly coverage: number;
  readonly mode: MaterialLayerBlendMode;
}

export interface LayeredMaterialParameters {
  readonly base: ExtendedMaterialParameters;
  /** 应用序 = 数组序:层 0 先混合,层 1 作用于层 0 的混合结果。交换次序结果不同(确定性合同)。 */
  readonly layers: readonly MaterialLayerDefinition[];
}

/** 局部覆盖输入;exactOptionalPropertyTypes 下允许显式 undefined(按默认处理)。 */
export type LayeredMaterialOverrides = {
  readonly base?: MaterialParameterOverrides | undefined;
  readonly layers?: readonly MaterialLayerOverrideInput[] | undefined;
};
export type MaterialLayerOverrideInput = {
  readonly responseModel?: MaterialLayerResponseModel | undefined;
  readonly params?: MaterialParameterOverrides | undefined;
  readonly coverage?: number | undefined;
  readonly mode?: MaterialLayerBlendMode | undefined;
};

export const DEFAULT_LAYERED_MATERIAL_PARAMETERS: LayeredMaterialParameters = Object.freeze({
  base: normalizeExtendedMaterialParameters({}),
  layers: Object.freeze([]),
});

/** 层打包键序:6 个层参数键 + coverage + modeCode;每层 8 个 f32。 */
export const MATERIAL_LAYER_KEYS = [...MATERIAL_PARAMETER_KEYS, "coverage", "modeCode"] as const;
export type MaterialLayerKey = (typeof MATERIAL_LAYER_KEYS)[number];
/** 层块 f32 数 = 6 参数 + coverage + modeCode。 */
export const MATERIAL_LAYER_FLOAT_COUNT = MATERIAL_LAYER_KEYS.length as 8;
/** 分层块 f32 数 = base(6) + 2 层槽 × 8(定长;空槽 coverage=0/modeCode=0)。 */
export const LAYERED_MATERIAL_FLOAT_COUNT = (MATERIAL_PARAMETER_KEYS.length
  + MATERIAL_LAYER_MAX_COUNT * MATERIAL_LAYER_FLOAT_COUNT) as 22;

/** 扁平序列化层记录:层参数键 + coverage + modeCode,与 MATERIAL_LAYER_KEYS 同构
 * (键序即 22-float 打包序;fail-closed 反序列化按同一键白名单校验)。 */
export type SerializedMaterialLayer = SerializedMaterialParameters & {
  readonly coverage: number;
  readonly modeCode: 0 | 1;
  readonly responseModel?: MaterialLayerResponseModel;
};

export interface SerializedLayeredMaterialParameters {
  readonly base: SerializedMaterialParameters;
  /** 序列化按合同剪除零覆盖层(零覆盖层不产生任何求值扰动,见 materialLayeredEvaluate)。 */
  readonly layers: readonly SerializedMaterialLayer[];
}

function finite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function unit(value: number): boolean {
  return finite(value) && value >= 0 && value <= 1;
}

/** fail-closed 校验 + 规范化:层数 ≤2、coverage ∈[0,1]、mode 白名单、逐层参数集校验。
 * 任何字段缺失、非有限或越界抛 RangeError;返回值全字段 fround + 冻结。 */
export function normalizeLayeredMaterialParameters(
  raw: LayeredMaterialOverrides,
): LayeredMaterialParameters {
  const base = normalizeExtendedMaterialParameters(raw.base ?? {});
  const rawLayers = raw.layers ?? [];
  if (!Array.isArray(rawLayers) || rawLayers.length > MATERIAL_LAYER_MAX_COUNT) {
    throw new RangeError(`Material layer stack accepts at most ${MATERIAL_LAYER_MAX_COUNT} layers.`);
  }
  const layers = rawLayers.map((layer): MaterialLayerDefinition => {
    const coverage = layer?.coverage ?? 0;
    if (!unit(coverage)) throw new RangeError("Material layer coverage must be in 0..1.");
    const mode = layer?.mode ?? "replace";
    if (!(MATERIAL_LAYER_BLEND_MODES as readonly string[]).includes(mode)) {
      throw new RangeError(`Unknown material layer blend mode: ${String(mode)}`);
    }
    const responseModel = layer?.responseModel;
    if (responseModel !== undefined && responseModel !== "legacy" && responseModel !== "microfacet-metal-reflection") {
      throw new RangeError(`Unknown material layer response model: ${String(responseModel)}`);
    }
    return Object.freeze({
      ...(responseModel === undefined ? {} : { responseModel }),
      params: responseModel === "microfacet-metal-reflection" ? (() => {
        const params = normalizeExtendedMaterialParameters(layer?.params ?? {});
        const angle = Math.fround(layer?.params?.anisotropy?.rotation ?? 0);
        return Object.freeze({ ...params, anisotropy: Object.freeze({ ...params.anisotropy,
          rotation: angle === -Math.fround(Math.PI) ? Math.fround(Math.PI) : angle }) });
      })() : normalizeExtendedMaterialParameters(layer?.params ?? {}),
      coverage: Math.fround(coverage),
      mode,
    });
  });
  return Object.freeze({ base, layers: Object.freeze(layers) });
}

export function isDefaultLayeredMaterialParameters(params: LayeredMaterialParameters): boolean {
  return params.layers.every((layer) => layer.coverage === 0);
}

/** schema → 序列化记录;零覆盖层按合同剪除,保留层逐字段 fround(扁平形态)。 */
export function serializeLayeredMaterialParameters(
  params: LayeredMaterialParameters,
): SerializedLayeredMaterialParameters {
  const normalized = normalizeLayeredMaterialParameters(params);
  return Object.freeze({
    base: serializeMaterialParameters(normalized.base),
    layers: Object.freeze(normalized.layers
      .filter((layer) => layer.coverage !== 0)
      .map((layer): SerializedMaterialLayer => Object.freeze({
        ...serializeMaterialParameters(layer.params),
        ...(layer.responseModel === "microfacet-metal-reflection" ? { anisotropyRotation: layer.params.anisotropy.rotation } : {}),
        coverage: Math.fround(layer.coverage),
        modeCode: MATERIAL_LAYER_BLEND_MODE_CODES[layer.mode],
        ...(layer.responseModel === undefined ? {} : { responseModel: layer.responseModel }),
      }))),
  });
}

/** 扁平记录 → schema;未知键与越界值 fail-closed(modeCode 仅接受 0/1)。 */
export function deserializeLayeredMaterialParameters(
  record: Readonly<{ base?: Readonly<Record<string, unknown>> | undefined;
    layers?: readonly Readonly<Record<string, unknown>>[] | undefined }>,
): LayeredMaterialParameters {
  const layers = (record.layers ?? []).map((layer) => {
    for (const name of Object.keys(layer)) {
      if (name !== "responseModel" && !(MATERIAL_LAYER_KEYS as readonly string[]).includes(name)) {
        throw new RangeError(`Unknown serialized material layer key: ${name}`);
      }
    }
    const code = layer.modeCode;
    if (code !== 0 && code !== 1) {
      throw new RangeError("Material layer blend mode code must be 0 (replace) or 1 (overlay).");
    }
    const modeName = MATERIAL_LAYER_BLEND_MODE_NAMES[code];
    if (modeName === undefined) throw new RangeError("Material layer blend mode code is unmapped.");
    // 6 个层参数键走家族既有扁平→schema 路径(其内部再做 MATERIAL_PARAMETER_KEYS 白名单)。
    const { coverage: _coverage, modeCode: _modeCode, responseModel, ...layerParams } = layer;
    void _coverage;
    void _modeCode;
    return {
      ...(responseModel === undefined ? {} : { responseModel: responseModel as MaterialLayerResponseModel }),
      params: responseModel === "microfacet-metal-reflection" ? {
        ...deserializeMaterialParameters(layerParams),
        anisotropy: { ...deserializeMaterialParameters(layerParams).anisotropy,
          rotation: typeof layer.anisotropyRotation === "number" ? layer.anisotropyRotation : undefined },
      } : deserializeMaterialParameters(layerParams),
      coverage: typeof layer.coverage === "number" ? layer.coverage : undefined,
      mode: modeName,
    };
  });
  return normalizeLayeredMaterialParameters({
    base: record.base === undefined ? undefined : deserializeMaterialParameters(record.base),
    layers,
  });
}

/** 打包为定长 22-f32 数组(GPU 上传形态):[base 6][layer0 8][layer1 8]。
 * 语义与 serializeLayeredMaterialParameters 一致:零覆盖层剪除后按序入槽,余槽补零。 */
export function packLayeredMaterialFloatArray(
  params: LayeredMaterialParameters,
): readonly number[] {
  const serialized = serializeLayeredMaterialParameters(params);
  if (serialized.layers.some(layer => layer.responseModel === "microfacet-metal-reflection")) {
    throw new RangeError("microfacet-metal-reflection requires the 304B surface ABI; the 22-float scalar ABI cannot represent it.");
  }
  const packed: number[] = MATERIAL_PARAMETER_KEYS.map((key) => Math.fround(serialized.base[key]));
  for (let slot = 0; slot < MATERIAL_LAYER_MAX_COUNT; slot++) {
    const layer = serialized.layers[slot];
    if (layer === undefined) {
      for (let index = 0; index < MATERIAL_LAYER_FLOAT_COUNT; index++) packed.push(0);
      continue;
    }
    for (const key of MATERIAL_PARAMETER_KEYS) packed.push(Math.fround(layer[key]));
    packed.push(Math.fround(layer.coverage));
    packed.push(layer.modeCode);
  }
  if (packed.length !== LAYERED_MATERIAL_FLOAT_COUNT) {
    throw new Error("Layered material pack ABI mismatch against the fixed 22-float layout.");
  }
  return packed;
}
