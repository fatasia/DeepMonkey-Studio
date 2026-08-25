import type { ApplicationDocument } from "./application.js";
import { assertPathSafeResourceId } from "./resourceId.js";

type JsonObject = Record<string, unknown>;
type Validator = (value: unknown, path: string) => void;

const MODEL_FORMATS = ["rvt", "ifc", "step", "stp", "dwg", "dxf", "gltf", "glb", "fbx"] as const;
const INTERACTION_TRIGGERS = ["load", "click", "pointerEnter", "pointerLeave", "animationStart", "animationEnd"] as const;
const INTERACTION_ACTION_TYPES = ["visibility", "color", "opacity", "focus", "animation", "openUrl", "navigateScene", "cameraView", "message", "dashboard", "setData"] as const;

export function validateApplicationDocument(value: unknown): asserts value is ApplicationDocument {
  const application = expectObject(value, "应用文档必须是对象");
  if (application.schemaVersion !== 2) throw new Error("仅支持 ApplicationDocument schemaVersion 2");

  const metadata = expectObject(application.metadata, "应用 metadata 必须是对象");
  if (typeof metadata.id !== "string" || typeof metadata.projectId !== "string") {
    throw new Error("应用 metadata.id 和 metadata.projectId 必须是字符串");
  }
  if (!Number.isInteger(metadata.revision) || (metadata.revision as number) < 1) {
    throw new Error("应用 metadata.revision 必须是大于等于 1 的整数");
  }
  validateMetadata(metadata, "应用.metadata");

  validateArrayProperty(application, "pages", validatePage);
  validateArrayProperty(application, "topologies", validateTopology);
  validateArrayProperty(application, "scenes", validateScene);
  required(application, "geo", validateGeo, "应用");
  required(application, "data", validateData, "应用");
  validateArrayProperty(application, "interactions", validateInteraction);
  validateArrayProperty(application, "scripts", validateScript);
  validateArrayProperty(application, "assets", validateAsset);
  validateArrayProperty(application, "timelines", validateTimeline);
  validateArrayProperty(application, "publicationProfiles", validatePublicationProfile);
}

function validateMetadata(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectPathSafeResourceId, path);
  required(object, "projectId", expectPathSafeResourceId, path);
  required(object, "name", expectString, path);
  required(object, "revision", expectPositiveInteger, path);
  required(object, "createdAt", expectString, path);
  required(object, "updatedAt", expectString, path);
  optional(object, "source", (source, sourcePath) => {
    const sourceObject = expectObject(source, sourcePath);
    requiredLiteral(sourceObject, "kind", ["scene-snapshot-v1"], sourcePath);
    required(sourceObject, "sceneId", expectString, sourcePath);
    required(sourceObject, "hadInteractions", expectBoolean, sourcePath);
    optional(sourceObject, "publishedAt", expectString, sourcePath);
  }, path);
}

function validatePage(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  requiredLiteral(object, "width", [1920], path);
  requiredLiteral(object, "height", [1080], path);
  required(object, "nodes", (nodes, nodesPath) => expectArray(nodes, nodesPath, validateWidgetNode), path);
}

function validateWidgetNode(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "frame", validateWidgetFrame, path);
  required(object, "zIndex", expectNumber, path);
  if (object.kind === "scene-viewport") {
    required(object, "sceneId", expectString, path);
    optional(object, "cameraViewId", expectString, path);
    requiredLiteral(object, "renderMode", ["realtime", "load-on-interaction", "static-placeholder"], path);
    requiredLiteral(object, "interactionPolicy", ["display-only", "click-select", "full-navigation"], path);
    requiredLiteral(object, "overlaySlot", ["page"], path);
    return;
  }
  if (object.kind === "legacy-dashboard-panel") {
    required(object, "state", validateDashboard, path);
    return;
  }
  if (object.kind === "data-widget") {
    required(object, "widget", validateDashboardWidgetConfig, path);
    return;
  }
  invalid(`${path}.kind`, "必须是受支持的组件类型");
}

function validateWidgetFrame(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["x", "y", "width", "height"] as const) required(object, key, expectNumber, path);
}

function validateDashboard(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "side", ["left", "right"], path);
  required(object, "width", expectNumber, path);
  for (const key of ["backgroundColor"] as const) optional(object, key, expectString, path);
  for (const key of ["backgroundOpacity", "blur", "borderRadius"] as const) optional(object, key, expectNumber, path);
  required(object, "widgets", (widgets, widgetsPath) => expectArray(widgets, widgetsPath, validateDashboardWidget), path);
}

function validateDashboardWidget(value: unknown, path: string): void {
  validateDashboardWidgetConfig(value, path);
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  for (const key of ["x", "y", "w", "h"] as const) required(object, key, expectNumber, path);
}

