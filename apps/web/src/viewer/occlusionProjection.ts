import * as THREE from "three";

export interface OcclusionProjection { hull: THREE.Vector2[]; near: number; far: number; area: number; }

/** 只接受完全处于近裁面之后的包围体；穿过相机或近裁面的物体保持绘制。 */
export function projectOcclusionBox(box: THREE.Box3, world: THREE.Matrix4, camera: THREE.Camera): OcclusionProjection | undefined {
  const transform = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(world);
  const points: THREE.Vector2[] = [];
  let near = Infinity, far = -Infinity;
  for (let index = 0; index < 8; index++) {
    const point = new THREE.Vector4(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z, 1).applyMatrix4(transform);
    if (point.w <= 0 || !Number.isFinite(point.w)) return undefined;
    const z = point.z / point.w;
    const minimumDepth = camera.coordinateSystem === THREE.WebGPUCoordinateSystem ? 0 : -1;
    if (z <= minimumDepth + 1e-6 || !Number.isFinite(z)) return undefined;
    near = Math.min(near, z); far = Math.max(far, z);
    points.push(new THREE.Vector2(point.x / point.w, point.y / point.w));
  }
  const hull = convexHull(points);
  if (hull.length < 3) return undefined;
  const area = Math.abs(hull.reduce((sum, point, index) => {
    const next = hull[(index + 1) % hull.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
  return { hull, near, far, area };
}

/** 凸实体完整挡住目标投影且整体位于前方才剔除，边缘留余量避免浮点误判。 */
export function fullyOccluded(target: OcclusionProjection, blocker: OcclusionProjection): boolean {
  if (target.near <= blocker.far + 1e-5) return false;
  return target.hull.every(point => blocker.hull.every((start, index) => {
    const end = blocker.hull[(index + 1) % blocker.hull.length]!;
    return cross(start, end, point) > 0.002 * start.distanceTo(end);
  }));
}

function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  const ordered = points.sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: THREE.Vector2[] = [], upper: THREE.Vector2[] = [];
  for (const point of ordered) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  for (const point of ordered.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}

function cross(a: THREE.Vector2, b: THREE.Vector2, p: THREE.Vector2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
