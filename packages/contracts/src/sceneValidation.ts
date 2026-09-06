/** SceneDocument 与拓扑的结构校验；仅依赖安全原语，避免把业务校验散落到 API 路由。 */
import { assertDirectBindingSpec } from "./directBinding.js";
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
  expectStringNumberOrBoolean,
  hasOwn,
  invalid,
  optional,
  optionalAllowUndefined,
  optionalLiteral,
  required,
  requiredLiteral,
  validateJsonObject,
  validateStringArray,
} from "./applicationValidationPrimitives.js";

const MODEL_FORMATS = supportedExtensions;

export function validateTopology(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "nodes", (nodes, nodesPath) => expectArray(nodes, nodesPath, validateTopologyNode), path);
  required(object, "edges", (edges, edgesPath) => expectArray(edges, edgesPath, validateTopologyEdge), path);
}

function validateTopologyNode(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "kind", expectString, path);
  required(object, "x", expectNumber, path);
  required(object, "y", expectNumber, path);
  required(object, "properties", validateJsonObject, path);
}

function validateTopologyEdge(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["id", "sourceNodeId", "targetNodeId"] as const) required(object, key, expectString, path);
  required(object, "properties", validateJsonObject, path);
}

export function validateScene(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const forbidden of [
    "schemaVersion",
    "projectId",
    "dashboard",
    "interactions",
    "publishedAt",
    "publicationMode",
    "publicationPerformance",
    "publicationToolbarVisible",
    "createdAt",
    "updatedAt",
  ] as const) {
    if (hasOwn(object, forbidden)) invalid(`${path}.${forbidden}`, "不属于 SceneDocument");
  }
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "camera", validateCamera, path);
  required(object, "models", (models, modelsPath) => expectArray(models, modelsPath, validateSceneModel), path);
  required(object, "primitives", (primitives, primitivesPath) => expectArray(primitives, primitivesPath, validatePrimitive), path);
  required(object, "measurements", (measurements, measurementsPath) => expectArray(measurements, measurementsPath, validateMeasurement), path);
  optional(object, "cameraConstraints", validateCameraConstraints, path);
  optional(object, "navigationSettings", validateNavigationSettings, path);
  optional(object, "cameraViews", (views, viewsPath) => expectArray(views, viewsPath, validateCameraView), path);
  optional(object, "defaultCameraViewId", expectString, path);
  optional(object, "annotations", (annotations, annotationsPath) => expectArray(annotations, annotationsPath, validateAnnotation), path);
  optional(object, "clipping", validateClipping, path);
  optionalLiteral(object, "weather", ["sunny", "cloudy", "rain", "snow", "fog", "storm"], path);
  optional(object, "lighting", validateLighting, path);
  optional(object, "environment", validateEnvironment, path);
  optional(object, "floors", (floors, floorsPath) => expectArray(floors, floorsPath, validateFloor), path);
  optional(object, "postProcessing", validatePostProcessing, path);
  optional(object, "physics", validateScenePhysics, path);
  optional(object, "animation", validateAnimation, path);
  optional(object, "dataBindings", (bindings, bindingsPath) => expectArray(bindings, bindingsPath, validateSceneDataBinding), path);
  optional(object, "assetBindings", (bindings, bindingsPath) => expectArray(bindings, bindingsPath, validateSceneAssetBinding), path);
  optional(object, "selectionSets", (sets, setsPath) => expectArray(sets, setsPath, validateSceneSelectionSet), path);
  for (const key of ["selectedModelId", "selectedLayerId", "selectedAnnotationId"] as const) optional(object, key, expectString, path);
}

function validateSceneAssetBinding(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["id", "sceneObjectId", "objectName", "modelId", "deviceId", "confirmedAt"] as const) required(object, key, expectString, path);
  optional(object, "layerId", expectString, path);
  required(object, "confidence", expectNumber, path);
  if (typeof object.confidence === "number" && (object.confidence < 0 || object.confidence > 1)) invalid(`${path}.confidence`, "必须在 0–1 范围内");
}

function validateSceneSelectionSet(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "objectIds", validateStringArray, path);
  optionalLiteral(object, "kind", ["selection", "group"], path);
}

function validateSceneDataBinding(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["id", "name", "field"] as const) required(object, key, expectString, path);
  required(object, "enabled", expectBoolean, path);
  optional(object, "datasetId", expectString, path);
  optional(object, "pipelineId", expectString, path);
  optional(object, "directBinding", (binding, bindingPath) => assertDirectBindingSpec(binding, bindingPath), path);
  optional(object, "rowIndex", expectNumber, path);
  required(object, "refreshSeconds", expectNumber, path);
  requiredLiteral(object, "action", ["color", "visibility", "position", "label", "opacity", "focus", "animation", "effects", "material"], path);
  required(
    object,
    "target",
    (target, targetPath) => {
      const targetObject = expectObject(target, targetPath);
      for (const key of ["modelId", "layerId", "annotationId"] as const) optional(targetObject, key, expectString, targetPath);
      if (!["modelId", "annotationId"].some((key) => typeof targetObject[key] === "string" && targetObject[key])) invalid(targetPath, "至少需要 modelId 或 annotationId");
    },
    path,
  );
  const products = [object.datasetId, object.pipelineId, object.directBinding].filter(
    (item) => (typeof item === "string" && item.length > 0) || (typeof item === "object" && item !== null),
  );
  if (products.length !== 1) invalid(path, "必须且只能绑定一个数据集、数据管道或直接数据源");
}

