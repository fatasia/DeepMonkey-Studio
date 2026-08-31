import type {
  ExplosionMode,
  MeasurementState,
  ModelRecord,
  PrimitiveKind,
  SceneLightState,
  SkyboxPreset
} from "@bim-studio/contracts";
import type { InteractionTargetOption } from "./components/InteractionEditor";
import { translate as tr, type AppLocale } from "./i18n";
import { numberFormat } from "./appDefaults";
import type { BimPropertyEntry, BimSpaceRecord, LayerTreeNode, MeasureMode } from "./viewer/ViewerEngine";

export function primitiveKindLabel(kind: PrimitiveKind, locale: AppLocale): string {
  const labels: Record<PrimitiveKind, [string, string]> = {
    box: ["立方体", "Box"], sphere: ["球体", "Sphere"], cylinder: ["圆柱体", "Cylinder"],
    cone: ["圆锥体", "Cone"], torus: ["圆环", "Torus"], plane: ["平面", "Plane"], capsule: ["胶囊体", "Capsule"]
  };
  return tr(locale, labels[kind][0], labels[kind][1]);
}

export function spacePropertyEntries(space: BimSpaceRecord, locale: AppLocale): BimPropertyEntry[] {
  const base: BimPropertyEntry[] = [
    { name: tr(locale, "空间 ID", "Space ID"), value: space.id, group: "identity" },
    { name: tr(locale, "名称", "Name"), value: space.name, group: "identity" },
    ...(space.number ? [{ name: tr(locale, "编号", "Number"), value: space.number, group: "identity" }] : []),
    { name: tr(locale, "楼层", "Floor"), value: space.level, group: "constraints" },
    { name: tr(locale, "类型", "Type"), value: space.kind, group: "identity" },
    ...(space.department ? [{ name: tr(locale, "部门", "Department"), value: space.department, group: "identity" }] : []),
    ...(space.areaSquareMetres === undefined ? [] : [{ name: tr(locale, "面积", "Area"), value: `${numberFormat.format(space.areaSquareMetres)} m²`, group: "dimensions" }]),
    ...(space.volumeCubicMetres === undefined ? [] : [{ name: tr(locale, "体积", "Volume"), value: `${numberFormat.format(space.volumeCubicMetres)} m³`, group: "dimensions" }]),
    ...(space.bounds ? [
      { name: tr(locale, "边界最小点", "Bounds minimum"), value: formatVector(space.bounds.min), group: "dimensions" },
      { name: tr(locale, "边界最大点", "Bounds maximum"), value: formatVector(space.bounds.max), group: "dimensions" }
    ] : [])
  ];
  return [...base, ...(space.parameters ?? [])];
}

export function statusText(model: ModelRecord, loaded: boolean, locale: AppLocale): string {
  if (loaded) return tr(locale, "已载入场景", "Loaded in scene");
  if (model.status === "ready") return `${formatBytes(model.size)} · ${tr(locale, "点击加载", "Click to load")}`;
  if (model.status === "processing") return `${model.progress}% · ${model.message}`;
  if (model.status === "waiting_converter") return waitingConverterText(model, locale);
  if (model.status === "failed") return `${tr(locale, "失败", "Failed")} · ${model.message}`;
  return model.message;
}

function waitingConverterText(model: ModelRecord, locale: AppLocale): string {
  if (model.format === "rvt") return tr(locale, "等待 Revit 转换机", "Waiting for Revit converter");
  if (model.format === "x_t" || model.format === "x_b") {
    return tr(locale, "等待 Parasolid 转换器", "Waiting for Parasolid converter");
  }
  if (model.format === "jt") return tr(locale, "等待 JT 转换器", "Waiting for JT converter");
  return tr(locale, "等待外部转换器", "Waiting for external converter");
}

export function appendInteractionLayerOptions(options: InteractionTargetOption[], node: LayerTreeNode, modelName: string, depth: number, limit: number): void {
  if (options.length >= limit) return;
  if (node.id !== "root") options.push({ label: `${modelName} / ${"· ".repeat(Math.min(depth, 3))}${node.name}`, target: { kind: "object", modelId: node.modelId, layerId: node.id } });
  for (const child of node.children) {
    appendInteractionLayerOptions(options, child, modelName, depth + 1, limit);
    if (options.length >= limit) return;
  }
}

export function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${numberFormat.format(size / 1024)} KB`;
  return `${numberFormat.format(size / 1024 / 1024)} MB`;
}

export function measureModeName(mode: MeasureMode, locale: AppLocale): string {
  if (mode === "minimum") return tr(locale, "最小距离", "Minimum distance");
  if (mode === "angle") return tr(locale, "角度测量", "Angle");
  if (mode === "elevation") return tr(locale, "标高测量", "Elevation");
  if (mode === "horizontal") return tr(locale, "水平距离", "Horizontal distance");
  if (mode === "vertical") return tr(locale, "垂直高度", "Vertical height");
  return tr(locale, "距离测量", "Distance");
}

export function formatMeasurementValue(measurement: MeasurementState): string {
  if (measurement.kind === "angle") return `${numberFormat.format((measurement.angle ?? 0) * 180 / Math.PI)}°`;
  if (measurement.kind === "elevation") {
    const elevation = measurement.elevation ?? measurement.end.y;
    return `${elevation >= 0 ? "+" : ""}${numberFormat.format(elevation)} m`;
  }
  if (measurement.distance < 1) return `${Math.round(measurement.distance * 1000)} mm`;
  return `${numberFormat.format(measurement.distance)} m`;
}

export function explosionModeName(mode: ExplosionMode, locale: AppLocale): string {
  if (mode === "vertical") return tr(locale, "楼层", "Floors");
  if (mode === "x") return tr(locale, "X 轴", "X axis");
  if (mode === "y") return tr(locale, "Y 轴", "Y axis");
  if (mode === "z") return tr(locale, "Z 轴", "Z axis");
  return tr(locale, "径向", "Radial");
}

export function skyboxEnglishLabel(preset: SkyboxPreset): string {
  if (preset === "none") return "Solid";
  if (preset === "studio") return "Industrial studio";
  if (preset === "bright-studio") return "Bright studio";
  if (preset === "clear") return "Clear sky";
  if (preset === "overcast") return "Overcast";
  if (preset === "dawn") return "Dawn";
  if (preset === "sunset") return "Sunset";
  if (preset === "night") return "Night";
  return "Industrial night";
}

export function lightTypeName(type: SceneLightState["type"]): string {
  if (type === "ambient") return "环境光";
  if (type === "hemisphere") return "半球光";
  if (type === "directional") return "方向光";
  if (type === "point") return "点光源";
  if (type === "spot") return "聚光灯";
  return "矩形区域光";
}

export function lightTypeEnglishName(type: SceneLightState["type"]): string {
  if (type === "ambient") return "Ambient";
  if (type === "hemisphere") return "Hemisphere";
  if (type === "directional") return "Directional";
  if (type === "point") return "Point";
  if (type === "spot") return "Spot";
  return "Rect area";
}

export function formatVector(vector: { x: number; y: number; z: number }): string {
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}
