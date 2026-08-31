import * as THREE from "three";
import type { MeasurementState, SceneAnnotationState, SceneInteractionTarget } from "@bim-studio/contracts";

export function sameRuntimeInteractionTarget(left: SceneInteractionTarget, right: SceneInteractionTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "widget" && right.kind === "widget") return left.widgetId === right.widgetId;
  if (left.kind === "object" && right.kind === "object") return left.modelId === right.modelId && (left.layerId ?? "") === (right.layerId ?? "");
  return false;
}

export function heatMapColor(value: number): THREE.Color {
  const cold = new THREE.Color(0x2563eb);
  const middle = new THREE.Color(0xfacc15);
  const hot = new THREE.Color(0xef4444);
  return value < 0.5 ? cold.lerp(middle, value * 2) : middle.lerp(hot, (value - 0.5) * 2);
}

export function normalizeAnnotation(annotation: SceneAnnotationState): SceneAnnotationState {
  return {
    ...structuredClone(annotation),
    name: annotation.name.trim() || "未命名标签",
    description: annotation.description?.trim() ?? "",
    color: /^#[0-9a-f]{6}$/i.test(annotation.color) ? annotation.color : "#2f8fff",
    visible: annotation.visible !== false,
    locked: annotation.locked === true,
    size: THREE.MathUtils.clamp(annotation.size ?? 1, 0.35, 3)
  };
}

export function ellipsize(value: string, maxLength: number): string {
  const characters = [...value];
  return characters.length <= maxLength ? value : `${characters.slice(0, Math.max(maxLength - 1, 1)).join("")}…`;
}

export function formatMeasurementState(measurement: MeasurementState): string {
  const kind = measurement.kind ?? "distance";
  if (kind === "angle") return `${THREE.MathUtils.radToDeg(measurement.angle ?? 0).toFixed(1)}°`;
  if (kind === "elevation") {
    const elevation = measurement.elevation ?? measurement.end.y;
    return `标高 ${elevation >= 0 ? "+" : ""}${elevation.toFixed(3)} m`;
  }
  const prefix = kind === "minimum" ? "最小 " : kind === "horizontal" ? "水平 " : kind === "vertical" ? "垂直 " : "";
  if (measurement.distance < 1) return `${prefix}${Math.round(measurement.distance * 1000)} mm`;
  return `${prefix}${measurement.distance.toFixed(measurement.distance < 10 ? 3 : 2)} m`;
}

export function countObjects(object: THREE.Object3D): number {
  let count = 0;
  object.traverse(() => count += 1);
  return count;
}
