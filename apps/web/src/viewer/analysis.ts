import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

export interface ComponentRecord {
  id: string;
  stableId: string;
  modelId: string;
  modelName: string;
  name: string;
  type: string;
  path: string;
  level?: string;
  category?: string;
  specialty?: string;
  properties: Record<string, string>;
  searchText: string;
}

export interface ComponentFilter {
  query?: string;
  level?: string;
  category?: string;
  specialty?: string;
}

export interface ComponentFacets {
  levels: string[];
  categories: string[];
  specialties: string[];
}

export interface CollisionRecord {
  id: string;
  sourceModelId: string;
  sourceNodeId: string;
  sourceName: string;
  targetModelId: string;
  targetNodeId: string;
  targetName: string;
  point: { x: number; y: number; z: number };
}

export interface PreciseIntersection {
  nodeIdA: string;
  nodeIdB: string;
  point: THREE.Vector3;
}

export interface ClosestPointsResult {
  pointA: THREE.Vector3;
  pointB: THREE.Vector3;
  distance: number;
}

const bvhCache = new WeakMap<THREE.BufferGeometry, MeshBVH>();

export function buildComponentRecords(
  modelId: string,
  modelName: string,
  objects: Map<string, THREE.Object3D>
): ComponentRecord[] {
  return [...objects.entries()].map(([nodeId, object]) => {
    const properties: Record<string, string> = {};
    flattenObjectData(object.userData, properties);
    const name = object.name || properties.name || properties.Name || object.type;
    const sourceId = semanticValue(properties, ["globalid", "ifcguid", "guid", "expressid", "elementid", "objectid", "id"]);
    const level = semanticValue(properties, ["levelname", "level", "storey", "floor", "楼层", "标高"]);
    const category = semanticValue(properties, ["categoryname", "category", "familytype", "family", "类别", "族类型", "族"]);
    const specialty = semanticValue(properties, ["specialty", "discipline", "trade", "专业"]);
    const path = objectPath(object);
    const stableId = `${modelId}:${sourceId || nodeId}`;
    const searchText = [stableId, modelName, name, object.type, path, level, category, specialty, ...Object.entries(properties).flat()]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-CN");
    return {
      id: nodeId,
      stableId,
      modelId,
      modelName,
      name,
      type: object.type,
      path,
      ...(level ? { level } : {}),
      ...(category ? { category } : {}),
      ...(specialty ? { specialty } : {}),
      properties,
      searchText
    };
  });
}

export function filterComponents(records: ComponentRecord[], filter: ComponentFilter, limit = 100): ComponentRecord[] {
  const query = filter.query?.trim().toLocaleLowerCase("zh-CN");
  const result: ComponentRecord[] = [];
  for (const record of records) {
    if (query && !record.searchText.includes(query)) continue;
    if (filter.level && record.level !== filter.level) continue;
    if (filter.category && record.category !== filter.category) continue;
    if (filter.specialty && record.specialty !== filter.specialty) continue;
    result.push(record);
    if (result.length >= limit) break;
  }
  return result;
}

export function componentFacets(records: ComponentRecord[]): ComponentFacets {
  return {
    levels: uniqueSorted(records.map((item) => item.level)),
    categories: uniqueSorted(records.map((item) => item.category)),
    specialties: uniqueSorted(records.map((item) => item.specialty))
  };
}

