import { hasActiveSceneEffects } from "./sceneNeutralAppearance.ts";
type RecordValue = Record<string, unknown>;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const bool = (value: unknown) => typeof value === "boolean";
const oneOf = (value: unknown, values: readonly unknown[]) => values.includes(value);
function record(value: unknown, keys: readonly string[]): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}
function vector(value: unknown): value is RecordValue & { x: number; y: number; z: number } {
  return record(value, ["x", "y", "z"]) && finite(value.x) && finite(value.y) && finite(value.z);
}
function optional(value: RecordValue, key: string, validate: (value: unknown) => boolean): boolean {
  return !Object.hasOwn(value, key) || validate(value[key]);
}
function clippingBox(value: unknown): boolean {
  if (!record(value, ["min", "max"]) || !vector(value.min) || !vector(value.max)) return false;
  const { min, max } = value;
  return (["x", "y", "z"] as const).every(axis => min[axis] <= max[axis]);
}
function clippingFace(value: unknown): boolean {
  return record(value, ["normal", "point"]) && vector(value.normal) && vector(value.point)
    && Math.hypot(value.normal.x, value.normal.y, value.normal.z) > 0;
}

/** 仅消除已证明无运行效果的完整状态；原始字段仍参与源快照 hash。 */
export function isInactiveSceneField(field: string, value: unknown): boolean {
  if (field === "coordinateSystem") {
    return record(value, ["unit", "upAxis", "handedness", "origin"])
      && value.unit === "m" && value.upAxis === "y" && value.handedness === "right"
      && vector(value.origin) && value.origin.x === 0 && value.origin.y === 0 && value.origin.z === 0;
  }
  if (field === "physics") {
    return record(value, ["enabled", "playing", "gravity"])
      && value.enabled === false && value.playing === false && vector(value.gravity);
  }
  if (field === "clipping") {
    return record(value, ["enabled", "mode", "axis", "offset", "inverted", "box", "face", "showHelper"])
      && value.enabled === false && oneOf(value.axis, ["x", "y", "z"])
      && finite(value.offset) && bool(value.inverted)
      && optional(value, "mode", mode => oneOf(mode, ["axis", "box", "face"]))
      && optional(value, "showHelper", bool) && optional(value, "box", clippingBox)
      && optional(value, "face", clippingFace);
  }
  if (field === "animation") {
    return record(value, ["duration", "autoplay", "loop", "pingPong", "playbackSpeed", "frameRate", "snapToFrames",
      "cameraInterpolation", "modelInterpolation", "showCameraPath", "camera", "models"])
      && finite(value.duration) && value.duration >= 0 && bool(value.loop)
      && Array.isArray(value.camera) && value.camera.length === 0
      && Array.isArray(value.models) && value.models.length === 0
      && ["autoplay", "pingPong", "snapToFrames", "showCameraPath"].every(key => optional(value, key, bool))
      && ["playbackSpeed", "frameRate"].every(key => optional(value, key, number => finite(number) && number > 0))
      && optional(value, "cameraInterpolation", mode => oneOf(mode, ["linear", "smooth", "spline"]))
      && optional(value, "modelInterpolation", mode => oneOf(mode, ["linear", "smooth"]));
  }
  if (field === "cameraConstraints") {
    // Active camera constraints are accounted for by the camera compiler and
    // its compiled-field evidence rather than discarded as neutral defaults.
    return false;
  }
  if (field === "navigationSettings") {
    return exact(value, { walkSpeed: 4, flySpeed: 5, sprintMultiplier: 2, eyeHeight: 1.68,
      gravity: 12, jumpSpeed: 5.4, stepHeight: .3, maxSlopeAngle: 50 });
  }
  if (field === "postProcessing") {
    return exact(value, { enabled: true, smaa: true, fxaa: false, ssao: false, ssaoIntensity: 1,
      gtao: true, gtaoIntensity: .72, screenSpaceReflection: false, ssrSteps: 32, ssrThickness: .01,
      ssrMaxDistance: 2, bloom: false, bloomStrength: .35, bloomThreshold: .9,
      outline: false, outlineStrength: 2.5, depthOfField: false, focusDistance: 10, aperture: .00002,
      maxBlur: .006, vignette: false, vignetteDarkness: 1.2, filmGrain: false, filmGrainIntensity: .18,
      afterimage: false, afterimageDamp: .9, colorGrading: false, hue: 0, saturation: 0, brightness: 0, contrast: 0, temperature: 0, tint: 0 });
  }
  if (field === "dashboard") {
    return record(value, ["side", "width", "backgroundColor", "backgroundOpacity", "blur", "borderRadius", "widgets"])
      && Array.isArray(value.widgets) && value.widgets.length === 0;
  }
  if (field === "weather") return value === "sunny";
  return false;
}

