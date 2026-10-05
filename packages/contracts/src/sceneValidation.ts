/** SceneDocument 与拓扑的结构校验；仅依赖安全原语，避免把业务校验散落到 API 路由。
 *  source-size 拆分(2026-10-04):按校验域分文件(材质/模型结构/动画/物理+骨骼/环境/
 *  预制体),代码逐行同源,仅改可见性;本文件保留场景编排(validateScene/validateTopology)
 *  与场景级域(数据绑定/资产绑定/选择集/根图层顺序/楼层/场景物理),入口 re-export 面
 *  不变(validateTopology/validateScene),既有 import 路径零变化。 */
import { assertDirectBindingSpec } from "./directBinding.js";
import { assertDeviceSignalRule } from "./deviceSignal.js";
import {
  expectArray,
  expectBoolean,
  expectNumber,
  expectObject,
  expectString,
  hasOwn,
  invalid,
  optional,
  optionalLiteral,
  required,
  requiredLiteral,
  validateJsonObject,
  validateStringArray,
} from "./applicationValidationPrimitives.js";
import {
  validateAnnotation,
  validateCamera,
  validateCameraConstraints,
  validateCameraView,
  validateClipping,
  validateMeasurement,
  validateNavigationSettings,
  validatePrimitive,
  validateSceneModel,
  validateVector3,
} from "./sceneValidationSceneModel.js";
import { validateUserMaterialPresetDefinition } from "./sceneValidationMaterial.js";
import { validateAnimation } from "./sceneValidationAnimation.js";
import {
  validateEnvironment,
  validateLighting,
  validatePostProcessing,
} from "./sceneValidationEnvironment.js";
import {
  validateUserPrefabDefinition,
  validateUserPrefabInstanceRecord,
} from "./sceneValidationPrefab.js";

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
  optional(object, "userPrefabs", (prefabs, prefabsPath) => expectArray(prefabs, prefabsPath, validateUserPrefabDefinition), path);
  optional(object, "userPrefabInstances", (instances, instancesPath) => expectArray(instances, instancesPath, validateUserPrefabInstanceRecord), path);
  optional(object, "userMaterialPresets", (presets, presetsPath) => expectArray(presets, presetsPath, validateUserMaterialPresetDefinition), path);
  optional(object, "rootLayerOrder", validateRootLayerOrder, path);
  for (const key of ["selectedModelId", "selectedLayerId", "selectedAnnotationId"] as const) optional(object, key, expectString, path);
}

function validateRootLayerOrder(value: unknown, path: string): void {
  const seen = new Set<string>();
  expectArray(value, path, (entry, entryPath) => {
    const object = expectObject(entry, entryPath);
    for (const key of Object.keys(object)) if (key !== "kind" && key !== "id") invalid(`${entryPath}.${key}`, "不属于根图层引用");
    required(object, "kind", expectString, entryPath);
    required(object, "id", expectString, entryPath);
    if (!["group", "object", "light", "measurement", "annotation", "space"].includes(String(object.kind))) invalid(`${entryPath}.kind`, "未知根图层类型");
    if (!String(object.id).trim()) invalid(`${entryPath}.id`, "不能为空");
    const key = `${object.kind}:${object.id}`;
    if (seen.has(key)) invalid(entryPath, "根图层引用重复");
    seen.add(key);
  });
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
  requiredLiteral(object, "action", ["color", "visibility", "position", "label", "opacity", "focus", "animation", "effects", "material", "alarm"], path);
  optional(object, "signalRule", assertDeviceSignalRule, path);
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

function validateFloor(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "modelId", expectString, path);
  required(object, "level", expectString, path);
  required(object, "visible", expectBoolean, path);
  required(object, "expansion", expectNumber, path);
}

function validateScenePhysics(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "playing", expectBoolean, path);
  required(object, "gravity", validateVector3, path);
}
