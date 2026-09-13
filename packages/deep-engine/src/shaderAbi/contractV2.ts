import { canonicalShaderAbiJson } from "./canonical.js";
import { DEEP_PBR_MESH_V1, DEEP_PBR_MESH_V1_BYTE_SIZES } from "./contract.js";
import type { DeepPbrMeshShaderAbiV2 } from "./types.js";

export const DEEP_PBR_MESH_V2_BYTE_SIZES = Object.freeze({ ...DEEP_PBR_MESH_V1_BYTE_SIZES, cascadedShadow: 336 } as const);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** CSM extension; v1 stays immutable. The 336-byte block matches native CascadedShadowUniform. */
export const DEEP_PBR_MESH_V2: DeepPbrMeshShaderAbiV2 = freeze({
  ...DEEP_PBR_MESH_V1, id: "deep.pbr.mesh.v2",
  dataLayouts: [...DEEP_PBR_MESH_V1.dataLayouts, {
    id: "cascaded-shadow", storage: "uniform", byteSize: 336, byteAlignment: 16,
    members: [
      ...[0, 1, 2, 3].map(index => ({ name: `matrix${index}`, format: "mat4x4<f32>" as const, byteOffset: index * 64, byteSize: 64 })),
      ...["split_depths", "blend_starts", "texel_world", "params", "camera_forward"].map((name, index) => ({
        name, format: "vec4<f32>" as const, byteOffset: 256 + index * 16, byteSize: 16,
      })),
    ],
  }],
  bindGroupLayouts: DEEP_PBR_MESH_V1.bindGroupLayouts.map(layout => layout.id !== "forward-frame" ? layout : ({
    ...layout,
    bindings: [...layout.bindings.map(binding => binding.binding !== 1 ? binding : ({ ...binding,
      resource: { kind: "texture" as const, sampleType: "depth" as const, viewDimension: "2d-array" as const, multisampled: false as const },
    })), {
      name: "cascadedShadow", binding: 7, visibility: ["fragment" as const],
      resource: { kind: "uniform-buffer" as const, dataLayout: "cascaded-shadow" as const, minBindingSize: 336 },
    }],
  })),
});

export const DEEP_PBR_MESH_V2_CANONICAL_JSON = canonicalShaderAbiJson(DEEP_PBR_MESH_V2);
export const DEEP_PBR_MESH_V2_SHA256 = "adcdc15ed7ff02966d4033b746da1af90c97a0fb657615fec3bcef375c015cf1";
