import * as THREE from "three";
import { clipOverlayTriangle, overlayLine, overlayVertex, type OverlayClipPoint, type OverlayColor } from "./studioDeepOverlayGeometry";

/** Reads only explicitly selected editor roots; no actor state, parenting or visibility is modified. */
export function projectStudioEditorOverlay(roots: readonly THREE.Object3D[], camera: THREE.Camera,
  width: number, height: number, pixelRatio: number): Float32Array<ArrayBuffer> {
  if (![width, height, pixelRatio].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid editor overlay viewport.");
  const objects: THREE.Object3D[] = [], seen = new Set<THREE.Object3D>();
  const visit = (object: THREE.Object3D): void => {
    if (!object.visible || seen.has(object)) return;
    seen.add(object);
    if (object.layers.test(camera.layers) && ((object as THREE.Mesh).isMesh || (object as THREE.Line).isLine)) objects.push(object);
    object.children.forEach(visit);
  };
  for (const root of roots) {
    let visible = true;
    for (let parent = root.parent; parent; parent = parent.parent) visible &&= parent.visible;
    if (visible) visit(root);
  }
  if (!objects.length) return new Float32Array();
  if (objects.some(object => Number.isNaN(object.renderOrder))) throw new Error("Invalid editor overlay render order.");
  objects.sort((a, b) => a.renderOrder === b.renderOrder ? 0 : a.renderOrder < b.renderOrder ? -1 : 1);
  const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), output: number[] = [];
  for (const object of objects) appendObject(output, object as THREE.Mesh | THREE.Line, projection, width, height, pixelRatio);
  return new Float32Array(output);
}

