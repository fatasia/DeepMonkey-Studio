import type { DeepSlSurfaceModel, DeepSlTextureTransform } from "./deepSlTypes.js";
import type {
  DeepPbrMeshV1MaterialDefaults,
  DeepPbrMeshV1MaterialTextureDefaults,
} from "./packageAdapterTypes.js";

export function hasPackageMaterialTextures(model: DeepSlSurfaceModel): boolean {
  return model.baseColorTexture || model.metallicRoughnessTexture || model.normalTexture
    || model.occlusionTexture || model.emissiveTexture;
}

export function packageMaterialDefaults(model: DeepSlSurfaceModel): DeepPbrMeshV1MaterialDefaults {
  const alphaFlags = model.alpha === "mask" ? 2 : model.alpha === "blend" ? 4 : 0;
  const flags = alphaFlags | (model.doubleSided ? 1 : 0);
  const emissiveScale = hasPackageMaterialTextures(model) ? 1 : model.emissiveStrength;
  return Object.freeze({
    baseColorMetallic: Object.freeze([
      model.baseColor[0], model.baseColor[1], model.baseColor[2], model.metallic,
    ] as const),
    roughnessAlphaCutoffHandednessFlags: Object.freeze([model.roughness, 0.5, 1, flags] as const),
    emissiveAlpha: Object.freeze([
      model.emissiveFactor[0] * emissiveScale,
      model.emissiveFactor[1] * emissiveScale,
      model.emissiveFactor[2] * emissiveScale,
      model.alpha === "opaque" ? 1 : model.baseColor[3],
    ] as const),
  });
}

/** Unlit owns only base color, alpha and emission; PBR instance lanes stay at canonical neutral values. */
export function packageUnlitMaterialDefaults(model: DeepSlSurfaceModel): DeepPbrMeshV1MaterialDefaults {
  const alphaFlags = model.alpha === "mask" ? 2 : model.alpha === "blend" ? 4 : 0;
  const flags = alphaFlags | (model.doubleSided ? 1 : 0);
  const textured = model.baseColorTexture || model.emissiveTexture;
  const emissiveScale = textured ? 1 : model.emissiveStrength;
  return Object.freeze({
    baseColorMetallic: Object.freeze([model.baseColor[0], model.baseColor[1], model.baseColor[2], 0] as const),
    roughnessAlphaCutoffHandednessFlags: Object.freeze([1, 0.5, 1, flags] as const),
    emissiveAlpha: Object.freeze([
      model.emissiveFactor[0] * emissiveScale,
      model.emissiveFactor[1] * emissiveScale,
      model.emissiveFactor[2] * emissiveScale,
      model.alpha === "opaque" ? 1 : model.baseColor[3],
    ] as const),
  });
}

function textureTransformMatrix(
  transform: DeepSlTextureTransform,
): readonly [number, number, number, number, number, number] {
  const cosine = Math.cos(transform.rotation), sine = Math.sin(transform.rotation);
  const values = [
    cosine * transform.scale[0], -sine * transform.scale[1], transform.offset[0],
    sine * transform.scale[0], cosine * transform.scale[1], transform.offset[1],
  ].map((value) => {
    const result = Math.fround(value);
    return Object.is(result, -0) ? 0 : result;
  });
  return Object.freeze(values) as unknown as readonly [number, number, number, number, number, number];
}

export function packageMaterialTextureDefaults(
  model: DeepSlSurfaceModel,
): DeepPbrMeshV1MaterialTextureDefaults {
  const enabled = {
    baseColor: model.baseColorTexture,
    metallicRoughness: model.metallicRoughnessTexture,
    normal: model.normalTexture,
    occlusion: model.occlusionTexture,
    emissive: model.emissiveTexture,
  } as const;
  const semantics = Object.freeze([
    "baseColor", "metallicRoughness", "occlusion", "normal", "emissive",
  ] as const);
  const transforms = {
    baseColor: model.baseColorTextureTransform,
    metallicRoughness: model.metallicRoughnessTextureTransform,
    normal: model.normalTextureTransform,
    occlusion: model.occlusionTextureTransform,
    emissive: model.emissiveTextureTransform,
  } as const;
  const row = (semantic: keyof typeof enabled, scalar = 0): readonly number[] => {
    const transform = textureTransformMatrix(transforms[semantic]);
    return [
      transform[0], transform[1], transform[2], enabled[semantic] ? transforms[semantic].texCoord + 1 : 0,
      transform[3], transform[4], transform[5], scalar,
    ];
  };
  const slot = <Semantic extends keyof typeof enabled, ColorSpace extends "linear" | "srgb">(
    semantic: Semantic,
    colorSpace: ColorSpace,
  ) => {
    const transform = transforms[semantic];
    return Object.freeze({
      semantic,
      enabled: enabled[semantic],
      colorSpace,
      texCoord: transform.texCoord,
      supportedTexCoords: Object.freeze([0, 1] as const),
      offset: Object.freeze([...transform.offset]) as readonly [number, number],
      scale: Object.freeze([...transform.scale]) as readonly [number, number],
      rotation: transform.rotation,
      uvTransform: textureTransformMatrix(transform),
    });
  };
  return Object.freeze({
    byteSize: 160,
    parameters: Object.freeze([
      ...row("baseColor"),
      ...row("metallicRoughness"),
      ...row("occlusion", model.occlusionStrength),
      ...row("normal", model.normalScale),
      ...row("emissive", model.emissiveStrength),
    ]),
    enabledSlots: Object.freeze(semantics.filter((semantic) => enabled[semantic])),
    baseColor: slot("baseColor", "srgb"),
    metallicRoughness: Object.freeze({
      ...slot("metallicRoughness", "linear"),
      metallicChannel: "b" as const,
      roughnessChannel: "g" as const,
    }),
    normal: Object.freeze({ ...slot("normal", "linear"), normalScale: model.normalScale }),
    occlusion: Object.freeze({
      ...slot("occlusion", "linear"), channel: "r" as const, strength: model.occlusionStrength,
    }),
    emissive: Object.freeze({
      ...slot("emissive", "srgb"), emissiveStrength: model.emissiveStrength,
    }),
    dummySlots: Object.freeze(semantics.filter((semantic) => !enabled[semantic]).map((binding) => Object.freeze({
      binding,
      colorSpace: binding === "baseColor" || binding === "emissive" ? "srgb" as const : "linear" as const,
    }))),
  });
}
