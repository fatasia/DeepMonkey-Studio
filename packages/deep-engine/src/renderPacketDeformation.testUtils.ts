import type { RenderPacket } from "./renderPacket.js";
import type { DeformationSnapshot } from "./deformation/types.js";
export function deformationPacket(kind: "morph" | "skin" | "morph-skin" = "morph-skin"): RenderPacket & { deformation: DeformationSnapshot } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const tangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    geometries: [{ id: "geometry", revision: 1, vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      tangents, indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 0.5 }],
    instances: [{ id: "instance", geometry: "geometry", material: "material", pose: "pose", transform: identity }],
    deformation: { sources: [{ id: "source", revision: 1, geometry: "geometry", kind, semantics: "three-r185",
      ...(kind === "skin" ? {} : { morph: { revision: 1, positions, normals, tangents,
        primitive: { id: "primitive", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 3,
          targets: [{ index: 0, name: "target", positionDeltas: new Float32Array([0.25, 0, 0, 0.25, 0, 0, 0.25, 0, 0]) }] } } }),
      ...(kind === "morph" ? {} : { skinning: { revision: 1, positions: positions.slice(), normals: normals.slice(),
        joints: new Uint16Array(12), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), weightMode: "preserve" as const } }),
    }], poses: [{ id: "pose", source: "source", revision: 1,
      ...(kind === "skin" ? {} : { morphWeights: { revision: 1, values: new Float32Array([0.5]) } }),
      ...(kind === "morph" ? {} : { palette: { revision: 1, matrices: new Float32Array(identity) } }),
    }] },
  };
}
