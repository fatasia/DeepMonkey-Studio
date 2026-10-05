/** 材质校验域:validateMaterial / 用户自定义材质预设 / 模型效果与 VFX/fire 曲线。
 *  source-size 拆分(2026-10-04):自 sceneValidation.ts 按校验域分文件,代码逐行同源,
 *  仅改可见性(跨域引用的函数在本文件导出,入口 re-export 面不变);语义零变化。 */
import {
  expectArray,
  expectBoolean,
  expectNumber,
  expectObject,
  hasOwn,
  invalid,
  optional,
  optionalLiteral,
  expectString,
  required,
  requiredLiteral,
} from "./applicationValidationPrimitives.js";

export function validateMaterial(value: unknown, path: string): void {
  const object = expectObject(value, path);
  optional(object, "slotOverrides", (slots, slotsPath) => {
    const entries = Object.entries(expectObject(slots, slotsPath));
    if (entries.length > 4096) invalid(slotsPath, "材质槽数量超过 4096");
    for (const [id, override] of entries) {
      if (!/^gltf:(0|[1-9]\d*)$/.test(id)) invalid(slotsPath, "材质槽身份无效");
      const slot = expectObject(override, `${slotsPath}.${id}`);
      if (slot.slotOverrides !== undefined) invalid(slotsPath, "材质槽不能嵌套");
      validateMaterial(slot, `${slotsPath}.${id}`);
    }
  }, path);
  for (const key of [
    "color",
    "emissive",
    "baseColorMapUrl",
    "baseColorMapName",
    "normalMapUrl",
    "normalMapName",
    "emissiveMapUrl",
    "emissiveMapName",
    "ambientOcclusionMapUrl",
    "ambientOcclusionMapName",
    "roughnessMapUrl",
    "roughnessMapName",
    "metalnessMapUrl",
    "metalnessMapName",
  ] as const)
    optional(object, key, expectString, path);
  for (const key of [
    "textureRepeat",
    "textureRepeatX",
    "textureRepeatY",
    "textureOffsetX",
    "textureOffsetY",
    "textureRotation",
    "normalScale",
    "roughness",
    "metalness",
    "emissiveIntensity",
    "hue",
    "saturation",
    "brightness",
    "contrast",
  ] as const) optional(object, key, expectNumber, path);
  optional(object, "ior", (value, valuePath) => {
    expectNumber(value, valuePath);
    if (typeof value !== "number" || value < 1 || !Number.isFinite(Math.fround(value))) throw new Error(`${valuePath} must be a finite float32 >= 1`);
  }, path);
  for (const [key, minimum, maximum] of [
    ["clearcoat", 0, 1], ["clearcoatRoughness", 0, 1], ["sheen", 0, 1], ["sheenRoughness", 0, 1],
    ["iridescence", 0, 1], ["iridescenceIOR", 1, 3], ["iridescenceThicknessMax", 0, 10000],
    ["transmission", 0, 1], ["thickness", 0, 1e6],
  ] as const) optional(object, key, (value, valuePath) => {
    expectNumber(value, valuePath);
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${valuePath} 必须是 ${minimum}–${maximum} 之间的有限数值`);
    }
  }, path);
  optional(object, "attenuationDistance", (value, valuePath) => {
    expectNumber(value, valuePath);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${valuePath} 必须是大于 0 的有限数值(缺省表示不衰减)`);
  }, path);
  for (const key of ["sheenColor", "attenuationColor"] as const) optional(object, key, (value, valuePath) => {
    expectString(value, valuePath);
    if (typeof value === "string" && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${valuePath} 必须是 #RRGGBB`);
  }, path);
  for (const key of ["wireframe", "doubleSided", "sourceColor", "sourceEmissive"] as const) optional(object, key, expectBoolean, path);
  optional(object, "uvAnimation", (animation, animationPath) => {
    const animationObject = expectObject(animation, animationPath);
    required(animationObject, "enabled", expectBoolean, animationPath);
    optionalLiteral(animationObject, "loopMode", ["once", "loop"], animationPath);
    optional(animationObject, "durationSeconds", expectNumber, animationPath);
    for (const key of ["offsetSpeedX", "offsetSpeedY", "rotationSpeed"] as const) {
      required(animationObject, key, expectNumber, animationPath);
    }
  }, path);
  optional(object, "screen", (screen, screenPath) => {
    const screenObject = expectObject(screen, screenPath);
    required(screenObject, "enabled", expectBoolean, screenPath);
    requiredLiteral(screenObject, "sourceType", ["image", "video"], screenPath);
    required(screenObject, "url", expectString, screenPath);
    optional(screenObject, "name", expectString, screenPath);
    required(screenObject, "autoplay", expectBoolean, screenPath);
    requiredLiteral(screenObject, "loopMode", ["once", "loop"], screenPath);
    required(screenObject, "muted", expectBoolean, screenPath);
    required(screenObject, "emissiveIntensity", expectNumber, screenPath);
  }, path);
}

