import { canonicalShaderAbiJson } from "./canonical.js";
import { DEEP_PBR_MESH_V3 } from "./contractV3.js";
import type { DeepPbrMeshShaderAbiV4, ShaderAbiVertexStream } from "./types.js";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  }
  return value;
}

/** DE26/C02 冻结的可选顶点色流：线性 RGBA f32，三维颜色源 alpha 固定 1。
 * v1/v2/v3 逐字节冻结；v4 只新增流定义，passVariants/materialModes 不变——
 * 颜色变体的管线接入由后续切片以独立修订声明。 */
export const DEEP_PBR_MESH_V4_COLOR_VERTEX = Object.freeze({
  stream: "color", semantic: "COLOR_RGBA_F32_LINEAR", shaderLocation: 16,
  format: "float32x4", byteOffset: 0, arrayStride: 16,
} as const);
export const DEEP_PBR_MESH_V4_BYTE_SIZES = Object.freeze({ colorVertex: 16 } as const);

const colorStream: ShaderAbiVertexStream = {
  id: "color", slot: 3, arrayStride: DEEP_PBR_MESH_V4_BYTE_SIZES.colorVertex, stepMode: "vertex",
  attributes: [{ semantic: DEEP_PBR_MESH_V4_COLOR_VERTEX.semantic, shaderLocation: DEEP_PBR_MESH_V4_COLOR_VERTEX.shaderLocation,
    format: DEEP_PBR_MESH_V4_COLOR_VERTEX.format, byteOffset: DEEP_PBR_MESH_V4_COLOR_VERTEX.byteOffset }],
};

export const DEEP_PBR_MESH_V4: DeepPbrMeshShaderAbiV4 = freeze({
  ...DEEP_PBR_MESH_V3,
  id: "deep.pbr.mesh.v4",
  vertexStreams: [...DEEP_PBR_MESH_V3.vertexStreams, colorStream],
});

export const DEEP_PBR_MESH_V4_CANONICAL_JSON = canonicalShaderAbiJson(DEEP_PBR_MESH_V4);
/** SHA-256 golden of DEEP_PBR_MESH_V4_CANONICAL_JSON. */
export const DEEP_PBR_MESH_V4_SHA256 = "fae12ec43ec6a135eddf7109f5ba621fb0410242cbc77c3e712a4633da2c047f";
