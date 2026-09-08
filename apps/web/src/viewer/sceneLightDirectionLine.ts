import { BufferAttribute, type Line, type Vector3 } from "three";

/** 仅端点变化时上传虚线几何；相机运动仍由调用方更新可拾取手柄。 */
export function updateSceneLightDirectionLine(line: Line, from: Vector3, to: Vector3): void {
  const geometry = line.geometry;
  const position = geometry.getAttribute("position") as BufferAttribute;
  // 几何采用 Float32，比较前量化避免 0.1 等坐标每帧被误判为变化。
  const x0 = Math.fround(from.x), y0 = Math.fround(from.y), z0 = Math.fround(from.z);
  const x1 = Math.fround(to.x), y1 = Math.fround(to.y), z1 = Math.fround(to.z);
  const changed = position.getX(0) !== x0 || position.getY(0) !== y0 || position.getZ(0) !== z0
    || position.getX(1) !== x1 || position.getY(1) !== y1 || position.getZ(1) !== z1;
  let distance = geometry.getAttribute("lineDistance") as BufferAttribute | undefined;
  if (!changed && distance?.count === 2 && distance.itemSize === 1) return;
  if (changed) {
    position.setXYZ(0, x0, y0, z0);
    position.setXYZ(1, x1, y1, z1);
    position.needsUpdate = true;
  }
  if (!distance || distance.count !== 2 || distance.itemSize !== 1) {
    distance = new BufferAttribute(new Float32Array(2), 1);
    geometry.setAttribute("lineDistance", distance);
  }
  distance.setX(0, 0);
  distance.setX(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0));
  distance.needsUpdate = true;
  geometry.computeBoundingSphere();
}
