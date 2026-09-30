import { hdrDisplayOutputShader } from "./pbrHdrDisplayWgsl.js";
import { createPbrOutputShaderProvenance, type PbrOutputShaderProvenance } from "./pbrOutputShaderProvenance.js";

/// <reference types="@webgpu/types" />
/**
 * I-C21 HDR 显示输出 present 管线工厂(失败即抛,由调用方 fail-closed 成
 * "hdr-pipeline-failed" 回 SDR;本模块不做静默回退)。
 *
 * == 与 SDR output 管线的关系 ==
 * - bind group 1 直接复用 `pipelines.output.getBindGroupLayout(1)`(作者效果链同一
 *   布局对象,PbrAuthorColorBindings 的既有 bind group 零改动可用);
 * - bind group 0 为显式 4 槽布局(源纹理 + 采样器 + DeepOutputSettings 32B + 追加的
 *   DeepHdrOutputSettings 16B),与 outputShader 的 group 0 同形 + binding 3;
 * - 编译期校验:getCompilationInfo 错误以行号聚合抛出(同 pbrOutputPipelineCache 先例)。
 */

/** HDR 变体 group 0 显式布局描述(binding 2=32B 设置,binding 3=16B HDR 设置)。
 * 以函数取用而非模块级常量:GPU 全局字面量在 node/vitest 导入闭包中不存在,
 * 求值必须发生在真实 GPU 上下文调用期。 */
export function hdrDisplayBindGroupLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: 8 * 4 } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: 4 * 4 } },
  ];
}

/** 作者效果链 group 1 显式布局(真机探针无 Pipelines 时的独立取用入口;48B=3×vec4f)。 */
export function createHdrDisplayAuthorLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({ label: "Deep HDR display author", entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 12 * 4 } },
  ] });
}

export interface HdrDisplayPipeline {
  readonly provenance: PbrOutputShaderProvenance;
  readonly pipeline: GPURenderPipeline;
  /** HDR 变体 group 0 布局(bind group 0 必须以此创建)。 */
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** DeepHdrOutputSettings uniform(16B,COPY_DST;调用方按策略写入)。 */
  readonly hdrSettingsBuffer: GPUBuffer;
}

/** 创建并校验 HDR present 管线;WGSL 编译错误/管线创建失败直接抛出(显式原因)。 */
export async function createHdrDisplayPipeline(device: GPUDevice, targetFormat: GPUTextureFormat,
  authorBindGroupLayout: GPUBindGroupLayout): Promise<HdrDisplayPipeline> {
  const module = device.createShaderModule({ label: "Deep HDR display output", code: hdrDisplayOutputShader });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(message => message.type === "error");
  if (errors.length > 0) {
    throw new Error(`HDR display WGSL failed to compile: ${errors.map(message =>
      `L${message.lineNum}: ${message.message}`).join("; ")}`);
  }
  const bindGroupLayout = device.createBindGroupLayout({
    label: "Deep HDR display bindings", entries: hdrDisplayBindGroupLayoutEntries(),
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: "Deep HDR display", layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout, authorBindGroupLayout] }),
    vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMain", targets: [{ format: targetFormat }] },
    primitive: { topology: "triangle-list" },
  });
  const hdrSettingsBuffer = device.createBuffer({ label: "Deep HDR display settings",
    size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  return { pipeline, bindGroupLayout, hdrSettingsBuffer, provenance: createPbrOutputShaderProvenance(pipeline, hdrDisplayOutputShader) };
}