export function preciseIntersection(rootA: THREE.Object3D, rootB: THREE.Object3D): PreciseIntersection | undefined {
  rootA.updateWorldMatrix(true, true);
  rootB.updateWorldMatrix(true, true);
  const meshesA = visibleMeshes(rootA);
  const meshesB = visibleMeshes(rootB);
  const inverseA = new THREE.Matrix4();
  const geometryToA = new THREE.Matrix4();
  for (const meshA of meshesA) {
    const boxA = worldGeometryBox(meshA);
    if (!boxA) continue;
    for (const meshB of meshesB) {
      const boxB = worldGeometryBox(meshB);
      if (!boxB || !boxA.intersectsBox(boxB)) continue;
      inverseA.copy(meshA.matrixWorld).invert();
      geometryToA.multiplyMatrices(inverseA, meshB.matrixWorld);
      if (!geometryBvh(meshA.geometry).intersectsGeometry(meshB.geometry, geometryToA)) continue;
      const overlap = boxA.clone().intersect(boxB);
      return {
        nodeIdA: String(meshA.userData.layerNodeId ?? "root"),
        nodeIdB: String(meshB.userData.layerNodeId ?? "root"),
        point: overlap.isEmpty()
          ? boxA.getCenter(new THREE.Vector3()).lerp(boxB.getCenter(new THREE.Vector3()), 0.5)
          : overlap.getCenter(new THREE.Vector3())
      };
    }
  }
  return undefined;
}

export function closestPointsBetweenObjects(rootA: THREE.Object3D, rootB: THREE.Object3D): ClosestPointsResult | undefined {
  rootA.updateWorldMatrix(true, true);
  rootB.updateWorldMatrix(true, true);
  const meshesA = visibleMeshes(rootA);
  const meshesB = visibleMeshes(rootB);
  const inverseA = new THREE.Matrix4();
  const geometryToA = new THREE.Matrix4();
  let closest: ClosestPointsResult | undefined;
  for (const meshA of meshesA) {
    inverseA.copy(meshA.matrixWorld).invert();
    for (const meshB of meshesB) {
      geometryToA.multiplyMatrices(inverseA, meshB.matrixWorld);
      const targetA = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 };
      const targetB = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 };
      const result = geometryBvh(meshA.geometry).closestPointToGeometry(
        meshB.geometry,
        geometryToA,
        targetA,
        targetB,
        0,
        closest?.distance ?? Infinity
      );
      if (!result || (closest && result.distance >= closest.distance)) continue;
      closest = {
        pointA: meshA.localToWorld(targetA.point.clone()),
        pointB: meshB.localToWorld(targetB.point.clone()),
        distance: result.distance
      };
      if (result.distance <= 1e-7) return closest;
    }
  }
  return closest;
}

function geometryBvh(geometry: THREE.BufferGeometry): MeshBVH {
  let bvh = bvhCache.get(geometry);
  if (!bvh) {
    bvh = new MeshBVH(geometry, { indirect: true, maxLeafSize: 20, verbose: false });
    bvhCache.set(geometry, bvh);
  }
  return bvh;
}

function visibleMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position && effectivelyVisible(mesh, root)) meshes.push(mesh);
  });
  return meshes;
}

function effectivelyVisible(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible || current.userData.layerDeleted) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function worldGeometryBox(mesh: THREE.Mesh): THREE.Box3 | undefined {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox?.clone().applyMatrix4(mesh.matrixWorld);
}

function objectPath(object: THREE.Object3D): string {
  const names: string[] = [];
  let current: THREE.Object3D | null = object;
  while (current && current.userData.modelId === object.userData.modelId) {
    names.unshift(current.name || current.type);
    current = current.parent;
  }
  return names.join(" / ");
}

function flattenObjectData(value: unknown, output: Record<string, string>, prefix = ""): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (child === null || child === undefined) continue;
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      output[label] = String(child);
    } else if (Array.isArray(child)) {
      output[label] = child.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ");
    } else if (prefix.split(".").length < 2) {
      flattenObjectData(child, output, label);
    }
  }
}

function semanticValue(properties: Record<string, string>, candidates: string[]): string | undefined {
  for (const [key, value] of Object.entries(properties)) {
    const normalized = key.replaceAll(/[^a-zA-Z\u4e00-\u9fff]/g, "").toLocaleLowerCase("zh-CN");
    if (candidates.includes(normalized) && value.trim()) return value.trim();
  }
  return undefined;
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
