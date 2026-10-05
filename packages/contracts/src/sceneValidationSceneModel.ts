/** 场景结构模型校验域:场景模型/图元/图层/空间音频/测量/标注/相机与导航/裁剪/变换。
 *  source-size 拆分(2026-10-04):自 sceneValidation.ts 按校验域分文件,代码逐行同源,
 *  仅改可见性(跨域引用的函数在本文件导出,入口 re-export 面不变);语义零变化。 */
import { assertRobotPose } from "./robotAsset.js";
import { supportedExtensions } from "./project.js";
import { validateIndustrialPrefabInstance } from "./industrialPrefabValidation.js";
import {
  expectArray,
  expectBoolean,
  expectNumber,
  expectObject,
  expectPathSafeResourceId,
  expectString,
  invalid,
  optional,
  optionalLiteral,
  required,
  requiredLiteral,
  validateStringArray,
} from "./applicationValidationPrimitives.js";
import { validateMaterial, validateModelEffects } from "./sceneValidationMaterial.js";
import { validatePhysicsBody, validateRig } from "./sceneValidationPhysics.js";

const MODEL_FORMATS = supportedExtensions;

export function validateSceneModel(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "modelId", expectString, path);
  optional(object, "assetModelId", expectPathSafeResourceId, path);
  required(object, "name", expectString, path);
  optional(object, "sourceName", expectString, path);
  optionalLiteral(object, "sourceFormat", MODEL_FORMATS, path);
  required(object, "visible", expectBoolean, path);
  optional(object, "locked", expectBoolean, path);
  required(object, "opacity", expectNumber, path);
  optional(object, "color", expectString, path);
  optional(object, "colorOverride", expectString, path);
  required(object, "transform", validateTransform, path);
  optional(object, "collisionEnabled", expectBoolean, path);
  optional(object, "explosionFactor", expectNumber, path);
  optionalLiteral(object, "explosionMode", ["radial", "vertical", "x", "y", "z"], path);
  optional(object, "animationEnabled", expectBoolean, path);
  optional(object, "animationPlayback", (playback, playbackPath) => {
    const playbackObject = expectObject(playback, playbackPath);
    required(playbackObject, "autoplay", expectBoolean, playbackPath);
    requiredLiteral(playbackObject, "loopMode", ["once", "loop"], playbackPath);
  }, path);
  optional(object, "material", validateMaterial, path);
  optional(object, "spatialAudio", validateSpatialAudio, path);
  optional(object, "effects", validateModelEffects, path);
  optional(object, "rig", validateRig, path);
  optional(object, "robotPose", assertRobotPose, path);
  optional(object, "physics", validatePhysicsBody, path);
  optional(object, "prefab", validateIndustrialPrefabInstance, path);
  optional(object, "layers", (layers, layersPath) => expectArray(layers, layersPath, validateLayer), path);
}

function validateSpatialAudio(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "url", expectString, path);
  optional(object, "name", expectString, path);
  required(object, "autoplay", expectBoolean, path);
  requiredLiteral(object, "loopMode", ["once", "loop"], path);
  required(object, "muted", expectBoolean, path);
  for (const key of ["volume", "refDistance", "maxDistance", "rolloffFactor"] as const) required(object, key, expectNumber, path);
}

export function validatePrimitive(value: unknown, path: string): void {
  validateSceneModel(value, path);
  const object = expectObject(value, path);
  requiredLiteral(object, "kind", ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"], path);
  required(object, "color", expectString, path);
}

export function validateLayer(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "nodeId", expectString, path);
  for (const key of ["visible", "locked", "deleted"] as const) optional(object, key, expectBoolean, path);
  for (const key of ["name", "color"] as const) optional(object, key, expectString, path);
  optional(object, "opacity", expectNumber, path);
  optional(object, "material", validateMaterial, path);
  optional(object, "transform", validateTransform, path);
}

export function validateMeasurement(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "start", validateVector3, path);
  required(object, "end", validateVector3, path);
  required(object, "distance", expectNumber, path);
  optionalLiteral(object, "kind", ["distance", "minimum", "angle", "elevation", "horizontal", "vertical"], path);
  optional(object, "points", (points, pointsPath) => expectArray(points, pointsPath, validateVector3), path);
  optional(object, "angle", expectNumber, path);
  optional(object, "elevation", expectNumber, path);
  optional(object, "labels", validateStringArray, path);
}

export function validateAnnotation(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  optional(object, "description", expectString, path);
  required(object, "position", validateVector3, path);
  required(object, "color", expectString, path);
  required(object, "visible", expectBoolean, path);
  required(object, "locked", expectBoolean, path);
  optional(object, "size", expectNumber, path);
  for (const key of ["modelId", "layerId", "anchorName"] as const) optional(object, key, expectString, path);
}

export function validateCamera(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "position", validateVector3, path);
  required(object, "target", validateVector3, path);
  requiredLiteral(object, "mode", ["orbit", "firstPerson", "thirdPerson"], path);
  optional(object, "avatarVisible", expectBoolean, path);
}

export function validateCameraConstraints(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["minDistance", "maxDistance", "minPolarAngle", "maxPolarAngle", "nearClip", "farClip", "collisionRadius"] as const) {
    required(object, key, expectNumber, path);
  }
  required(object, "collisionEnabled", expectBoolean, path);
}

export function validateNavigationSettings(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["walkSpeed", "flySpeed", "sprintMultiplier", "eyeHeight", "gravity", "jumpSpeed", "stepHeight", "maxSlopeAngle"] as const) {
    required(object, key, expectNumber, path);
  }
}

export function validateCameraView(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "camera", validateCamera, path);
  required(object, "createdAt", expectString, path);
}

export function validateClipping(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  optionalLiteral(object, "mode", ["axis", "box", "face"], path);
  requiredLiteral(object, "axis", ["x", "y", "z"], path);
  required(object, "offset", expectNumber, path);
  required(object, "inverted", expectBoolean, path);
  optional(
    object,
    "box",
    (box, boxPath) => {
      const boxObject = expectObject(box, boxPath);
      required(boxObject, "min", validateVector3, boxPath);
      required(boxObject, "max", validateVector3, boxPath);
    },
    path,
  );
  optional(
    object,
    "face",
    (face, facePath) => {
      const faceObject = expectObject(face, facePath);
      required(faceObject, "normal", validateVector3, facePath);
      required(faceObject, "point", validateVector3, facePath);
    },
    path,
  );
  optional(object, "showHelper", expectBoolean, path);
}

export function validateTransform(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "position", validateVector3, path);
  required(object, "rotation", validateVector3, path);
  required(object, "scale", validateVector3, path);
}

export function validateVector3(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["x", "y", "z"] as const) required(object, key, expectNumber, path);
}
