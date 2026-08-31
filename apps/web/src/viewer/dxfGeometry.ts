import * as THREE from "three";

export interface DxfVertex {
  x: number;
  y: number;
  z?: number;
}

export interface DxfEntity {
  type?: string;
  layer?: string;
  vertices?: DxfVertex[];
  center?: DxfVertex;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  colorNumber?: number;
}

export interface DxfDocument {
  entities?: DxfEntity[];
  header?: Record<string, unknown>;
}

export function dxfPoints(entity: DxfEntity): THREE.Vector3[] {
  if (entity.vertices?.length) return entity.vertices.map((vertex) => new THREE.Vector3(vertex.x, vertex.y, vertex.z ?? 0));
  if ((entity.type === "CIRCLE" || entity.type === "ARC") && entity.center && entity.radius) {
    const start = entity.type === "ARC" ? entity.startAngle ?? 0 : 0;
    const end = entity.type === "ARC" ? entity.endAngle ?? Math.PI * 2 : Math.PI * 2;
    return Array.from({ length: 49 }, (_, index) => {
      const angle = start + ((end - start) * index) / 48;
      return new THREE.Vector3(
        entity.center!.x + Math.cos(angle) * entity.radius!,
        entity.center!.y + Math.sin(angle) * entity.radius!,
        entity.center!.z ?? 0
      );
    });
  }
  return [];
}

export function dxfUnitScale(value: unknown): number {
  const unit = Number(value);
  if (unit === 1) return 0.0254;
  if (unit === 2 || unit === 21) return 0.3048;
  if (unit === 4) return 0.001;
  if (unit === 5) return 0.01;
  if (unit === 6) return 1;
  if (unit === 14) return 0.1;
  return 1;
}

export function dxfUnitName(value: unknown): string {
  const unit = Number(value);
  if (unit === 1) return "inch";
  if (unit === 2 || unit === 21) return "foot";
  if (unit === 4) return "millimeter";
  if (unit === 5) return "centimeter";
  if (unit === 6) return "meter";
  if (unit === 14) return "decimeter";
  return "drawing units";
}

export function dxfDrawingExtents(header?: Record<string, unknown>): THREE.Box2 | undefined {
  const minimum = header?.["$EXTMIN"] as { x?: unknown; y?: unknown } | undefined;
  const maximum = header?.["$EXTMAX"] as { x?: unknown; y?: unknown } | undefined;
  const minX = Number(minimum?.x);
  const minY = Number(minimum?.y);
  const maxX = Number(maximum?.x);
  const maxY = Number(maximum?.y);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return undefined;
  const padding = Math.max(maxX - minX, maxY - minY) * 0.02;
  return new THREE.Box2(
    new THREE.Vector2(minX - padding, minY - padding),
    new THREE.Vector2(maxX + padding, maxY + padding)
  );
}

export function pointsIntersectExtents(points: THREE.Vector3[], extents: THREE.Box2): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return maxX >= extents.min.x && minX <= extents.max.x && maxY >= extents.min.y && minY <= extents.max.y;
}
