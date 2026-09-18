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
  return false;
}

export function hasOnlyCompiledCameraFields(scene: { readonly camera?: unknown }): boolean {
  const source = scene.camera;
  return record(source, ["mode", "position", "target", "avatarVisible"])
    && source.mode === "orbit" && optional(source, "avatarVisible", value => value === false)
    && vector(source.position) && vector(source.target);
}

const projectedOrMetadata = new Set(["schemaVersion", "id", "projectId", "name", "primitives", "models",
  "createdAt", "updatedAt", "publishedAt", "thumbnail", "publicationMode", "publicationPerformance",
  "publicationToolbarVisible", "selectedModelId", "selectedLayerId", "selectedAnnotationId"]);
const emptyCollections = new Set(["cameraViews", "measurements", "annotations", "floors", "dataBindings",
  "assetBindings", "interactions", "selectionSets"]);

/** 编译和归档消费共用字段集合；未知空数组也不能靠缺省证据绕过。 */
export function collectDeferredSceneFields(semantic: Readonly<RecordValue>): string[] {
  return Object.keys(semantic).filter(key => !projectedOrMetadata.has(key)
    && !(key === "camera" && hasOnlyCompiledCameraFields(semantic))
    && !isInactiveSceneField(key, semantic[key]) && semantic[key] !== undefined
    && !(emptyCollections.has(key) && Array.isArray(semantic[key]) && semantic[key].length === 0)).sort();
}

const projectedObjectFields = new Set(["modelId", "assetModelId", "name", "sourceName", "sourceFormat", "visible",
  "locked", "opacity", "color", "colorOverride", "transform", "kind", "material"]);

/** 编译与交付审计共用；证据中省略字段不能删除作者对象语义。 */
export function collectDeferredObjectFields(scene: {
  readonly models: readonly { readonly modelId: string }[];
  readonly primitives: readonly { readonly modelId: string }[];
}): Array<{ nodeId: string; fields: string[] }> {
  return [...scene.models, ...scene.primitives].flatMap(item => {
    const fields = Object.keys(item).filter(key => !projectedObjectFields.has(key)
      && (item as unknown as RecordValue)[key] !== undefined).sort();
    return fields.length ? [{ nodeId: item.modelId, fields }] : [];
  }).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
}
