import { validateScene, validateTopology } from "./sceneValidation.js";
import { DASHBOARD_PAGE_MAX_SIZE, DASHBOARD_PAGE_MIN_SIZE, type ApplicationDocument } from "./application.js";
import { assertPathSafeResourceId } from "./resourceId.js";
import { assertDirectBindingSpec } from "./directBinding.js";
import { assertDashboardSampleData } from "./dashboardSampleData.js";
import { validateDashboardTemplateSource } from "./dashboardTemplateSource.js";
import { supportedExtensions } from "./project.js";
import {
  expectArray,
  expectBoolean,
  expectLiteral,
  expectNonNegativeInteger,
  expectNumber,
  expectObject,
  expectPathSafeResourceId,
  expectPositiveInteger,
  expectString,
  expectStringNumberOrBoolean,
  hasOwn,
  invalid,
  optional,
  optionalAllowUndefined,
  optionalLiteral,
  required,
  requiredLiteral,
  validateArrayProperty,
  validateJsonObject,
  validateJsonValue,
  validateLiteralArray,
  validateStringArray,
} from "./applicationValidationPrimitives.js";

type JsonObject = Record<string, unknown>;
type Validator = (value: unknown, path: string) => void;

const MODEL_FORMATS = supportedExtensions;
const INTERACTION_TRIGGERS = ["load", "click", "doubleClick", "contextMenu", "pointerEnter", "pointerLeave", "animationStart", "animationEnd", "routePointReached"] as const;
const INTERACTION_ACTION_TYPES = [
  "visibility",
  "color",
  "opacity",
  "focus",
  "animation",
  "prefabAction",
  "openUrl",
  "navigateScene",
  "cameraView",
  "message",
  "dashboard",
  "setData",
  "unityAction",
] as const;
const SCRIPT_LIFECYCLES = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"] as const;
const SCRIPT_PERMISSIONS = ["scene.read", "scene.write", "data.read", "data.write", "ai.invoke", "network.connect", "renderer.extend", "editor.extend"] as const;

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
  optional(application, "scriptDependencies", (dependencies, dependenciesPath) => {
    expectArray(dependencies, dependenciesPath, validateScriptDependency);
    const specifiers = new Set<string>();
    for (const [index, dependency] of (dependencies as JsonObject[]).entries()) {
      if (typeof dependency.specifier !== "string") continue;
      if (specifiers.has(dependency.specifier)) invalid(`${dependenciesPath}[${index}].specifier`, "不能重复");
      specifiers.add(dependency.specifier);
    }
  }, "应用");
  validateArrayProperty(application, "assets", validateAsset);
  validateArrayProperty(application, "timelines", validateTimeline);
  validateArrayProperty(application, "publicationProfiles", validatePublicationProfile);
  optional(application, "spatialNavigation", validateSpatialNavigation, "应用");
}

function validateSpatialNavigation(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "rootNodeIds", validateStringArray, path);
  required(object, "cacheLimit", expectNonNegativeInteger, path);
  required(
    object,
    "nodes",
    (nodes, nodesPath) => {
      expectArray(nodes, nodesPath, validateSpatialNavigationNode);
      const nodeList = nodes as JsonObject[];
      const ids = new Set<string>();
      for (let index = 0; index < nodeList.length; index += 1) {
        const id = nodeList[index]?.id;
        if (typeof id !== "string") continue;
        if (ids.has(id)) invalid(`${nodesPath}[${index}].id`, "不能重复");
        ids.add(id);
      }
      const roots = object.rootNodeIds as unknown[];
      const rootIds = new Set(roots.filter((rootId): rootId is string => typeof rootId === "string"));
      if (rootIds.size !== roots.length) invalid(`${path}.rootNodeIds`, "不能重复");
      roots.forEach((rootId, index) => {
        if (typeof rootId === "string" && !ids.has(rootId)) invalid(`${path}.rootNodeIds[${index}]`, "必须引用存在的节点");
      });
      const byId = new Map(nodeList.flatMap((node) => (typeof node.id === "string" ? [[node.id, node] as const] : [])));
      nodeList.forEach((node, index) => {
        const parentId = node.parentId;
        if (typeof parentId === "string" && !ids.has(parentId)) invalid(`${nodesPath}[${index}].parentId`, "必须引用存在的节点");
        if (typeof parentId === "string" && parentId === node.id) invalid(`${nodesPath}[${index}].parentId`, "不能引用自身");
        if (rootIds.has(node.id as string) && typeof parentId === "string") invalid(`${nodesPath}[${index}].parentId`, "根节点不能有父节点");
        if (!rootIds.has(node.id as string) && typeof parentId !== "string") invalid(`${nodesPath}[${index}]`, "无父节点时必须声明为根节点");
        const visited = new Set<string>();
        let cursor: JsonObject | undefined = node;
        while (typeof cursor?.id === "string") {
          if (visited.has(cursor.id)) invalid(`${nodesPath}[${index}].parentId`, "不能形成循环");
          visited.add(cursor.id);
          cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : undefined;
        }
      });
    },
    path,
  );
}