function validateDashboardWidgetConfig(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["title", "key", "unit"] as const) required(object, key, expectString, path);
  requiredLiteral(object, "type", ["value", "gauge", "status", "line", "area", "bar", "pie", "table", "image", "video", "monitor", "url"], path);
  for (const key of ["min", "max", "backgroundOpacity"] as const) optional(object, key, expectNumber, path);
  for (const key of ["color", "backgroundColor", "textColor", "datasetId", "field", "url", "imageUrl", "assetId", "videoUrl", "monitorSourceUrl"] as const) {
    optional(object, key, expectString, path);
  }
  optionalLiteral(object, "imageFit", ["cover", "contain", "fill"], path);
  optionalLiteral(object, "videoFit", ["cover", "contain", "fill"], path);
  optional(object, "videoAutoplay", expectBoolean, path);
  optional(object, "videoMuted", expectBoolean, path);
  optionalLiteral(object, "monitorProtocol", ["hls", "webrtc"], path);
}

function validateTopology(value: unknown, path: string): void {
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

function validateScene(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const forbidden of ["schemaVersion", "projectId", "dashboard", "interactions", "publishedAt", "createdAt", "updatedAt"] as const) {
    if (hasOwn(object, forbidden)) invalid(`${path}.${forbidden}`, "不属于 SceneDocument");
  }
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "camera", validateCamera, path);
  required(object, "models", (models, modelsPath) => expectArray(models, modelsPath, validateSceneModel), path);
  required(object, "primitives", (primitives, primitivesPath) => expectArray(primitives, primitivesPath, validatePrimitive), path);
  required(object, "measurements", (measurements, measurementsPath) => expectArray(measurements, measurementsPath, validateMeasurement), path);
  optional(object, "cameraConstraints", validateCameraConstraints, path);
  optional(object, "cameraViews", (views, viewsPath) => expectArray(views, viewsPath, validateCameraView), path);
  optional(object, "defaultCameraViewId", expectString, path);
  optional(object, "annotations", (annotations, annotationsPath) => expectArray(annotations, annotationsPath, validateAnnotation), path);
  optional(object, "clipping", validateClipping, path);
  optionalLiteral(object, "weather", ["sunny", "rain", "snow"], path);
  optional(object, "lighting", validateLighting, path);
  optional(object, "environment", validateEnvironment, path);
  optional(object, "floors", (floors, floorsPath) => expectArray(floors, floorsPath, validateFloor), path);
  optional(object, "postProcessing", validatePostProcessing, path);
  optional(object, "physics", validateScenePhysics, path);
  optional(object, "animation", validateAnimation, path);
  for (const key of ["selectedModelId", "selectedLayerId", "selectedAnnotationId"] as const) optional(object, key, expectString, path);
}

function validateSceneModel(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "modelId", expectString, path);
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
  optional(object, "material", validateMaterial, path);
  optional(object, "effects", validateModelEffects, path);
  optional(object, "physics", validatePhysicsBody, path);
  optional(object, "layers", (layers, layersPath) => expectArray(layers, layersPath, validateLayer), path);
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
  for (const key of ["color", "emissive"] as const) optional(object, key, expectString, path);
  for (const key of ["roughness", "metalness", "emissiveIntensity"] as const) optional(object, key, expectNumber, path);
  for (const key of ["wireframe", "doubleSided"] as const) optional(object, key, expectBoolean, path);
}

function validateModelEffects(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["outline", "glow", "xray", "scanline", "heatmap", "edgeLight"] as const) required(object, key, expectBoolean, path);
  for (const key of ["dissolve", "intensity"] as const) required(object, key, expectNumber, path);
  required(object, "color", expectString, path);
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
  optional(object, "box", (box, boxPath) => {
    const boxObject = expectObject(box, boxPath);
    required(boxObject, "min", validateVector3, boxPath);
    required(boxObject, "max", validateVector3, boxPath);
  }, path);
  optional(object, "face", (face, facePath) => {
    const faceObject = expectObject(face, facePath);
    required(faceObject, "normal", validateVector3, facePath);
    required(faceObject, "point", validateVector3, facePath);
  }, path);
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
  requiredLiteral(object, "skybox", ["none", "clear", "sunset", "night"], path);
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
  for (const key of ["fxaa", "gtao", "outline", "depthOfField", "vignette", "filmGrain", "afterimage"] as const) optional(object, key, expectBoolean, path);
  for (const key of ["gtaoIntensity", "outlineStrength", "focusDistance", "aperture", "maxBlur", "vignetteDarkness", "filmGrainIntensity", "afterimageDamp"] as const) {
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
  required(object, "loop", expectBoolean, path);
  optional(object, "pingPong", expectBoolean, path);
  optional(object, "playbackSpeed", expectNumber, path);
  optionalLiteral(object, "cameraInterpolation", ["linear", "smooth", "spline"], path);
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

function validateGeo(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "providerIds", validateStringArray, path);
  required(object, "layers", (layers, layersPath) => expectArray(layers, layersPath, (layer, layerPath) => {
    const layerObject = expectObject(layer, layerPath);
    required(layerObject, "id", expectString, layerPath);
    required(layerObject, "providerId", expectString, layerPath);
    required(layerObject, "visible", expectBoolean, layerPath);
  }), path);
}

