import type { IndustrialPrefabInstanceState } from "@bim-studio/contracts";
import * as THREE from "three";
import { buildParametricFence, fenceShape, type FenceMaterials } from "./parametricFenceGeometry";
import { buildStraightRoad, ROAD_CARRIAGEWAY_TOP_M, ROAD_JUNCTION_PLATE_LIFT_M, straightRoadShape, type RoadMaterials } from "./parametricRoadGeometry";
import { linearPrefabSegments, stablePathGateIndex } from "./linearPrefabPath";
import { roadJunctionPlates } from "./roadPrefabJunction";
import { instanceRepeatedPathMeshes } from "./linearPrefabInstancing";

/** Builds one continuous local-space author object while reusing the existing single-span generators. */
export function buildLinearPrefabGeometry(state: IndustrialPrefabInstanceState,
  materials: FenceMaterials | RoadMaterials): THREE.Group | undefined {
  const path = state.placementPath;
  if (!path || (state.kind !== "fence" && state.kind !== "road")) return undefined;
  const segments = linearPrefabSegments(path);
  if (!segments.length) return new THREE.Group();
  const result = new THREE.Group();
  result.name = state.kind === "road" ? "连续道路" : "连续围栏";
  const gateIndex = stablePathGateIndex(path, segments.length);
  for (const segment of segments) {
    const child = state.kind === "road"
      ? buildStraightRoad({ ...straightRoadShape(state.parameters), lengthM: segment.lengthM }, materials as RoadMaterials)
      : fenceSegment(state, segment.lengthM, segment.index === gateIndex, materials as FenceMaterials);
    child.position.set(segment.midpoint.x, segment.midpoint.y, segment.midpoint.z);
    child.rotation.y = -segment.yawRadians;
    child.userData.pathSegmentIndex = segment.index;
    child.userData.pathSeed = path.seed;
    result.add(child);
  }
  if (state.kind === "road") addRoadJunctionPlates(result, state, materials as RoadMaterials, path.seed);
  instanceRepeatedPathMeshes(result);
  return result;
}

/**
 * I3 道路 junction：在每个被标记的路径点放置等宽方形路面盖板，盖住主路与支路的端头错缝。
 * 与分段路面共用表面材质（同材质）与路面顶基准，另加确定性微抬高避免与下方路面板共面闪烁；
 * 盖板数量通常少于实例化批次的下限，保持独立网格即可，发布下译按普通网格出实例。
 */
function addRoadJunctionPlates(result: THREE.Group, state: IndustrialPrefabInstanceState,
  materials: RoadMaterials, seed: number): void {
  for (const plate of roadJunctionPlates(state)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(plate.widthM, ROAD_CARRIAGEWAY_TOP_M, plate.widthM), materials.surface);
    mesh.name = "路口盖板";
    mesh.position.set(plate.center.x, plate.center.y + ROAD_CARRIAGEWAY_TOP_M / 2 + ROAD_JUNCTION_PLATE_LIFT_M, plate.center.z);
    mesh.receiveShadow = true;
    mesh.userData.pathSeed = seed;
    mesh.userData.junctionPointId = plate.pointId;
    result.add(mesh);
  }
}

function fenceSegment(state: IndustrialPrefabInstanceState, lengthM: number, gateSegment: boolean,
  materials: FenceMaterials): THREE.Group {
  const source = fenceShape(state.parameters);
  const gateWidthM = gateSegment && source.gateWidthM < lengthM - 0.2 ? source.gateWidthM : 0;
  const postSpacingM = Math.max(0.2, (lengthM - gateWidthM) / 2);
  const fence = buildParametricFence({ ...source, gateWidthM, postSpacingM }, materials);
  const generatedLength = postSpacingM * 2 + gateWidthM;
  if (generatedLength > 1e-6) fence.scale.x = lengthM / generatedLength;
  return fence;
}