function validateSpatialNavigationNode(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "kind", expectString, path);
  optional(object, "parentId", expectString, path);
  optional(object, "sceneId", expectString, path);
  optional(object, "dashboardPageId", expectString, path);
  optional(object, "entryCameraViewId", expectString, path);
  requiredLiteral(object, "loadPolicy", ["focus", "replace", "additive"], path);
  optional(
    object,
    "target",
    (target, targetPath) => {
      const targetObject = expectObject(target, targetPath);
      required(targetObject, "modelId", expectString, targetPath);
      optional(targetObject, "layerId", expectString, targetPath);
    },
    path,
  );
}

function validateMetadata(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectPathSafeResourceId, path);
  required(object, "projectId", expectPathSafeResourceId, path);
  required(object, "name", expectString, path);
  required(object, "revision", expectPositiveInteger, path);
  required(object, "createdAt", expectString, path);
  required(object, "updatedAt", expectString, path);
  optional(
    object,
    "source",
    (source, sourcePath) => {
      const sourceObject = expectObject(source, sourcePath);
      requiredLiteral(sourceObject, "kind", ["scene-snapshot-v1"], sourcePath);
      required(sourceObject, "sceneId", expectString, sourcePath);
      required(sourceObject, "hadInteractions", expectBoolean, sourcePath);
      optional(sourceObject, "publishedAt", expectString, sourcePath);
    },
    path,
  );
}

function validatePage(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "width", expectDashboardPageSize, path);
  required(object, "height", expectDashboardPageSize, path);
  requiredLiteral(object, "viewportFit", ["contain", "cover", "stretch", "fixed"], path);
  optional(object, "appearance", validateDashboardPageAppearance, path);
  optional(object, "templateSource", validateDashboardTemplateSource, path);
  optional(object, "guides", (guides, guidesPath) => expectArray(guides, guidesPath, validateDashboardGuide), path);
  required(
    object,
    "nodes",
    (nodes, nodesPath) => {
      expectArray(nodes, nodesPath, validateWidgetNode);
      const names = new Set<string>();
      (nodes as JsonObject[]).forEach((node, index) => {
        if (typeof node.name !== "string") return;
        const normalized = node.name.trim().toLocaleLowerCase();
        if (!normalized) invalid(`${nodesPath}[${index}].name`, "不能为空");
        if (names.has(normalized)) invalid(`${nodesPath}[${index}].name`, "在当前页面中必须唯一");
        names.add(normalized);
      });
    },
    path,
  );
}

function validateDashboardGuide(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  requiredLiteral(object, "orientation", ["horizontal", "vertical"], path);
  required(object, "position", expectNumber, path);
}

function expectDashboardPageSize(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < DASHBOARD_PAGE_MIN_SIZE || (value as number) > DASHBOARD_PAGE_MAX_SIZE) {
    invalid(path, `必须是 ${DASHBOARD_PAGE_MIN_SIZE} 到 ${DASHBOARD_PAGE_MAX_SIZE} 之间的整数`);
  }
}

function validateDashboardPageAppearance(value: unknown, path: string): void {
  const object = expectObject(value, path);
  optional(object, "backgroundColor", expectString, path);
  for (const key of ["backgroundOpacity", "blur", "borderRadius"] as const) optional(object, key, expectNumber, path);
}

