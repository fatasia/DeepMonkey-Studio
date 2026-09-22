import type { IndustrialPrefabInstanceState } from "@bim-studio/contracts";
import * as THREE from "three";
import { buildParametricFence, fenceShape, type FenceMaterials } from "./parametricFenceGeometry";
import { buildStraightRoad, straightRoadShape, type RoadMaterials } from "./parametricRoadGeometry";
import { linearPrefabSegments, stablePathGateIndex } from "./linearPrefabPath";
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
  instanceRepeatedPathMeshes(result);
  return result;
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