function validateSceneModel(value: unknown, path: string): void {
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

function validatePrimitive(value: unknown, path: string): void {
  validateSceneModel(value, path);
  const object = expectObject(value, path);
  requiredLiteral(object, "kind", ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"], path);
  required(object, "color", expectString, path);
}

function validateLayer(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "nodeId", expectString, path);
  for (const key of ["visible", "locked", "deleted"] as const) optional(object, key, expectBoolean, path);
  for (const key of ["name", "color"] as const) optional(object, key, expectString, path);
  optional(object, "opacity", expectNumber, path);
  optional(object, "material", validateMaterial, path);
  optional(object, "transform", validateTransform, path);
}

function validateMaterial(value: unknown, path: string): void {
  const object = expectObject(value, path);
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
  for (const key of ["wireframe", "doubleSided"] as const) optional(object, key, expectBoolean, path);
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

function validateModelEffects(value: unknown, path: string): void {
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
  }, path);
}

function validateNumberRange(value: unknown, path: string, minimum: number, maximum: number): void {
  if (typeof value === "number" && (value < minimum || value > maximum)) invalid(path, `必须在 ${minimum}–${maximum} 范围内`);
}

function validateRig(value: unknown, path: string): void {
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

function validatePhysicsBody(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "type", ["none", "fixed", "dynamic"], path);
  for (const key of ["mass", "friction", "restitution"] as const) required(object, key, expectNumber, path);
}

function validateMeasurement(value: unknown, path: string): void {
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

function validateAnnotation(value: unknown, path: string): void {
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

function validateCamera(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "position", validateVector3, path);
  required(object, "target", validateVector3, path);
  requiredLiteral(object, "mode", ["orbit", "firstPerson", "thirdPerson"], path);
  optional(object, "avatarVisible", expectBoolean, path);
}

function validateCameraConstraints(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["minDistance", "maxDistance", "minPolarAngle", "maxPolarAngle", "nearClip", "farClip", "collisionRadius"] as const) {
    required(object, key, expectNumber, path);
  }
  required(object, "collisionEnabled", expectBoolean, path);
}

function validateNavigationSettings(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["walkSpeed", "flySpeed", "sprintMultiplier", "eyeHeight", "gravity", "jumpSpeed", "stepHeight", "maxSlopeAngle"] as const) {
    required(object, key, expectNumber, path);
  }
}

function validateCameraView(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "camera", validateCamera, path);
  required(object, "createdAt", expectString, path);
}

function validateClipping(value: unknown, path: string): void {
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

function validateLighting(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "intensity", expectNumber, path);
  for (const key of ["shadowsEnabled", "reflectionsEnabled", "globalIlluminationEnabled"] as const) optional(object, key, expectBoolean, path);
  optional(object, "globalIlluminationIntensity", expectNumber, path);
  optional(object, "lights", (lights, lightsPath) => expectArray(lights, lightsPath, validateLight), path);
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
}

function validateEnvironment(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "gridVisible", expectBoolean, path);
  required(object, "backgroundColor", expectString, path);
  requiredLiteral(object, "skybox", ["none", "studio", "bright-studio", "clear", "overcast", "dawn", "sunset", "night", "industrial-night"], path);
  for (const key of ["environmentMapUrl", "environmentMapName"] as const) optional(object, key, expectString, path);
  optional(object, "environmentAsBackground", expectBoolean, path);
  optional(object, "environmentIntensity", expectNumber, path);
}

function validateFloor(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "modelId", expectString, path);
  required(object, "level", expectString, path);
  required(object, "visible", expectBoolean, path);
  required(object, "expansion", expectNumber, path);
}

function validatePostProcessing(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["enabled", "smaa", "ssao", "bloom"] as const) required(object, key, expectBoolean, path);
  for (const key of ["ssaoIntensity", "bloomStrength", "bloomThreshold"] as const) required(object, key, expectNumber, path);
  for (const key of ["fxaa", "gtao", "outline", "depthOfField", "vignette", "filmGrain", "afterimage", "colorGrading"] as const) optional(object, key, expectBoolean, path);
  for (const key of ["gtaoIntensity", "outlineStrength", "focusDistance", "aperture", "maxBlur", "vignetteDarkness", "filmGrainIntensity", "afterimageDamp", "hue", "saturation", "brightness", "contrast"] as const) {
    optional(object, key, expectNumber, path);
  }
}

function validateScenePhysics(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "playing", expectBoolean, path);
  required(object, "gravity", validateVector3, path);
}

function validateAnimation(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "duration", expectNumber, path);
  optional(object, "autoplay", expectBoolean, path);
  required(object, "loop", expectBoolean, path);
  optional(object, "pingPong", expectBoolean, path);
  optional(object, "playbackSpeed", expectNumber, path);
  optional(object, "frameRate", expectNumber, path);
  optional(object, "snapToFrames", expectBoolean, path);
  optionalLiteral(object, "cameraInterpolation", ["linear", "smooth", "spline"], path);
  optionalLiteral(object, "modelInterpolation", ["linear", "smooth"], path);
  optional(object, "showCameraPath", expectBoolean, path);
  required(object, "camera", (frames, framesPath) => expectArray(frames, framesPath, validateCameraKeyframe), path);
  required(object, "models", (frames, framesPath) => expectArray(frames, framesPath, validateModelKeyframe), path);
}

function validateCameraKeyframe(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "time", expectNumber, path);
  required(object, "camera", validateCamera, path);
}

function validateModelKeyframe(value: unknown, path: string): void {
  const object = expectObject(value, path);
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

function validateTransform(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "position", validateVector3, path);
  required(object, "rotation", validateVector3, path);
  required(object, "scale", validateVector3, path);
}

function validateVector3(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["x", "y", "z"] as const) required(object, key, expectNumber, path);
}
