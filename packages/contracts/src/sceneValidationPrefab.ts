/** 用户预制体校验域:预制体定义/对象状态/向量/实例记录。
 *  source-size 拆分(2026-10-04):自 sceneValidation.ts 按校验域分文件,代码逐行同源,
 *  仅改可见性(validateUserPrefabDefinition/validateUserPrefabInstanceRecord 供场景编排引用);
 *  语义零变化。 */
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
  validateJsonObject,
} from "./applicationValidationPrimitives.js";

const USER_PREFAB_VECTOR_KEYS = ["x", "y", "z"] as const;

function validateUserPrefabVector(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of USER_PREFAB_VECTOR_KEYS) required(object, key, expectNumber, path);
  for (const key of USER_PREFAB_VECTOR_KEYS) {
    const coordinate = object[key];
    if (typeof coordinate === "number" && !Number.isFinite(coordinate)) invalid(`${path}.${key}`, "必须是有限数字");
  }
}

function validateUserPrefabObjectState(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "visible", expectBoolean, path);
  required(object, "opacity", expectNumber, path);
  if (typeof object.opacity === "number" && (object.opacity < 0 || object.opacity > 1)) invalid(`${path}.opacity`, "必须在 0–1 范围内");
  required(object, "transform", (transform, transformPath) => {
    const transformObject = expectObject(transform, transformPath);
    for (const key of ["position", "rotation", "scale"] as const) required(transformObject, key, validateUserPrefabVector, transformPath);
  }, path);
  optional(object, "modelId", expectString, path);
  optional(object, "assetModelId", expectString, path);
  optional(object, "name", expectString, path);
  optional(object, "locked", expectBoolean, path);
  optional(object, "color", expectString, path);
  optional(object, "colorOverride", expectString, path);
  optional(object, "material", validateJsonObject, path);
  optional(object, "effects", validateJsonObject, path);
  optional(object, "physics", validateJsonObject, path);
  optionalLiteral(object, "kind", ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"], path);
}

export function validateUserPrefabDefinition(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "category", expectString, path);
  required(object, "version", expectNumber, path);
  if (typeof object.version === "number" && (!Number.isInteger(object.version) || object.version < 1)) invalid(`${path}.version`, "必须是正整数");
  optional(object, "thumbnail", expectString, path);
  required(object, "createdAt", expectString, path);
  required(object, "updatedAt", expectString, path);
  required(object, "objects", (objects, objectsPath) => {
    const seen = new Set<string>();
    expectArray(objects, objectsPath, (entry, entryPath) => {
      const entryObject = expectObject(entry, entryPath);
      required(entryObject, "sourceId", expectString, entryPath);
      if (typeof entryObject.sourceId === "string") {
        if (!entryObject.sourceId.trim()) invalid(`${entryPath}.sourceId`, "不能为空");
        if (seen.has(entryObject.sourceId)) invalid(entryPath, "sourceId 重复");
        seen.add(entryObject.sourceId);
      }
      required(entryObject, "name", expectString, entryPath);
      requiredLiteral(entryObject, "kind", ["model", "primitive"], entryPath);
      required(entryObject, "state", validateUserPrefabObjectState, entryPath);
      required(entryObject, "offset", validateUserPrefabVector, entryPath);
    });
  }, path);
  if (!Array.isArray(object.objects) || object.objects.length === 0) invalid(`${path}.objects`, "预制体至少包含一个对象");
}

export function validateUserPrefabInstanceRecord(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "instanceId", expectString, path);
  required(object, "prefabId", expectString, path);
  required(object, "prefabVersion", expectNumber, path);
  if (typeof object.prefabVersion === "number" && (!Number.isInteger(object.prefabVersion) || object.prefabVersion < 1)) invalid(`${path}.prefabVersion`, "必须是正整数");
  required(object, "anchor", validateUserPrefabVector, path);
  required(object, "memberObjectIds", validateJsonObject, path);
  if (object.memberObjectIds && typeof object.memberObjectIds === "object") {
    for (const [key, entry] of Object.entries(object.memberObjectIds as Record<string, unknown>)) {
      if (!key.trim()) invalid(`${path}.memberObjectIds`, "sourceId 键不能为空");
      if (typeof entry !== "string" || !entry.trim()) invalid(`${path}.memberObjectIds.${key}`, "场景对象 ID 不能为空");
    }
  }
  optional(object, "overrides", validateJsonObject, path);
}
