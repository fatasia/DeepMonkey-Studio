import { deformationPacket } from "../src/renderPacketDeformation.testUtils.js";
import type { DeformationPose } from "../src/deformation/types.js";
import type { RenderPacket } from "../src/renderPacket.js";
import type { RenderView } from "../src/webgpu/pbrRenderer.js";

export type IntegrationKind = "skin" | "morph" | "morph-skin";
export const INTEGRATION_SIZE = 128;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function integrationFixture(kind: IntegrationKind) {
  const original = deformationPacket(kind), source = original.deformation.sources[0]!;
  const positions = [-0.65, -0.25, 0, -0.25, -0.25, 0, -0.45, 0.25, 0];
  source.morph?.positions.set(positions); source.skinning?.positions.set(positions);
  const geometry = original.geometries[0]!;
  for (let vertex = 0; vertex < 3; vertex++) geometry.vertices.set(positions.slice(vertex * 3, vertex * 3 + 3), vertex * 6);
  const pose = (id: string, revision: number, moved: boolean): DeformationPose => {
    const amount = moved ? 0.7 : 0;
    const matrices = new Float32Array(identity); matrices[12] = kind === "morph-skin" ? amount / 2 : amount;
    return { id, source: source.id, revision,
      ...(kind !== "skin" ? { morphWeights: { revision, values: new Float32Array([amount / (kind === "morph-skin" ? 0.5 : 0.25)]) } } : {}),
      ...(kind !== "morph" ? { palette: { revision, matrices } } : {}) };
  };
  const still = pose("still", 1, false);
  const translated = (y: number) => { const matrix = [...identity]; matrix[13] = y; return matrix; };
  const packet: RenderPacket = { geometries: original.geometries,
    materials: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((color, index) => ({
      id: `material-${index}`, baseColor: color as [number, number, number], shadingModel: "unlit", metallic: 0, roughness: 1, doubleSided: true })),
    instances: [...Array.from({ length: 64 }, (_, index) => ({ id: `moving-${index}`, geometry: geometry.id,
      material: "material-0", pose: "moving", transform: identity })),
      { id: "still", geometry: geometry.id, material: "material-1", pose: "still", transform: translated(0.65) },
      { id: "static", geometry: geometry.id, material: "material-2", transform: translated(-0.65) }],
    deformation: { sources: [source], poses: [pose("moving", 1, false), still] } };
  return { packet, moved: { materials: packet.materials, instances: packet.instances, poses: [pose("moving", 2, true), still] } };
}

export const integrationView: RenderView = {
  width: INTEGRATION_SIZE, height: INTEGRATION_SIZE, pixelRatio: 1,
  eye: [0, 0, 3], target: [0, 0, 0], up: [0, 1, 0], extent: 2,
  verticalFovRadians: 1, near: 0.1, far: 10, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 1,
  lights: { directional: [{ directionWorld: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: true,
    shadow: { viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.25, 0, 0, 0, 0.5, 1],
      mapSize: INTEGRATION_SIZE, bias: 0, normalBias: 0, intensity: 1, radius: 0 } }] },
};