function validateData(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "connectionIds", validateStringArray, path);
  required(object, "datasetIds", validateStringArray, path);
  required(object, "transforms", (transforms, transformsPath) => expectArray(transforms, transformsPath, (transform, transformPath) => {
    const transformObject = expectObject(transform, transformPath);
    required(transformObject, "id", expectString, transformPath);
    required(transformObject, "expression", expectString, transformPath);
  }), path);
  required(object, "variables", (variables, variablesPath) => expectArray(variables, variablesPath, (variable, variablePath) => {
    const variableObject = expectObject(variable, variablePath);
    required(variableObject, "id", expectString, variablePath);
    required(variableObject, "value", validateJsonValue, variablePath);
  }), path);
}

function validateInteraction(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "source", validateApplicationObjectRef, path);
  requiredLiteral(object, "trigger", INTERACTION_TRIGGERS, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "actions", (actions, actionsPath) => expectArray(actions, actionsPath, validateInteractionAction), path);
  optional(object, "legacyScript", (legacyScript, legacyPath) => {
    const legacyObject = expectObject(legacyScript, legacyPath);
    requiredLiteral(legacyObject, "runtime", ["legacy-trusted-main-thread"], legacyPath);
    required(legacyObject, "script", validateInteractionScript, legacyPath);
  }, path);
}

function validateApplicationObjectRef(value: unknown, path: string): void {
  const object = expectObject(value, path);
  if (object.kind === "page" || object.kind === "widget" || object.kind === "scene") {
    required(object, "id", expectString, path);
    return;
  }
  if (object.kind === "object") {
    required(object, "sceneId", expectString, path);
    required(object, "modelId", expectString, path);
    optional(object, "layerId", expectString, path);
    return;
  }
  invalid(`${path}.kind`, "必须是受支持的对象引用类型");
}

function validateInteractionScript(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "target", validateInteractionTarget, path);
  requiredLiteral(object, "trigger", INTERACTION_TRIGGERS, path);
  required(object, "enabled", expectBoolean, path);
  optional(object, "actions", (actions, actionsPath) => expectArray(actions, actionsPath, validateInteractionAction), path);
  required(object, "code", expectString, path);
}

function validateInteractionTarget(value: unknown, path: string): void {
  const object = expectObject(value, path);
  if (object.kind === "object") {
    required(object, "modelId", expectString, path);
    optional(object, "layerId", expectString, path);
    return;
  }
  if (object.kind === "widget") {
    required(object, "widgetId", expectString, path);
    return;
  }
  invalid(`${path}.kind`, "必须是 object 或 widget");
}

function validateInteractionAction(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  requiredLiteral(object, "type", INTERACTION_ACTION_TYPES, path);
  required(object, "enabled", expectBoolean, path);
  optional(object, "value", expectStringNumberOrBoolean, path);
  optional(object, "url", expectString, path);
  optional(object, "newTab", expectBoolean, path);
  optionalAllowUndefined(object, "target", validateObjectInteractionTarget, path);
  for (const key of ["sceneId", "cameraViewId", "message", "dataKey"] as const) optional(object, key, expectString, path);
}

function validateObjectInteractionTarget(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "kind", ["object"], path);
  required(object, "modelId", expectString, path);
  optional(object, "layerId", expectString, path);
}

function validateScript(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  requiredLiteral(object, "apiVersion", ["1.0"], path);
  requiredLiteral(object, "entrypoint", ["behavior"], path);
  requiredLiteral(object, "runtime", ["worker-sandbox", "legacy-trusted-main-thread"], path);
  required(object, "code", expectString, path);
  required(object, "capabilities", validateStringArray, path);
}

function validateAsset(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  requiredLiteral(object, "kind", ["model", "image", "video", "environment"], path);
  required(object, "projectId", expectString, path);
  optional(object, "sourceName", expectString, path);
  optionalLiteral(object, "sourceFormat", MODEL_FORMATS, path);
  optional(object, "contentHash", expectString, path);
}

function validateTimeline(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "duration", expectNumber, path);
  required(object, "trackIds", validateStringArray, path);
}

