import type { RoadMarking, RoadSurface, StraightRoadPrefabParameters } from "@bim-studio/contracts";
import * as THREE from "three";

export interface RoadMaterials {
  surface: THREE.Material;
  shoulder: THREE.Material;
  marking: THREE.Material;
}

/** 外部快照也必须被压入有界、有限且可渲染的直路参数。 */
export function straightRoadShape(parameters: Record<string, unknown> = {}): StraightRoadPrefabParameters {
  const finite = (key: string, fallback: number, min: number, max: number) => {
    const value = parameters[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const surface: RoadSurface = parameters.surface === "concrete" ? "concrete" : "asphalt";
  const marking: RoadMarking = parameters.marking === "none" || parameters.marking === "lanes" ? parameters.marking : "center";
  return {
    lengthM: finite("lengthM", 20, 2, 500),
    carriagewayWidthM: finite("carriagewayWidthM", 7, 2.5, 30),
    laneCount: Math.round(finite("laneCount", 2, 1, 12)),
    shoulderWidthM: finite("shoulderWidthM", 0.75, 0, 5),
    surface,
    marking,
  };
}

/** 长度沿本地 X 轴，宽度沿 Z 轴，路面底面落在 y=0。 */
export function buildStraightRoad(shape: StraightRoadPrefabParameters, materials: RoadMaterials): THREE.Group {
  const group = new THREE.Group();
  const { lengthM, carriagewayWidthM, shoulderWidthM, laneCount, marking } = shape;
  addSlab(group, "车行道路面", materials.surface, lengthM, carriagewayWidthM, 0.08, 0.04, 0);
  if (shoulderWidthM > 0) {
    const offset = carriagewayWidthM / 2 + shoulderWidthM / 2;
    addSlab(group, "左路肩", materials.shoulder, lengthM, shoulderWidthM, 0.06, 0.03, -offset);
    addSlab(group, "右路肩", materials.shoulder, lengthM, shoulderWidthM, 0.06, 0.03, offset);
  }
  if (marking !== "none") {
    const dividerCount = marking === "center" ? 1 : laneCount - 1;
    const positions = Array.from({ length: dividerCount }, (_, index) => marking === "center"
      ? 0
      : -carriagewayWidthM / 2 + carriagewayWidthM * (index + 1) / laneCount);
    addDashedLines(group, materials.marking, lengthM, positions);
  }
  return group;
}

function addSlab(group: THREE.Group, name: string, material: THREE.Material, length: number, width: number, height: number, y: number, z: number): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), material);
  mesh.name = name;
  mesh.position.set(0, y, z);
  mesh.receiveShadow = true;
  group.add(mesh);
}

function addDashedLines(group: THREE.Group, material: THREE.Material, length: number, zPositions: number[]): void {
  const dashLength = 2.5;
  const gapLength = 2;
  const count = Math.min(112, Math.max(1, Math.ceil(length / (dashLength + gapLength))));
  const actualDashLength = Math.min(dashLength, length / count * 0.65);
  const markings = new THREE.InstancedMesh(new THREE.BoxGeometry(actualDashLength, 0.012, 0.12), material, count * zPositions.length);
  markings.name = "道路标线";
  markings.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  let instance = 0;
  for (const z of zPositions) {
    for (let index = 0; index < count; index++) {
      const x = -length / 2 + (index + 0.5) * length / count;
      markings.setMatrixAt(instance++, matrix.makeTranslation(x, 0.087, z));
    }
  }
  markings.instanceMatrix.needsUpdate = true;
  group.add(markings);
}
