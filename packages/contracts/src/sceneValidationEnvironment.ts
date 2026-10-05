/** 环境校验域:光照/灯具/IES 光域文件/环境与反射探针/后处理栈。
 *  source-size 拆分(2026-10-04):自 sceneValidation.ts 按校验域分文件,代码逐行同源,
 *  仅改可见性(validateLighting/validateEnvironment/validatePostProcessing 供场景编排引用);
 *  语义零变化。 */
import { validateSceneReflectionProbes } from "./sceneReflectionProbes.js";
import {
  expectArray,
  expectBoolean,
  expectNumber,
  expectObject,
  expectString,
  invalid,
  optional,
  optionalLiteral,
  required,
  requiredLiteral,
} from "./applicationValidationPrimitives.js";
import { validateVector3 } from "./sceneValidationSceneModel.js";

export function validateLighting(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "intensity", expectNumber, path);
  for (const key of ["shadowsEnabled", "reflectionsEnabled", "globalIlluminationEnabled"] as const) optional(object, key, expectBoolean, path);
  optional(object, "globalIlluminationIntensity", expectNumber, path);
  optional(object, "lights", (lights, lightsPath) => expectArray(lights, lightsPath, validateLight), path);
  optional(object, "lightProfiles", validateLightProfiles, path);
  const profiles = Array.isArray(object.lightProfiles) ? object.lightProfiles : [];
  const profileIds = new Set(profiles.map((profile) => expectObject(profile, `${path}.lightProfiles`).profileId));
  if (profileIds.size !== profiles.length) invalid(`${path}.lightProfiles`, "profileId 不能重复");
  for (const [index, light] of (Array.isArray(object.lights) ? object.lights : []).entries()) {
    const ies = expectObject(light, `${path}.lights[${index}]`).ies;
    if (ies && !profileIds.has(expectObject(ies, `${path}.lights[${index}].ies`).profileId)) {
      invalid(`${path}.lights[${index}].ies.profileId`, "引用的 IES profileId 不存在");
    }
  }
}

function validateLight(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["id", "name", "color"] as const) required(object, key, expectString, path);
  requiredLiteral(object, "type", ["ambient", "hemisphere", "directional", "point", "spot", "rectArea"], path);
  required(object, "enabled", expectBoolean, path);
  required(object, "intensity", expectNumber, path);
  optional(object, "position", validateVector3, path);
  optional(object, "target", validateVector3, path);
  optional(object, "groundColor", expectString, path);
  for (const key of ["distance", "decay", "angle", "penumbra", "width", "height"] as const) optional(object, key, expectNumber, path);
  optional(object, "castShadow", expectBoolean, path);
  optional(object, "shadowSoftness", expectNumber, path);
  if (object.shadowSoftness !== undefined && object.type !== "spot") invalid(`${path}.shadowSoftness`, "局部 PCSS 柔化仅支持聚光灯");
  if (typeof object.shadowSoftness === "number" && (object.shadowSoftness < 0 || object.shadowSoftness > 1)) invalid(`${path}.shadowSoftness`, "必须在 [0,1] 内");
  optional(object, "ies", (ies, iesPath) => {
    if (object.type !== "spot") invalid(iesPath, "IES 仅支持聚光灯");
    const entry = expectObject(ies, iesPath);
    required(entry, "profileId", expectString, iesPath);
    optional(entry, "rotationDeg", expectNumber, iesPath);
    optional(entry, "scaleFactor", expectNumber, iesPath);
    if (typeof entry.rotationDeg === "number" && (entry.rotationDeg < 0 || entry.rotationDeg >= 360
      || Math.abs(entry.rotationDeg * 2 - Math.round(entry.rotationDeg * 2)) > 1e-6)) invalid(`${iesPath}.rotationDeg`, "必须位于 [0,360) 的 0.5° 网格");
    if (typeof entry.scaleFactor === "number" && (entry.scaleFactor < 0 || entry.scaleFactor > 10)) invalid(`${iesPath}.scaleFactor`, "必须位于 [0,10]");
  }, path);
}

function validateLightProfiles(value: unknown, path: string): void {
  expectArray(value, path, (profile, profilePath) => {
    const entry = expectObject(profile, profilePath);
    required(entry, "profileId", expectString, profilePath);
    requiredLiteral(entry, "format", ["LM-63-1995", "LM-63-2002"], profilePath);
    requiredLiteral(entry, "horizontalSymmetry", [1, 2, 4], profilePath);
    required(entry, "totalLumens", expectNumber, profilePath);
    required(entry, "verticalAngles", (angles, anglesPath) => expectArray(angles, anglesPath, expectNumber), profilePath);
    required(entry, "candela", (rows, rowsPath) => expectArray(rows, rowsPath,
      (row, rowPath) => expectArray(row, rowPath, expectNumber)), profilePath);
  });
  const profiles = value as unknown[];
  if (profiles.length > 64) invalid(path, "IES profile 数量超过 64");
  let cells = 0;
  for (const [index, profile] of profiles.entries()) {
    const entry = expectObject(profile, `${path}[${index}]`);
    const angles = entry.verticalAngles as unknown[];
    const rows = entry.candela as unknown[][];
    if (!angles.length || angles.length > 512 || !rows.length || rows.length > 512
      || rows.some((row) => row.length !== angles.length)) invalid(`${path}[${index}]`, "IES 表尺寸无效");
    cells += rows.length * angles.length;
  }
  if (cells > 1_048_576) invalid(path, "IES profile 总采样预算超过 1048576");
}

