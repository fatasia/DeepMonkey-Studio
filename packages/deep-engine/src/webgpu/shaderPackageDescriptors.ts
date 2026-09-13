/// <reference types="@webgpu/types" />
import type {
  ResolvedShaderPackagePipeline, ShaderPackageModule, ShaderPackagePass,
} from "../shaderPackage/index.js";
import type {
  ShaderAbiBinding, ShaderAbiBindingResource, ShaderAbiColorAttachment,
  ShaderAbiVertexStream,
} from "../shaderAbi/index.js";

function visibility(stages: readonly string[]): GPUShaderStageFlags {
  return stages.reduce((flags, stage) => {
    if (stage === "vertex") return flags | GPUShaderStage.VERTEX;
    if (stage === "fragment") return flags | GPUShaderStage.FRAGMENT;
    throw new Error(`Unsupported shader stage ${stage}.`);
  }, 0);
}

function resourceDescriptor(resource: ShaderAbiBindingResource):
Pick<GPUBindGroupLayoutEntry, "buffer" | "texture" | "sampler"> {
  if (resource.kind === "uniform-buffer") {
    return { buffer: {
      type: "uniform", hasDynamicOffset: false, minBindingSize: resource.minBindingSize,
    } };
  }
  if (resource.kind === "texture") {
    return { texture: {
      sampleType: resource.sampleType,
      viewDimension: resource.viewDimension,
      multisampled: resource.multisampled,
    } };
  }
  if (resource.kind === "sampler") return { sampler: { type: resource.samplerType } };
  const exhaustive: never = resource;
  throw new Error(`Unsupported binding resource ${String(exhaustive)}.`);
}

function bindingEntry(binding: ShaderAbiBinding): GPUBindGroupLayoutEntry {
  return {
    binding: binding.binding,
    visibility: visibility(binding.visibility),
    ...resourceDescriptor(binding.resource),
  };
}

export function createShaderPackageBindGroupLayouts(
  device: GPUDevice,
  execution: ResolvedShaderPackagePipeline,
  cache: Map<string, GPUBindGroupLayout> = new Map(),
): readonly GPUBindGroupLayout[] {
  const ordered = [...execution.bindGroupLayouts].sort((a, b) => a.group - b.group);
  if (ordered.some((layout, index) => layout.group !== index)) {
    throw new Error("Shader ABI bind groups must be contiguous from group zero.");
  }
  return ordered.map((layout) => {
    const existing = cache.get(layout.id);
    if (existing) return existing;
    const created = device.createBindGroupLayout({
      label: `Deep shader package ${layout.id}`,
      entries: layout.bindings.map(bindingEntry),
    });
    cache.set(layout.id, created);
    return created;
  });
}

function vertexBuffer(stream: ShaderAbiVertexStream): GPUVertexBufferLayout {
  return {
    arrayStride: stream.arrayStride,
    stepMode: stream.stepMode,
    attributes: stream.attributes.map((attribute) => ({
      shaderLocation: attribute.shaderLocation,
      offset: attribute.byteOffset,
      format: attribute.format,
    })),
  };
}

function vertexBuffers(
  streams: readonly ShaderAbiVertexStream[],
): readonly (GPUVertexBufferLayout | null)[] {
  const highestSlot = Math.max(...streams.map((stream) => stream.slot));
  const result: Array<GPUVertexBufferLayout | null> = Array(highestSlot + 1).fill(null);
  for (const stream of streams) {
    if (result[stream.slot] !== null) throw new Error(`Duplicate vertex stream slot ${stream.slot}.`);
    result[stream.slot] = vertexBuffer(stream);
  }
  return result;
}

function colorTarget(attachment: ShaderAbiColorAttachment): GPUColorTargetState {
  return {
    format: attachment.format,
    writeMask: GPUColorWrite.ALL,
    ...(attachment.blend ? { blend: attachment.blend } : {}),
  };
}

export function shaderPackageRenderPipelineDescriptor(
  pass: ShaderPackagePass,
  module: ShaderPackageModule,
  shaderModule: GPUShaderModule,
  layout: GPUPipelineLayout,
  execution: ResolvedShaderPackagePipeline,
): GPURenderPipelineDescriptor {
  const attachment = execution.attachmentProfile;
  return {
    label: `Deep shader package ${pass.id}`,
    layout,
    vertex: {
      module: shaderModule,
      entryPoint: pass.entryPoints.vertex,
      buffers: vertexBuffers(execution.vertexStreams),
    },
    ...(pass.entryPoints.fragment === null ? {} : { fragment: {
      module: shaderModule,
      entryPoint: pass.entryPoints.fragment,
      targets: attachment.colorAttachments.map(colorTarget),
    } }),
    primitive: {
      topology: "triangle-list",
      frontFace: execution.rasterMode.frontFace,
      cullMode: execution.rasterMode.cullMode,
    },
    depthStencil: {
      format: attachment.depthAttachment.format,
      depthWriteEnabled: attachment.depthAttachment.depthWriteEnabled,
      depthCompare: attachment.depthAttachment.depthCompare,
      depthBias: attachment.depthAttachment.depthBias,
      depthBiasSlopeScale: attachment.depthAttachment.depthBiasSlopeScale,
    },
    multisample: { count: attachment.sampleCount },
  };
}
