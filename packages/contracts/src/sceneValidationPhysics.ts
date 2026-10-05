/** 物理/角色控制器与骨骼机器人运动学校验域。
 *  source-size 拆分(2026-10-04):自 sceneValidation.ts 按校验域分文件,代码逐行同源,
 *  仅改可见性(validateRig/validatePhysicsBody 供模型域引用);语义零变化。 */
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
  validateStringArray,
} from "./applicationValidationPrimitives.js";
import { validateVector3 } from "./sceneValidationSceneModel.js";
import { validateNumberRange } from "./sceneValidationMaterial.js";

export function validateRig(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(
    object,
    "bones",
    (bones, bonesPath) =>
      expectArray(bones, bonesPath, (bone, bonePath) => {
        const boneObject = expectObject(bone, bonePath);
        required(boneObject, "bonePath", expectString, bonePath);
        required(boneObject, "rotation", validateVector3, bonePath);
      }),
    path,
  );
  required(
    object,
    "ik",
    (constraints, constraintsPath) =>
      expectArray(constraints, constraintsPath, (constraint, constraintPath) => {
        const constraintObject = expectObject(constraint, constraintPath);
        required(constraintObject, "id", expectString, constraintPath);
        required(constraintObject, "effectorBonePath", expectString, constraintPath);
        required(constraintObject, "target", validateVector3, constraintPath);
        required(constraintObject, "chainLength", expectNumber, constraintPath);
        required(constraintObject, "iterations", expectNumber, constraintPath);
        required(constraintObject, "enabled", expectBoolean, constraintPath);
      }),
    path,
  );
  optional(object, "robot", validateRobotKinematics, path);
}

function validateRobotKinematics(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "baseBonePath", expectString, path);
  for (const key of ["toolBonePath", "toolObjectId"] as const) optional(object, key, expectString, path);
  optional(object, "targetObjectIds", validateStringArray, path);
  required(object, "joints", (joints, jointsPath) => expectArray(joints, jointsPath, validateRobotJoint), path);
  optional(object, "loadCapability", validateRobotLoadCapability, path);
  optional(object, "toolLoad", validateRobotToolLoad, path);
}

function validateRobotJoint(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["bonePath", "name"] as const) required(object, key, expectString, path);
  requiredLiteral(object, "axis", ["x", "y", "z"], path);
  for (const key of ["length", "minAngleDeg", "maxAngleDeg"] as const) required(object, key, expectNumber, path);
  if (typeof object.length === "number" && object.length <= 0) invalid(`${path}.length`, "必须大于 0");
  validateNumberRange(object.minAngleDeg, `${path}.minAngleDeg`, -360, 360);
  validateNumberRange(object.maxAngleDeg, `${path}.maxAngleDeg`, -360, 360);
}

function validateRobotLoadCapability(value: unknown, path: string): void {
  const object = expectObject(value, path);
  optional(object, "ratedPayloadKg", expectNumber, path);
  optional(object, "maximumLoadCenterDistanceMeters", expectNumber, path);
  optionalLiteral(object, "source", ["configured-prefab", "author-confirmed", "imported"], path);
  optional(object, "reference", expectString, path);
  if (typeof object.ratedPayloadKg === "number" && object.ratedPayloadKg <= 0) invalid(`${path}.ratedPayloadKg`, "必须大于 0");
  if (typeof object.maximumLoadCenterDistanceMeters === "number" && object.maximumLoadCenterDistanceMeters <= 0) {
    invalid(`${path}.maximumLoadCenterDistanceMeters`, "必须大于 0");
  }
}

function validateRobotToolLoad(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["tcpPositionMeters", "tcpOrientationEulerDeg", "combinedCenterOfMassMeters"] as const) {
    optional(object, key, validateVector3, path);
  }
  for (const key of ["toolMassKg", "carriedPayloadKg"] as const) {
    optional(object, key, expectNumber, path);
    if (typeof object[key] === "number" && object[key] < 0) invalid(`${path}.${key}`, "不能为负数");
  }
  optionalLiteral(object, "source", ["configured-prefab", "author-confirmed", "imported"], path);
  optional(object, "reference", expectString, path);
}

export function validatePhysicsBody(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "type", ["none", "fixed", "dynamic", "kinematic"], path);
  for (const key of ["mass", "friction", "restitution"] as const) required(object, key, expectNumber, path);
  optional(object, "initialLinearVelocity", (velocity, velocityPath) => {
    if (object.type !== "dynamic") invalid(velocityPath, "初速度仅支持动态刚体");
    const components = expectObject(velocity, velocityPath);
    for (const axis of ["x", "y", "z"] as const) required(components, axis, (component, componentPath) => {
      expectNumber(component, componentPath);
      if (!Number.isFinite(component) || Math.abs(component as number) > 1_000) invalid(componentPath, "初速度每轴必须在 ±1000 m/s 内");
    }, velocityPath);
  }, path);
  optional(object, "character", validateCharacterController, path);
}

/** 角色控制器作者参数：角度为弧度，长度单位为米；只做范围与类型把关，不替作者选默认值。 */
function validateCharacterController(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of Object.keys(object)) {
    if (!["offset", "maxSlopeClimbAngle", "minSlopeSlideAngle", "autostep", "snapToGround"].includes(key)) {
      invalid(`${path}.${key}`, "不属于角色控制器参数");
    }
  }
  optional(object, "offset", (offset, offsetPath) => {
    expectNumber(offset, offsetPath);
    if ((offset as number) <= 0 || (offset as number) > 10) invalid(offsetPath, "必须大于 0 且不超过 10 米");
  }, path);
  for (const key of ["maxSlopeClimbAngle", "minSlopeSlideAngle"] as const) {
    optional(object, key, (angle, anglePath) => {
      expectNumber(angle, anglePath);
      // 0 表示只能走平地，π/2 表示垂直面也算可走；超出即为无意义输入。
      if ((angle as number) < 0 || (angle as number) > Math.PI / 2) invalid(anglePath, "必须在 0 到 π/2 之间");
    }, path);
  }
  optional(object, "autostep", (autostep, autostepPath) => {
    const step = expectObject(autostep, autostepPath);
    required(step, "enabled", expectBoolean, autostepPath);
    for (const key of Object.keys(step)) {
      if (!["enabled", "maxHeight", "minWidth", "includeDynamicBodies"].includes(key)) invalid(`${autostepPath}.${key}`, "不属于自动台阶参数");
    }
    optional(step, "maxHeight", (height, heightPath) => {
      expectNumber(height, heightPath);
      if ((height as number) <= 0 || (height as number) > 10) invalid(heightPath, "必须大于 0 且不超过 10 米");
    }, autostepPath);
    optional(step, "minWidth", (width, widthPath) => {
      expectNumber(width, widthPath);
      if ((width as number) <= 0 || (width as number) > 10) invalid(widthPath, "必须大于 0 且不超过 10 米");
    }, autostepPath);
    optional(step, "includeDynamicBodies", expectBoolean, autostepPath);
  }, path);
  optional(object, "snapToGround", (snap, snapPath) => {
    const snapObject = expectObject(snap, snapPath);
    required(snapObject, "enabled", expectBoolean, snapPath);
    for (const key of Object.keys(snapObject)) {
      if (!["enabled", "distance"].includes(key)) invalid(`${snapPath}.${key}`, "不属于贴地参数");
    }
    optional(snapObject, "distance", (distance, distancePath) => {
      expectNumber(distance, distancePath);
      if ((distance as number) <= 0 || (distance as number) > 10) invalid(distancePath, "必须大于 0 且不超过 10 米");
    }, snapPath);
  }, path);
}