function validateWidgetNode(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  optional(object, "name", expectString, path);
  required(object, "frame", validateWidgetFrame, path);
  required(object, "zIndex", expectNumber, path);
  optional(object, "visible", expectBoolean, path);
  optional(object, "selectable", expectBoolean, path);
  optional(object, "locked", expectBoolean, path);
  optional(object, "groupId", expectString, path);
  optional(object, "groupName", expectString, path);
  if (object.kind === "scene-viewport") {
    required(object, "sceneId", expectString, path);
    optional(object, "cameraViewId", expectString, path);
    requiredLiteral(object, "renderMode", ["realtime", "load-on-interaction", "static-placeholder"], path);
    requiredLiteral(object, "interactionPolicy", ["display-only", "click-select", "full-navigation"], path);
    requiredLiteral(object, "overlaySlot", ["page"], path);
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

function validateDashboardWidgetConfig(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["title", "key", "unit"] as const) required(object, key, expectString, path);
  requiredLiteral(
    object,
    "type",
    [
      "text",
      "shape",
      "decoration",
      "value",
      "digital-flip",
      "liquid-fill",
      "progress",
      "status",
      "gauge",
      "line",
      "area",
      "bar",
      "combo",
      "pie",
      "scatter",
      "radar",
      "funnel",
      "sankey",
      "sunburst",
      "treemap",
      "graph",
      "map",
      "rank",
      "table",
      "scroll-table",
      "filter",
      "image",
      "video",
      "monitor",
      "url",
      "unity",
      "topology",
    ],
    path,
  );
  for (const key of ["min", "max", "backgroundOpacity", "borderWidth", "fontSize", "fontWeight"] as const) optional(object, key, expectNumber, path);
  for (const key of ["unityUrl", "unityResourceId", "unityResourceVersionId", "unityManifestUrl", "unityVersion", "unityAllowedOrigin", "unityScene"] as const)
    optional(object, key, expectString, path);
  optional(object, "unityBridgeVersion", expectNumber, path);
  optional(object, "unityScenes", validateStringArray, path);
  optional(object, "unityEventNames", validateStringArray, path);
  optional(object, "unityDataBindings", (bindings, bindingsPath) => expectArray(bindings, bindingsPath, validateUnityDataBinding), path);
  optional(object, "unityDefaultAction", validateUnityDefaultAction, path);
  optional(object, "unityPropertyValues", validateJsonObject, path);
  optional(object, "directBinding", (binding, bindingPath) => assertDirectBindingSpec(binding, bindingPath), path);
  optional(object, "sampleData", assertDashboardSampleData, path);
  for (const key of [
    "color",
    "backgroundColor",
    "textColor",
    "datasetId",
    "pipelineId",
    "field",
    "url",
    "imageUrl",
    "assetId",
    "videoUrl",
    "monitorSourceUrl",
    "topologyId",
    "content",
    "borderColor",
  ] as const) {
    optional(object, key, expectString, path);
  }
  optionalLiteral(object, "imageFit", ["cover", "contain", "fill"], path);
  optionalLiteral(object, "videoFit", ["cover", "contain", "fill"], path);
  optional(object, "videoAutoplay", expectBoolean, path);
  optional(object, "videoMuted", expectBoolean, path);
  optional(object, "videoLoop", expectBoolean, path);
  optionalLiteral(object, "monitorProtocol", ["hls", "webrtc"], path);
  optionalLiteral(object, "shape", ["rectangle", "rounded", "ellipse", "line"], path);
  optionalLiteral(
    object,
    "decorationStyle",
    ["title", "border", "divider", "corner", "neon", "bracket", "segment", "scan", "dots", "diagonal", "header-wing", "frame-notch"],
    path,
  );
  optional(object, "options", validateStringArray, path);
  optionalLiteral(object, "filterMode", ["select", "multi-select", "text", "date"], path);
  optionalLiteral(object, "filterMatch", ["exact", "contains"], path);
  optional(object, "linkageParameterKey", expectString, path);
  optional(object, "chart", validateDashboardChart, path);
  optional(object, "analysis", validateDashboardAnalysis, path);
  optional(object, "report", validateDashboardReport, path);
  optionalLiteral(object, "textAlign", ["left", "center", "right"], path);
  optionalLiteral(object, "designState", ["auto", "empty", "loading", "partial", "error", "forbidden"], path);
  optionalLiteral(object, "animation", ["none", "fade", "slide-up", "scale", "pulse"], path);
  optional(object, "animationAutoplay", expectBoolean, path);
  optional(object, "animationLoop", expectBoolean, path);
  for (const key of ["animationDuration", "animationDelay"] as const) optional(object, key, expectNumber, path);
  const products = [object.datasetId, object.pipelineId, object.directBinding, object.sampleData].filter(
    (item) => (typeof item === "string" && item.length > 0) || (typeof item === "object" && item !== null),
  );
  if (products.length > 1 || (object.sampleData && object.semanticBinding)) invalid(path, "数据集、数据管道、直接数据源和示例数据最多只能选择一个");
}

function validateDashboardChart(value: unknown, path: string): void {
  const object = expectObject(value, path);
  for (const key of ["stacked", "showLegend", "showDataLabels"] as const) optional(object, key, expectBoolean, path);
  optional(object, "secondaryAxisSeries", validateStringArray, path);
}

const DASHBOARD_AGGREGATIONS = ["none", "count", "distinct-count", "sum", "average", "minimum", "maximum"] as const;

function validateDashboardAnalysis(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "aggregation", DASHBOARD_AGGREGATIONS, path);
  for (const key of ["dimensionField", "seriesField", "measureField"] as const) optional(object, key, expectString, path);
  optional(object, "drillFields", validateStringArray, path);
  optionalLiteral(object, "sort", ["none", "dimension-asc", "dimension-desc", "value-asc", "value-desc"], path);
  optional(object, "limit", expectNumber, path);
  optional(
    object,
    "calculatedFields",
    (fields, fieldsPath) =>
      expectArray(fields, fieldsPath, (field, fieldPath) => {
        const fieldObject = expectObject(field, fieldPath);
        required(fieldObject, "key", expectString, fieldPath);
        required(fieldObject, "label", expectString, fieldPath);
        required(fieldObject, "formula", expectString, fieldPath);
      }),
    path,
  );
}