/** 用户自定义材质预设:只含标量外观域,参数域与 validateMaterial 一致。 */
export function validateUserMaterialPresetDefinition(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["id", "name", "createdAt", "updatedAt"] as const) required(object, key, expectString, path);
  if (typeof object.name === "string" && !object.name.trim()) invalid(`${path}.name`, "不能为空");
  required(object, "values", validateUserMaterialPresetValues, path);
}

function validateUserMaterialPresetValues(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["slotOverrides", "customShader", "shaderEffect", "screen", "uvAnimation", "baseColorMapUrl",
    "baseColorMapName", "normalMapUrl", "normalMapName", "emissiveMapUrl", "emissiveMapName",
    "ambientOcclusionMapUrl", "ambientOcclusionMapName", "roughnessMapUrl", "roughnessMapName",
    "metalnessMapUrl", "metalnessMapName", "textureRepeat", "textureRepeatX", "textureRepeatY",
    "textureOffsetX", "textureOffsetY", "textureRotation", "hue", "saturation", "brightness",
    "contrast", "sourceColor", "sourceEmissive", "wireframe", "normalScale"] as const) {
    if (hasOwn(object, key)) invalid(`${path}.${key}`, "自定义材质预设只含标量外观域");
  }
  for (const key of ["color", "emissive", "sheenColor", "attenuationColor"] as const) {
    optional(object, key, (color, colorPath) => {
      expectString(color, colorPath);
      if (typeof color === "string" && !/^#[0-9a-f]{6}$/i.test(color)) invalid(colorPath, "必须是 #RRGGBB");
    }, path);
  }
  for (const key of ["roughness", "metalness", "emissiveIntensity"] as const) optional(object, key, expectNumber, path);
  optional(object, "ior", (ior, iorPath) => {
    expectNumber(ior, iorPath);
    if (typeof ior !== "number" || ior < 1 || !Number.isFinite(Math.fround(ior))) invalid(iorPath, "必须是有限 float32 ≥ 1");
  }, path);
  for (const [key, minimum, maximum] of [
    ["transmission", 0, 1], ["thickness", 0, 1e6], ["clearcoat", 0, 1], ["clearcoatRoughness", 0, 1],
    ["sheen", 0, 1], ["sheenRoughness", 0, 1], ["iridescence", 0, 1],
  ] as const) optional(object, key, (scalar, scalarPath) => {
    expectNumber(scalar, scalarPath);
    if (typeof scalar !== "number" || !Number.isFinite(scalar) || scalar < minimum || scalar > maximum) {
      invalid(scalarPath, `必须是 ${minimum}–${maximum} 之间的有限数值`);
    }
  }, path);
  optional(object, "attenuationDistance", (distance, distancePath) => {
    expectNumber(distance, distancePath);
    if (typeof distance !== "number" || !Number.isFinite(distance) || distance <= 0) invalid(distancePath, "必须是大于 0 的有限数值");
  }, path);
  optional(object, "doubleSided", expectBoolean, path);
}