export function validateEnvironment(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "gridVisible", expectBoolean, path);
  required(object, "backgroundColor", expectString, path);
  requiredLiteral(object, "skybox", ["none", "studio", "bright-studio", "clear", "overcast", "dawn", "sunset", "night", "industrial-night"], path);
  for (const key of ["environmentMapUrl", "environmentMapName"] as const) optional(object, key, expectString, path);
  optional(object, "environmentAsBackground", expectBoolean, path);
  optional(object, "environmentIntensity", expectNumber, path);
  if (object.environmentSpecularMips !== undefined && (typeof object.environmentSpecularMips !== "number"
    || !Number.isInteger(object.environmentSpecularMips) || object.environmentSpecularMips < 1
    || object.environmentSpecularMips > 8)) invalid(`${path}.environmentSpecularMips`, "expected integer 1..8");
  optional(object, "reflectionProbes", validateSceneReflectionProbes, path);
}

export function validatePostProcessing(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["enabled", "smaa", "ssao", "bloom"] as const) required(object, key, expectBoolean, path);
  for (const key of ["ssaoIntensity", "bloomStrength", "bloomThreshold"] as const) required(object, key, expectNumber, path);
  for (const key of ["fxaa", "gtao", "screenSpaceReflection", "volumetricFog", "volumetricGodRays", "outline", "depthOfField", "vignette", "filmGrain", "afterimage", "colorGrading"] as const) optional(object, key, expectBoolean, path);
  optionalLiteral(object, "qualityProfile", ["performance", "balanced", "quality", "ultra"], path);
  for (const key of ["gtaoIntensity", "ssrSteps", "ssrThickness", "ssrMaxDistance", "volumetricFogSteps", "volumetricFogDensity", "volumetricFogHeight", "volumetricFogAnisotropy", "volumetricFogAlbedo", "volumetricGodRaysStrength", "outlineStrength", "focusDistance", "aperture", "maxBlur", "vignetteDarkness", "filmGrainIntensity", "afterimageDamp", "hue", "saturation", "brightness", "contrast", "temperature", "tint"] as const) {
    optional(object, key, expectNumber, path);
  }
  if (typeof object.volumetricGodRaysStrength === "number" && (object.volumetricGodRaysStrength < 0 || object.volumetricGodRaysStrength > 8))
    invalid(`${path}.volumetricGodRaysStrength`, "必须在 [0,8] 内");
  if (object.ssrSteps !== undefined && (typeof object.ssrSteps !== "number" || !Number.isInteger(object.ssrSteps)
    || object.ssrSteps < 8 || object.ssrSteps > 128)) invalid(`${path}.ssrSteps`, "必须为 [8,128] 内的整数");
  if (typeof object.ssrThickness === "number" && (object.ssrThickness < 0.001 || object.ssrThickness > 0.1)) invalid(`${path}.ssrThickness`, "必须在 [0.001,0.1] 内");
  if (typeof object.ssrMaxDistance === "number" && (object.ssrMaxDistance < 0.25 || object.ssrMaxDistance > 4)) invalid(`${path}.ssrMaxDistance`, "必须在 [0.25,4] 内");
  if (object.volumetricFogSteps !== undefined && (typeof object.volumetricFogSteps !== "number" || !Number.isInteger(object.volumetricFogSteps)
      || object.volumetricFogSteps < 32 || object.volumetricFogSteps > 64)) invalid(`${path}.volumetricFogSteps`, "必须为 [32,64] 内的整数");
  if (typeof object.volumetricFogDensity === "number" && (object.volumetricFogDensity < 0 || object.volumetricFogDensity > 100)) invalid(`${path}.volumetricFogDensity`, "必须在 [0,100] 内");
  if (typeof object.volumetricFogHeight === "number" && object.volumetricFogHeight <= 0) invalid(`${path}.volumetricFogHeight`, "必须大于 0");
  if (typeof object.volumetricFogAlbedo === "number" && (object.volumetricFogAlbedo < 0 || object.volumetricFogAlbedo > 1)) invalid(`${path}.volumetricFogAlbedo`, "必须在 [0,1] 内");
  if (typeof object.volumetricFogAnisotropy === "number" && (object.volumetricFogAnisotropy < -0.99 || object.volumetricFogAnisotropy > 0.99)) invalid(`${path}.volumetricFogAnisotropy`, "必须在 [-0.99,0.99] 内");
}