function appendObject(output: number[], object: THREE.Mesh | THREE.Line, projection: THREE.Matrix4,
  width: number, height: number, pixelRatio: number): void {
  if (Array.isArray(object.material)) throw new Error("Editor overlay material groups are not supported.");
  const material = object.material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
  if (!material.visible || material.depthTest || material.opacity === 0) return;
  if (!(material instanceof THREE.MeshBasicMaterial || material instanceof THREE.LineBasicMaterial)
    || material.toneMapped || material.map || material.vertexColors || material.blending !== THREE.NormalBlending)
    throw new Error("Unsupported editor overlay material.");
  const alpha = material.transparent ? material.opacity : 1;
  if (![material.color.r, material.color.g, material.color.b, material.opacity, alpha].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
    throw new Error("Invalid editor overlay color or opacity.");
  const display = material.color.clone().convertLinearToSRGB();
  const color: OverlayColor = [display.r, display.g, display.b, alpha];
  const geometry = object.geometry, position = geometry.getAttribute("position"), index = geometry.index;
  if (!position || position.itemSize !== 3) throw new Error("Editor overlay requires position3 geometry.");
  const matrix = new THREE.Matrix4().multiplyMatrices(projection, object.matrixWorld);
  const point = (vertex: number): OverlayClipPoint => {
    const clip = new THREE.Vector4(position.getX(vertex), position.getY(vertex), position.getZ(vertex), 1).applyMatrix4(matrix);
    if (![clip.x, clip.y, clip.z, clip.w].every(Number.isFinite)) throw new Error("Editor overlay positions must be finite.");
    return [clip.x, clip.y, clip.z, clip.w];
  };
  const count = index?.count ?? position.count;
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(geometry.drawRange.start) || geometry.drawRange.start < 0
    || !(geometry.drawRange.count === Infinity || Number.isSafeInteger(geometry.drawRange.count) && geometry.drawRange.count >= 0))
    throw new Error("Invalid editor overlay draw range.");
  if (count > 196_608) throw new Error("Editor overlay source exceeds its vertex budget.");
  const start = Math.min(count, geometry.drawRange.start), end = Math.min(count, start + geometry.drawRange.count);
  const vertex = (offset: number): number => {
    const value = index ? index.getX(offset) : offset;
    if (!Number.isSafeInteger(value) || value < 0 || value >= position.count) throw new Error("Invalid editor overlay index.");
    return value;
  };
  const lineWidth = (material as THREE.LineBasicMaterial).linewidth ?? (material as THREE.MeshBasicMaterial).wireframeLinewidth ?? 1;
  if (!Number.isFinite(lineWidth) || lineWidth <= 0 || lineWidth > 64) throw new Error("Invalid editor overlay line width.");
  const line = (a: number, b: number): void => {
    if (material instanceof THREE.LineDashedMaterial) appendDashed(output, point(a), point(b), a, b, geometry, material, color, width, height, pixelRatio);
    else overlayLine(output, point(a), point(b), color, width, height, lineWidth * pixelRatio);
  };
  if ((object as THREE.Line).isLine) {
    const step = (object as THREE.LineSegments).isLineSegments ? 2 : 1;
    for (let offset = start; offset + 1 < end; offset += step) line(vertex(offset), vertex(offset + 1));
    if ((object as THREE.LineLoop).isLineLoop && end > start + 1) line(vertex(end - 1), vertex(start));
  } else if ((material as THREE.MeshBasicMaterial).wireframe) {
    const edges = new Set<string>();
    for (let offset = start; offset + 2 < end; offset += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const va = vertex(offset + a!), vb = vertex(offset + b!), key = `${Math.min(va, vb)}:${Math.max(va, vb)}`;
      if (!edges.has(key)) { edges.add(key); line(va, vb); }
    }
  } else {
    const orientation = object.matrixWorld.determinant() < 0 ? -1 : 1;
    for (let offset = start; offset + 2 < end; offset += 3) {
      const polygon = clipOverlayTriangle([point(vertex(offset)), point(vertex(offset + 1)), point(vertex(offset + 2))]);
      for (let corner = 1; corner + 1 < polygon.length; corner++) {
        const a = polygon[0]!, b = polygon[corner]!, c = polygon[corner + 1]!;
        const area = (b[0] / b[3] - a[0] / a[3]) * (c[1] / c[3] - a[1] / a[3])
          - (b[1] / b[3] - a[1] / a[3]) * (c[0] / c[3] - a[0] / a[3]);
        if (material.side !== THREE.DoubleSide && (material.side === THREE.FrontSide ? area * orientation <= 0 : area * orientation >= 0)) continue;
        for (const p of [a, b, c]) overlayVertex(output, [p[0], p[1], (p[2] + p[3]) / 2, p[3]], color);
      }
    }
  }
}

function appendDashed(output: number[], a: OverlayClipPoint, b: OverlayClipPoint, ia: number, ib: number,
  geometry: THREE.BufferGeometry, material: THREE.LineDashedMaterial, color: OverlayColor,
  width: number, height: number, ratio: number): void {
  const distances = geometry.getAttribute("lineDistance");
  if (!distances) throw new Error("Editor dashed line requires author line distances.");
  const start = distances.getX(ia) * material.scale, end = distances.getX(ib) * material.scale;
  const period = material.dashSize + material.gapSize;
  if (![start, end, period, material.dashSize].every(Number.isFinite) || end < start || period <= 0 || material.dashSize <= 0 || material.gapSize < 0)
    throw new Error("Invalid editor dashed line dimensions.");
  if (end === start) return;
  const lerp = (t: number): OverlayClipPoint => [0, 1, 2, 3].map(axis => a[axis]! + (b[axis]! - a[axis]!) * t) as unknown as OverlayClipPoint;
  if ((end - start) / period > 4096) throw new Error("Editor dashed line exceeds segment budget.");
  for (let cell = Math.floor(start / period); cell * period < end; cell++) {
    const lo = Math.max(start, cell * period), hi = Math.min(end, cell * period + material.dashSize);
    if (hi > lo) overlayLine(output, lerp((lo - start) / (end - start)), lerp((hi - start) / (end - start)), color, width, height, material.linewidth * ratio);
  }
}