export function validateModelEffects(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["outline", "glow", "xray", "scanline", "heatmap", "edgeLight"] as const) required(object, key, expectBoolean, path);
  for (const key of ["dissolve", "intensity"] as const) required(object, key, expectNumber, path);
  required(object, "color", expectString, path);
  optional(object, "fire", (fire, firePath) => {
    const fireObject = expectObject(fire, firePath);
    required(fireObject, "enabled", expectBoolean, firePath);
    required(fireObject, "color", expectString, firePath);
    for (const key of ["intensity", "height", "density"] as const) required(fireObject, key, expectNumber, firePath);
    if (typeof fireObject.color === "string" && !/^#[0-9a-f]{6}$/i.test(fireObject.color)) invalid(`${firePath}.color`, "必须是 #RRGGBB");
    validateNumberRange(fireObject.intensity, `${firePath}.intensity`, 0, 5);
    validateNumberRange(fireObject.height, `${firePath}.height`, 0.1, 50);
    validateNumberRange(fireObject.density, `${firePath}.density`, 0.25, 2);
    optionalLiteral(fireObject, "blend", ["additive", "alpha"], firePath);
    optional(fireObject, "maxParticles", (value, valuePath) => {
      expectNumber(value, valuePath);
      validateNumberRange(value, valuePath, 16, 512);
    }, firePath);
    optional(fireObject, "curves", (curves, curvesPath) => {
      const curvesObject = expectObject(curves, curvesPath);
      for (const [key, maximum] of [["size", 4], ["alpha", 1], ["color", 1]] as const) {
        optional(curvesObject, key, (keys, keysPath) => validateFireCurve(keys, keysPath, maximum), curvesPath);
      }
    }, firePath);
  }, path);
  optional(object, "vfx", (vfx, vfxPath) => {
    const vfxObject = expectObject(vfx, vfxPath);
    requiredLiteral(vfxObject, "template", [
      "exhaust-steam", "leak-drip", "sparks", "alarm-ring", "dust", "airflow", "smoke-leak", "spray-mist",
    ], vfxPath);
    required(vfxObject, "enabled", expectBoolean, vfxPath);
    required(vfxObject, "color", expectString, vfxPath);
    for (const key of ["intensity", "rate", "range", "lifetime"] as const) required(vfxObject, key, expectNumber, vfxPath);
    if (typeof vfxObject.color === "string" && !/^#[0-9a-f]{6}$/i.test(vfxObject.color)) invalid(`${vfxPath}.color`, "必须是 #RRGGBB");
    validateNumberRange(vfxObject.intensity, `${vfxPath}.intensity`, 0, 5);
    validateNumberRange(vfxObject.rate, `${vfxPath}.rate`, 0.25, 2);
    validateNumberRange(vfxObject.range, `${vfxPath}.range`, 0.1, 50);
    validateNumberRange(vfxObject.lifetime, `${vfxPath}.lifetime`, 0.2, 8);
    optionalLiteral(vfxObject, "blend", ["additive", "alpha"], vfxPath);
    optional(vfxObject, "maxParticles", (value, valuePath) => {
      expectNumber(value, valuePath);
      validateNumberRange(value, valuePath, 16, 512);
    }, vfxPath);
    optional(vfxObject, "curves", (curves, curvesPath) => {
      const curvesObject = expectObject(curves, curvesPath);
      for (const [key, maximum] of [["size", 4], ["alpha", 1], ["color", 1]] as const) {
        optional(curvesObject, key, (keys, keysPath) => validateFireCurve(keys, keysPath, maximum), curvesPath);
      }
    }, vfxPath);
  }, path);
}

function validateFireCurve(keys: unknown, path: string, maximum: number): void {
  if (Array.isArray(keys) && (keys.length < 1 || keys.length > 16)) invalid(path, "关键帧数量必须在 1–16 之间");
  let previous = -1;
  expectArray(keys, path, (frame, framePath) => {
    const object = expectObject(frame, framePath);
    required(object, "time", expectNumber, framePath);
    required(object, "value", expectNumber, framePath);
    validateNumberRange(object.time, `${framePath}.time`, 0, 1);
    validateNumberRange(object.value, `${framePath}.value`, 0, maximum);
    if (typeof object.time === "number") {
      if (object.time <= previous) invalid(`${framePath}.time`, "必须严格递增");
      previous = object.time;
    }
  });
}

export function validateNumberRange(value: unknown, path: string, minimum: number, maximum: number): void {
  if (typeof value === "number" && (value < minimum || value > maximum)) invalid(path, `必须在 ${minimum}–${maximum} 范围内`);
}
