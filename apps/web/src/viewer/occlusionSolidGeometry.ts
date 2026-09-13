import * as THREE from "three";

const cache = new WeakMap<THREE.BufferGeometry, { position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; positionVersion: number; index: THREE.BufferAttribute | null; indexVersion: number; box?: THREE.Box3 }>();

/** 识别封闭六面长方体；不能用任意模型的外包围盒冒充实体墙，以免封住门窗。 */
export function solidBoxGeometry(geometry: THREE.BufferGeometry): THREE.Box3 | undefined {
  const position = geometry.getAttribute("position");
  if (!position || Object.keys(geometry.morphAttributes).length) return undefined;
  const count = geometry.index?.count ?? position.count;
  if (count !== 36 || geometry.drawRange.start !== 0 || geometry.drawRange.count < count) return undefined;
  const version = "version" in position ? position.version : position.data.version;
  const previous = cache.get(geometry);
  if (previous?.position === position && previous.positionVersion === version && previous.index === geometry.index && previous.indexVersion === (geometry.index?.version ?? 0)) return previous.box;
  const box = inspectBox(geometry, position);
  cache.set(geometry, { position, positionVersion: version, index: geometry.index, indexVersion: geometry.index?.version ?? 0, ...(box ? { box } : {}) });
  return box;
}

function inspectBox(geometry: THREE.BufferGeometry, position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.Box3 | undefined {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let index = 0; index < position.count; index++) box.expandByPoint(point.fromBufferAttribute(position, index));
  const size = box.getSize(new THREE.Vector3());
  if (Math.min(size.x, size.y, size.z) <= 1e-8) return undefined;
  const epsilon = Math.max(size.x, size.y, size.z) * 1e-6;
  const corners: number[] = [];
  for (let index = 0; index < position.count; index++) {
    let corner = 0;
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = position.getComponent(index, axis);
      if (Math.abs(coordinate - box.max.getComponent(axis)) <= epsilon) corner |= 1 << axis;
      else if (Math.abs(coordinate - box.min.getComponent(axis)) > epsilon) return undefined;
    }
    corners.push(corner);
  }
  const faces = new Map<string, number[][]>();
  let winding: number | undefined;
  for (let index = 0; index < 36; index += 3) {
    const triangle = [0, 1, 2].map(offset => corners[geometry.index?.getX(index + offset) ?? index + offset]!);
    if (new Set(triangle).size !== 3) return undefined;
    const axis = [0, 1, 2].find(value => triangle.every(corner => (corner & (1 << value)) === (triangle[0]! & (1 << value))));
    if (axis === undefined) return undefined;
    const a = new THREE.Vector3(triangle[0]! & 1, (triangle[0]! >> 1) & 1, (triangle[0]! >> 2) & 1);
    const b = new THREE.Vector3(triangle[1]! & 1, (triangle[1]! >> 1) & 1, (triangle[1]! >> 2) & 1).sub(a);
    const c = new THREE.Vector3(triangle[2]! & 1, (triangle[2]! >> 1) & 1, (triangle[2]! >> 2) & 1).sub(a);
    const orientation = Math.sign(b.cross(c).getComponent(axis)) * ((triangle[0]! & (1 << axis)) ? 1 : -1);
    // FrontSide/BackSide 依赖绕序；局部反面可能在实际渲染中留下穿透孔。
    if (!orientation || (winding !== undefined && winding !== orientation)) return undefined;
    winding = orientation;
    const face = `${axis}:${triangle[0]! & (1 << axis)}`;
    const items = faces.get(face) ?? []; items.push(triangle); faces.set(face, items);
  }
  if (faces.size !== 6) return undefined;
  for (const triangles of faces.values()) {
    if (triangles.length !== 2 || new Set(triangles.flat()).size !== 4) return undefined;
    const common = triangles[0]!.filter(corner => triangles[1]!.includes(corner));
    if (common.length !== 2 || [1, 2, 4].includes(common[0]! ^ common[1]!)) return undefined;
  }
  return box;
}

export function occlusionCompleteBoxDraw(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): boolean {
  // 即使只有一个材质，带 groups 的几何体也会按组绘制；缺组的盒体不能充当遮挡体。
  if (!geometry.groups.length) return !Array.isArray(material);
  const coverage = new Uint8Array(36);
  for (const group of geometry.groups) {
    if (!Number.isInteger(group.start) || !Number.isInteger(group.count) || group.start < 0 || group.count <= 0
      || group.start % 3 || group.count % 3 || group.start + group.count > 36
      || (Array.isArray(material) && !material[group.materialIndex ?? 0])) return false;
    for (let i = group.start; i < group.start + group.count; i++) { if (coverage[i]) return false; coverage[i] = 1; }
  }
  return coverage.every(value => value === 1);
}

export function occlusionOpaqueMaterial(material: THREE.Material | THREE.Material[]): boolean {
  return (Array.isArray(material) ? material : [material]).every(item => {
    const surface = item as THREE.MeshPhysicalMaterial;
    return (surface.isMeshStandardMaterial || (item as THREE.MeshBasicMaterial).isMeshBasicMaterial)
      && item.visible && !item.transparent && item.opacity === 1 && item.depthWrite && item.depthTest
      && item.depthFunc === THREE.LessEqualDepth && item.blending === THREE.NormalBlending && !item.polygonOffset
      && item.alphaTest === 0 && !item.alphaToCoverage && !item.alphaHash && !item.clippingPlanes?.length
      && !surface.displacementMap && !(surface.transmission > 0)
      && item.onBeforeCompile === THREE.Material.prototype.onBeforeCompile
      && item.onBeforeRender === THREE.Material.prototype.onBeforeRender;
  });
}
