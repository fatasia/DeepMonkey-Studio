/** 动画校验域:场景动画时间线与相机/模型关键帧(过渡与缓动合同)。
 *  source-size 拆分(2026-10-04):自 sceneValidation.ts 按校验域分文件,代码逐行同源,
 *  仅改可见性;语义零变化。 */
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
} from "./applicationValidationPrimitives.js";
import { validateCamera, validateTransform } from "./sceneValidationSceneModel.js";

export function validateAnimation(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "duration", expectNumber, path);
  optional(object, "autoplay", expectBoolean, path);
  required(object, "loop", expectBoolean, path);
  optional(object, "pingPong", expectBoolean, path);
  optional(object, "playbackSpeed", expectNumber, path);
  optional(object, "frameRate", expectNumber, path);
  optional(object, "snapToFrames", expectBoolean, path);
  optionalLiteral(object, "cameraInterpolation", ["linear", "smooth", "spline"], path);
  optionalLiteral(object, "modelInterpolation", ["linear", "smooth", "ease-in-out"], path);
  optional(object, "showCameraPath", expectBoolean, path);
  required(object, "camera", (frames, framesPath) => expectArray(frames, framesPath, validateCameraKeyframe), path);
  required(object, "models", (frames, framesPath) => expectArray(frames, framesPath, validateModelKeyframe), path);
}

/** 与 KeyframeTransition 契约同族的全部合法过渡；缺一个就会把 UI 合法写出的场景校拒。 */
const KEYFRAME_TRANSITIONS = ["linear", "smooth", "ease-in", "ease-out", "ease-in-out", "step", "cubic-bezier"] as const;

function validateKeyframeEasing(value: unknown, path: string): void {
  expectArray(value, path, expectNumber);
  if ((value as unknown[]).length !== 4) invalid(path, "需要四个贝塞尔参数");
}

function validateCameraKeyframe(value: unknown, path: string): void {
  const object = expectObject(value, path);
  optionalLiteral(object, "transition", KEYFRAME_TRANSITIONS, path);
  optional(object, "easing", validateKeyframeEasing, path);
  required(object, "id", expectString, path);
  required(object, "time", expectNumber, path);
  required(object, "camera", validateCamera, path);
}

function validateModelKeyframe(value: unknown, path: string): void {
  const object = expectObject(value, path);
  optionalLiteral(object, "transition", KEYFRAME_TRANSITIONS, path);
  optional(object, "easing", validateKeyframeEasing, path);
  optional(object, "visibility", expectBoolean, path);
  optional(object, "emissiveIntensity", expectNumber, path);
  required(object, "id", expectString, path);
  required(object, "time", expectNumber, path);
  required(object, "modelId", expectString, path);
  required(object, "transform", validateTransform, path);
  optional(
    object,
    "animation",
    (animation, animationPath) => {
      const animationObject = expectObject(animation, animationPath);
      optional(animationObject, "clipId", expectString, animationPath);
      required(animationObject, "time", expectNumber, animationPath);
    },
    path,
  );
}