function validateDashboardReport(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "mode", ["detail", "grouped", "crosstab"], path);
  for (const key of ["rowField", "columnField", "valueField", "currency"] as const) optional(object, key, expectString, path);
  optional(object, "valueFields", validateStringArray, path);
  optionalLiteral(object, "aggregation", DASHBOARD_AGGREGATIONS, path);
  for (const key of ["pageSize", "decimalPlaces"] as const) optional(object, key, expectNumber, path);
  for (const key of ["showSubtotal", "showGrandTotal", "freezeFirstColumn", "showRowNumbers", "stripedRows"] as const) optional(object, key, expectBoolean, path);
  optionalLiteral(object, "valueFormat", ["auto", "number", "percent", "currency"], path);
}

function validateUnityDataBinding(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "dataKey", expectString, path);
  required(object, "layerKey", expectString, path);
}

function validateUnityDefaultAction(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "action", expectString, path);
  optional(object, "objectId", expectString, path);
}

function validateGeo(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "providerIds", validateStringArray, path);
  required(
    object,
    "layers",
    (layers, layersPath) =>
      expectArray(layers, layersPath, (layer, layerPath) => {
        const layerObject = expectObject(layer, layerPath);
        required(layerObject, "id", expectString, layerPath);
        required(layerObject, "providerId", expectString, layerPath);
        required(layerObject, "visible", expectBoolean, layerPath);
      }),
    path,
  );
}

function validateData(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "connectionIds", validateStringArray, path);
  required(object, "datasetIds", validateStringArray, path);
  required(
    object,
    "transforms",
    (transforms, transformsPath) =>
      expectArray(transforms, transformsPath, (transform, transformPath) => {
        const transformObject = expectObject(transform, transformPath);
        required(transformObject, "id", expectString, transformPath);
        required(transformObject, "expression", expectString, transformPath);
      }),
    path,
  );
  required(
    object,
    "variables",
    (variables, variablesPath) =>
      expectArray(variables, variablesPath, (variable, variablePath) => {
        const variableObject = expectObject(variable, variablePath);
        required(variableObject, "id", expectString, variablePath);
        required(variableObject, "value", validateJsonValue, variablePath);
      }),
    path,
  );
}