function validatePublicationProfile(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  requiredLiteral(object, "target", ["browser-preview", "server-web"], path);
  required(object, "entryPageId", expectString, path);
  requiredLiteral(object, "renderer", ["webgl2", "auto"], path);
}

function validateJsonObject(value: unknown, path: string): void {
  const object = expectObject(value, path);
  const ancestors = new WeakSet<object>([object]);
  validateJsonObjectProperties(object, path, ancestors);
}

function validateJsonValue(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    invalid(path, "必须是有限 JSON 数字");
  }
  if (typeof value !== "object") invalid(path, "必须是 JSON 值");
  if (ancestors.has(value)) invalid(path, "不能包含循环引用");
  ancestors.add(value);
  if (Array.isArray(value)) {
    validateJsonArray(value, path, ancestors);
  } else {
    const object = expectObject(value, path);
    validateJsonObjectProperties(object, path, ancestors);
  }
  ancestors.delete(value);
}

function validateJsonObjectProperties(object: JsonObject, path: string, ancestors: WeakSet<object>): void {
  rejectJsonSymbolProperties(object, path);
  for (const key of Object.getOwnPropertyNames(object)) {
    validateJsonValue(object[key], `${path}.${key}`, ancestors);
  }
}

function validateJsonArray(array: unknown[], path: string, ancestors: WeakSet<object>): void {
  rejectJsonSymbolProperties(array, path);
  for (const key of Object.getOwnPropertyNames(array)) {
    if (key === "length") continue;
    if (!isArrayIndex(key, array.length)) invalid(`${path}.${key}`, "不是有效的 JSON 数组索引");
  }
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(array, index)) invalid(`${path}[${index}]`, "不能是稀疏数组项");
    validateJsonValue(array[index], `${path}[${index}]`, ancestors);
  }
}

function rejectJsonSymbolProperties(object: object, path: string): void {
  if (Object.getOwnPropertySymbols(object).length > 0) invalid(path, "不能包含 Symbol 属性");
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function validateArrayProperty(object: JsonObject, key: string, validator: Validator): void {
  required(object, key, (value, path) => expectArray(value, path, validator), "应用");
}

function validateStringArray(value: unknown, path: string): void {
  expectArray(value, path, expectString);
}

function expectArray(value: unknown, path: string, validator: Validator): void {
  if (!Array.isArray(value)) invalid(path, "必须是数组");
  rejectJsonSymbolProperties(value, path);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length") continue;
    if (!isArrayIndex(key, value.length)) invalid(`${path}.${key}`, "不是有效的数组索引");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid(`${path}[${index}]`, "不能是稀疏数组项");
    validator(value[index], `${path}[${index}]`);
  }
}

function expectObject(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "必须是对象");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "必须是普通对象");
  return value as JsonObject;
}

function expectString(value: unknown, path: string): void {
  if (typeof value !== "string") invalid(path, "必须是字符串");
}

function expectPathSafeResourceId(value: unknown, path: string): void {
  try {
    assertPathSafeResourceId(value, path);
  } catch (error) {
    invalid(path, error instanceof Error ? error.message.replace(`${path} `, "") : "必须是路径安全 ID");
  }
}

function expectBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") invalid(path, "必须是布尔值");
}

function expectNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "必须是有限数字");
}

function expectPositiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) invalid(path, "必须是大于等于 1 的整数");
}

function expectStringNumberOrBoolean(value: unknown, path: string): void {
  if (typeof value === "number") return expectNumber(value, path);
  if (typeof value !== "string" && typeof value !== "boolean") invalid(path, "必须是字符串、数字或布尔值");
}

function required(object: JsonObject, key: string, validator: Validator, path: string): void {
  if (!hasOwn(object, key)) invalid(`${path}.${key}`, "不能为空");
  validator(object[key], `${path}.${key}`);
}

function optional(object: JsonObject, key: string, validator: Validator, path: string): void {
  if (hasOwn(object, key)) validator(object[key], `${path}.${key}`);
}

function optionalAllowUndefined(object: JsonObject, key: string, validator: Validator, path: string): void {
  if (hasOwn(object, key) && object[key] !== undefined) validator(object[key], `${path}.${key}`);
}

function requiredLiteral(object: JsonObject, key: string, values: readonly unknown[], path: string): void {
  required(object, key, (value, valuePath) => expectLiteral(value, values, valuePath), path);
}

function optionalLiteral(object: JsonObject, key: string, values: readonly unknown[], path: string): void {
  optional(object, key, (value, valuePath) => expectLiteral(value, values, valuePath), path);
}

function expectLiteral(value: unknown, values: readonly unknown[], path: string): void {
  if (!values.includes(value)) invalid(path, `必须是 ${values.join("、")} 之一`);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function invalid(path: string, reason: string): never {
  throw new Error(`${path} ${reason}`);
}