export function hasOnlyCompiledCameraConstraintFields(value: unknown): boolean {
  if (!record(value, ["minDistance", "maxDistance", "minPolarAngle", "maxPolarAngle", "nearClip", "farClip",
    "collisionEnabled", "collisionRadius"])) return false;
  return ["minDistance", "maxDistance", "minPolarAngle", "maxPolarAngle", "nearClip", "farClip", "collisionRadius"]
    .every(key => optional(value, key, finite)) && optional(value, "collisionEnabled", bool);
}

function exact(value: unknown, expected: RecordValue): boolean {
  return record(value, Object.keys(expected)) && Object.keys(expected).length === Object.keys(value).length
    && Object.entries(expected).every(([key, item]) => value[key] === item);
}

export function hasOnlyCompiledCameraFields(scene: { readonly camera?: unknown }): boolean {
  const source = scene.camera;
  return record(source, ["mode", "position", "target", "avatarVisible"])
    && source.mode === "orbit" && optional(source, "avatarVisible", value => value === false)
    && vector(source.position) && vector(source.target);
}

const projectedOrMetadata = new Set(["schemaVersion", "id", "projectId", "name", "primitives", "models",
  "createdAt", "updatedAt", "publishedAt", "thumbnail", "publicationMode", "publicationPerformance",
  "publicationToolbarVisible", "selectedModelId", "selectedLayerId", "selectedAnnotationId", "selectionSets", "rootLayerOrder"]);
const emptyCollections = new Set(["cameraViews", "measurements", "annotations", "floors", "dataBindings",
  "assetBindings", "interactions", "selectionSets"]);

/** 编译和归档消费共用字段集合；未知空数组也不能靠缺省证据绕过。 */
export function collectDeferredSceneFields(semantic: Readonly<RecordValue>): string[] {
  return Object.keys(semantic).filter(key => !projectedOrMetadata.has(key)
    && !(key === "camera" && hasOnlyCompiledCameraFields(semantic))
    && !((key === "cameraViews" || key === "defaultCameraViewId") && hasOnlyRedundantCompiledCameraViews(semantic))
    && !isInactiveSceneField(key, semantic[key]) && semantic[key] !== undefined
    && !(emptyCollections.has(key) && Array.isArray(semantic[key]) && semantic[key].length === 0)).sort();
}

function hasOnlyRedundantCompiledCameraViews(scene: Readonly<RecordValue>): boolean {
  const views = scene.cameraViews;
  if (!Array.isArray(views) || views.length === 0 || typeof scene.defaultCameraViewId !== "string") return false;
  const valid = views.every(view => record(view, ["id", "name", "createdAt", "camera"])
    && record(view.camera, ["mode", "position", "target", "avatarVisible"])
    && vector(view.camera.position) && vector(view.camera.target));
  if (!valid) return false;
  const selected = views.find(view => (view as RecordValue).id === scene.defaultCameraViewId) as RecordValue | undefined;
  if (!selected) return false;
  const camera = selected.camera as RecordValue;
  return views.every(view => {
    const candidate = (view as RecordValue).camera as RecordValue;
    return candidate.mode === camera.mode && candidate.avatarVisible === camera.avatarVisible
      && (["position", "target"] as const).every(field => {
        const left = candidate[field] as RecordValue, right = camera[field] as RecordValue;
        return left.x === right.x && left.y === right.y && left.z === right.z;
      });
  });
}

const projectedObjectFields = new Set(["modelId", "assetModelId", "name", "sourceName", "sourceFormat", "visible",
  "locked", "opacity", "color", "colorOverride", "transform", "kind", "material", "effects", "prefab"]);

/** 编译与交付审计共用；证据中省略字段不能删除作者对象语义。 */
export function collectDeferredObjectFields(scene: {
  readonly models: readonly { readonly modelId: string }[];
  readonly primitives: readonly { readonly modelId: string }[];
}): Array<{ nodeId: string; fields: string[] }> {
  return [...scene.models, ...scene.primitives].flatMap(item => {
    const source = item as unknown as RecordValue;
    const fields = Object.keys(item).filter(key => !projectedObjectFields.has(key)
      && source[key] !== undefined && !isInactiveObjectField(key, source[key])).sort();
    return fields.length ? [{ nodeId: item.modelId, fields }] : [];
  }).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
}

function isInactiveObjectField(field: string, value: unknown): boolean {
  if (field === "collisionEnabled") return value === false;
  if (field === "explosionFactor") return value === 0;
  if (field === "explosionMode") return value === "radial";
  if (field === "layers") return Array.isArray(value) && value.length === 0;
  if (field === "effects") return !hasActiveSceneEffects(value as never);
  if (field === "physics") return record(value, ["type", "mass", "friction", "restitution"])
    && value.type === "none" && finite(value.mass) && finite(value.friction) && finite(value.restitution);
  return false;
}
