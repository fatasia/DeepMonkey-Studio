/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import type { DcirKernel } from "../shaderCompute/index.js";
import { buildHiZFirstStageKernel, buildHiZVariableReduceKernel, emitKernelWgsl, HI_Z_FIRST_STAGE_NAME,
  HI_Z_VARIABLE_REDUCE_NAME } from "../shaderCompute/index.js";
import type { HiZResolvedReduction } from "./hiZPyramid.js";

/** R2 合同:kernel 名 + IR 哈希 + 后端标签随 dispatch 进入 performanceTelemetry(R4 接线)。 */
export interface HiZKernelDescriptor {
  readonly name: string;
  readonly reduceMax: boolean;
  readonly irSha256: string;
  readonly entryPoint: string;
  readonly backend: "wgsl";
}

interface ReduceVariant {
  readonly module: GPUShaderModule;
  readonly irSha256: string;
  readonly entryPoint: string;
  readonly name: string;
  readonly family: "anchored" | "variable";
  readonly mode: "min" | "max";
}

export interface HiZReduceKernelRig {
  /** 全部 reduce 管线共享的显式 bind group layout(每级 binding:源纹理/目标存储/尺寸 uniform)。 */
  readonly layout: GPUBindGroupLayout;
  readonly anchored: Readonly<Record<HiZResolvedReduction, GPUComputePipeline>>;
  readonly variable: Readonly<Record<HiZResolvedReduction, GPUComputePipeline>>;
  readonly descriptors: readonly HiZKernelDescriptor[];
}

/**
 * HiZ reduce 的 DCIR 内核装配(R2 单源 → WGSL;hiZPyramid.ts 只保留资源编排)。
 * 双内核分工:偶×偶源走 2×2 锚定块快路径(hi_z_first_stage,R2 已认证),其余源走变窗内核
 * (hi_z_variable_reduce,9-tap masked 定序展开逐位复现原手写变窗公式)。
 * min/max 在 IR 层特化(ANGLE uniform quirk,见 shaderCompute/hiZReduce.ts),共 4 条管线。
 */
export function createHiZReduceKernels(session: DeviceSession): HiZReduceKernelRig {
  const device = session.device;
  const anchored = {
    min: createVariant(device, "anchored", "min", "Deep Hi-Z anchored min WGSL (DCIR)", buildHiZFirstStageKernel(false)),
    max: createVariant(device, "anchored", "max", "Deep Hi-Z anchored max WGSL (DCIR)", buildHiZFirstStageKernel(true)),
  };
  const variable = {
    min: createVariant(device, "variable", "min", "Deep Hi-Z variable min WGSL (DCIR)", buildHiZVariableReduceKernel(false)),
    max: createVariant(device, "variable", "max", "Deep Hi-Z variable max WGSL (DCIR)", buildHiZVariableReduceKernel(true)),
  };
  const layout = device.createBindGroupLayout({ label: "Deep Hi-Z reduction layout", entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float", viewDimension: "2d" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
  ] });
  const pipelineLayout = device.createPipelineLayout({ label: "Deep Hi-Z reduction pipeline layout", bindGroupLayouts: [layout] });
  const pipeline = (variant: ReduceVariant): GPUComputePipeline => device.createComputePipeline({
    label: `Deep Hi-Z ${variant.family} ${variant.mode} pipeline`,
    layout: pipelineLayout, compute: { module: variant.module, entryPoint: variant.entryPoint } });
  return {
    layout,
    anchored: { min: pipeline(anchored.min), max: pipeline(anchored.max) },
    variable: { min: pipeline(variable.min), max: pipeline(variable.max) },
    descriptors: Object.freeze([
      descriptor(anchored.min, false), descriptor(anchored.max, true),
      descriptor(variable.min, false), descriptor(variable.max, true),
    ]),
  };
}

function createVariant(device: GPUDevice, family: "anchored" | "variable", mode: "min" | "max", label: string,
  kernel: DcirKernel): ReduceVariant {
  const emitted = emitKernelWgsl(kernel);
  return { module: device.createShaderModule({ label, code: emitted.code }),
    irSha256: emitted.irSha256, entryPoint: kernel.name, name: kernel.name, family, mode };
}

function descriptor(variant: ReduceVariant, reduceMax: boolean): HiZKernelDescriptor {
  return Object.freeze({ name: variant.name, reduceMax, irSha256: variant.irSha256,
    entryPoint: variant.entryPoint, backend: "wgsl" });
}

export const HI_Z_ANCHORED_ENTRY = HI_Z_FIRST_STAGE_NAME;
export const HI_Z_VARIABLE_ENTRY = HI_Z_VARIABLE_REDUCE_NAME;
