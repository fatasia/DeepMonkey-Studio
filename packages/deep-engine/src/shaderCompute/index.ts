export { DCIR_SCHEMA_VERSION } from "./types.js";
export type {
  DcirBufferElementType, DcirStorageBuffer, DcirLoopRange,
  DcirKernel, DcirKernelArtifacts, DcirKernelOutput, DcirNode, DcirUniform, DcirUniformType, DcirValueType,
} from "./types.js";
export { kernelIrSha256, kernelUsesSubgroupOps, validateKernel, KernelBuilder } from "./kernel.js";
export type { DcirIssue } from "./kernel.js";
export { emitKernelWgsl } from "./emitWgsl.js";
export type { EmittedKernelWgsl } from "./emitWgsl.js";
export { DCIR_GLSL_VERTEX, emitKernelGlsl } from "./emitGlsl.js";
export type { EmittedKernelGlsl } from "./emitGlsl.js";
export {
  HI_Z_FIRST_STAGE_NAME, buildHiZFirstStageKernel, generateHiZInput,
  hiZFirstStageTargetSize, referenceHiZFirstStage,
} from "./hiZReduce.js";
export type { HiZInputOptions } from "./hiZReduce.js";
export {
  HI_Z_FIRST_STAGE_SUBGROUP_NAME, HI_Z_SUBGROUP_WORKGROUP_SIZE, buildHiZFirstStageSubgroupKernel,
  hiZFirstStageSubgroupDispatchSize, referenceHiZFirstStageSubgroup,
} from "./hiZReduceSubgroup.js";
export {
  HI_Z_VARIABLE_REDUCE_NAME, buildHiZVariableReduceKernel, hiZChainLevelCount, hiZChainLevelSize,
  referenceHiZChain, referenceHiZVariableReduce, usesAnchoredReduce,
} from "./hiZReduceVariable.js";
export {
  PROBE_FILTER_TAP_ORDER, PROBE_IRRADIANCE_FILTER_NAME, buildProbeIrradianceFilterKernel,
  probeClipmapLayerIndex,
} from "./probeUpdateKernel.js";
export type { ProbeIrradianceFilterContract } from "./probeUpdateKernel.js";
