/**
 * I 级 C1 3DGS 实景扫描接入——首刀公开面。
 * 载体合同 + fail-closed 解析(PLY / antimatter15 .splat)+ CPU 深度排序
 * + GPU 资源/混合渲染 slot 合同;真机渲染接线与 SH 视角相关着色为后续刀。
 */
export {
  SPLAT_MAX_SPLAT_COUNT,
  SPLAT_PLY_FORMAT_ID,
  SPLAT_RECORD_BYTE_STRIDE,
  SPLAT_RECORD_FLOAT_STRIDE,
  SPLAT_RECORD_OFFSET_COLOR,
  SPLAT_RECORD_OFFSET_OPACITY,
  SPLAT_RECORD_OFFSET_ROTATION,
  SPLAT_RECORD_OFFSET_SCALE,
  SPLAT_RUNTIME_FORMAT_ID,
  SPLAT_REQUIRED_PROPERTIES,
  SPLAT_SH_BAND_COUNTS,
  SPLAT_SH_C0,
  SplatParseError,
  parseSplatPlyHeader,
  splatOpacityFromLogit,
  splatPlyPayloadByteLength,
  type SplatPlyHeaderContract,
  type SplatShDegree,
} from "./splatFormatContract.js";
export { decodeSplatPly, type SplatCloud } from "./decodeSplatPly.js";
export { decodeSplatRuntimeFormat } from "./decodeSplatRuntimeFormat.js";
export {
  SPLAT_DEPTH_SORT_BUCKET_COUNT,
  computeSplatViewDepths,
  sortSplatIndicesByDepth,
} from "./sortSplatsByDepth.js";
export {
  SPLAT_ALPHA_CUTOFF,
  SPLAT_COVARIANCE_PAD_PX2,
  SPLAT_QUAD_CORNER_COUNT,
  SPLAT_UNIFORM_BYTE_LENGTH,
  SPLAT_UNIFORM_FLOAT_COUNT,
  assertSplatFrameBudget,
  createSplatGpuResources,
  createSplatQuadVertexArray,
  splatRecordBufferByteLength,
  writeSplatUniforms,
  type SplatFrameUniforms,
  type SplatGpuResources,
} from "./splatGpuResources.js";
export {
  SPLAT_RENDER_SLOT_KIND,
  SPLAT_SLOT_BLEND_CONTRACT,
  assertValidSplatSceneSlotPlan,
  buildSplatSceneSlotPlan,
  validateSplatSceneSlotCoexistence,
  type SceneSlot,
  type SceneSlotKind,
  type SplatSceneSlotPlan,
  type SplatSlotBlendContract,
} from "./splatSceneSlot.js";
export {
  DEEP_GAUSSIAN_SPLAT_ABI_VERSION,
  DEEP_GAUSSIAN_SPLAT_ENTRY_FRAGMENT,
  DEEP_GAUSSIAN_SPLAT_ENTRY_VERTEX,
  DEEP_GAUSSIAN_SPLAT_RECORD_BYTES,
  DEEP_GAUSSIAN_SPLAT_RECORD_VEC4_STRIDE,
  DEEP_GAUSSIAN_SPLAT_STORAGE_BINDING,
  DEEP_GAUSSIAN_SPLAT_UNIFORM_BINDING,
  DEEP_GAUSSIAN_SPLAT_UNIFORM_BYTES,
  GAUSSIAN_SPLAT_QUADS_WGSL,
} from "./splatQuadsWgsl.js";