function validateInteraction(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectString, path);
  required(object, "name", expectString, path);
  required(object, "source", validateApplicationObjectRef, path);
  requiredLiteral(object, "trigger", INTERACTION_TRIGGERS, path);
  required(object, "enabled", expectBoolean, path);
  required(object, "actions", (actions, actionsPath) => expectArray(actions, actionsPath, validateInteractionAction), path);
  optional(
    object,
    "legacyScript",
    (legacyScript, legacyPath) => {
      const legacyObject = expectObject(legacyScript, legacyPath);
      requiredLiteral(legacyObject, "runtime", ["legacy-trusted-main-thread"], legacyPath);
      required(legacyObject, "script", validateInteractionScript, legacyPath);
    },
    path,
  );
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
  optional(object, "prefabAction", (action, actionPath) => {
    if (!["dispatch", "pause", "resume", "stop", "return", "replay", "clear-fault"].includes(String(action))) {
      invalid(actionPath, "必须是受支持的工业预制体动作");
    }
  }, path);
  optional(object, "transition", (transition, transitionPath) => {
    const transitionObject = expectObject(transition, transitionPath);
    requiredLiteral(transitionObject, "kind", ["none", "fade", "scale", "rise"], transitionPath);
    required(transitionObject, "durationMs", expectNumber, transitionPath);
    requiredLiteral(transitionObject, "easing", ["linear", "ease-in", "ease-out", "ease-in-out"], transitionPath);
  }, path);
  optionalAllowUndefined(object, "target", validateObjectInteractionTarget, path);
  for (const key of ["sceneId", "dashboardPageId", "cameraViewId", "message", "dataKey", "unityAction", "unityObjectId"] as const) optional(object, key, expectString, path);
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
  required(object, "enabled", expectBoolean, path);
  requiredLiteral(object, "apiVersion", ["1.0"], path);
  requiredLiteral(object, "entrypoint", ["behavior"], path);
  requiredLiteral(object, "runtime", ["worker-sandbox", "legacy-trusted-main-thread"], path);
  required(object, "code", expectString, path);
  required(object, "lifecycle", (lifecycle, lifecyclePath) => validateLiteralArray(lifecycle, lifecyclePath, SCRIPT_LIFECYCLES), path);
  required(object, "capabilities", validateStringArray, path);
  required(object, "permissions", (permissions, permissionsPath) => validateLiteralArray(permissions, permissionsPath, SCRIPT_PERMISSIONS), path);
  optional(object, "target", validateScriptTarget, path);
}

function validateScriptTarget(value: unknown, path: string): void {
  const object = expectObject(value, path);
  requiredLiteral(object, "kind", ["scene", "object", "component"], path);
  if (object.kind === "object" || object.kind === "component") required(object, "id", expectString, path);
}

function validateScriptDependency(value: unknown, path: string): void {
  const object = expectObject(value, path);
  required(object, "id", expectPathSafeResourceId, path);
  required(object, "specifier", (specifier, specifierPath) => {
    expectString(specifier, specifierPath);
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i.test(String(specifier))) {
      invalid(specifierPath, "必须是 npm 风格模块名");
    }
  }, path);
  requiredLiteral(object, "source", ["npm", "upload", "external-url"], path);
  required(object, "requested", expectString, path);
  optional(object, "resolvedVersion", expectString, path);
  required(object, "fileName", expectString, path);
  required(object, "assetUrl", expectString, path);
  required(object, "integrity", (integrity, integrityPath) => {
    expectString(integrity, integrityPath);
    if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(String(integrity))) invalid(integrityPath, "必须是 SHA-256 SRI");
  }, path);
  required(object, "size", expectNonNegativeInteger, path);
  optional(object, "license", expectString, path);
  required(object, "installedAt", expectString, path);
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
