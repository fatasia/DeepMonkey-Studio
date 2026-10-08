import { createAdmittedTexture, createAdmittedBuffer } from "./resourceAdmission.js";
import type { DeviceSession } from "./deviceSession.js";
import { environmentShader } from "./environmentShader.js";
import { abortableGpu, gpuAbortReason } from "./gpuAbort.js";
import { environmentMipSelection, type EnvironmentMipSelection } from "./environmentMipSelection.js";

export interface StudioEnvironment {
  readonly specular: GPUTextureView;
  /** Borrowed storage for exact cube-array packing; owned by this environment. */
  readonly specularTexture?: GPUTexture;
  readonly diffuse: GPUTextureView;
  readonly brdf: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly specularMipSelection?: EnvironmentMipSelection;
  readonly panorama?: { readonly view: GPUTextureView; readonly sampler: GPUSampler };
  readonly reflectionProbes?: readonly import("./pbrReflectionProbes.js").PbrReflectionProbe[];
  dispose(): void;
}

const ABORT_MESSAGE = "Studio environment creation was aborted.";

export async function createStudioEnvironment(session: DeviceSession,
  signal?: AbortSignal, keptMips?: number): Promise<StudioEnvironment> {
  const selection = environmentMipSelection(8, keptMips);
  if (session.state !== "ready") throw new Error("GPU session is not ready for studio environment creation.");
  if (signal?.aborted) throw gpuAbortReason(signal, ABORT_MESSAGE);
  const device = session.device, owned: GPUTexture[] = [];
  const create = (label: string, size: GPUExtent3D, mipLevelCount = 1): GPUTexture => {
    const texture = createAdmittedTexture(session, { label, size, mipLevelCount, format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    owned.push(texture); return texture;
  };
  let settings: GPUBuffer | undefined;
  let scopeOpen = false;
  try {
    device.pushErrorScope("validation"); scopeOpen = true;
    const module = device.createShaderModule({ label: "Deep studio IBL generation", code: environmentShader });
    const info = await abortableGpu(module.getCompilationInfo(), signal, ABORT_MESSAGE);
    const errors = info.messages.filter(message => message.type === "error");
    if (errors.length) throw new Error(errors.map(message =>
      `Environment WGSL ${message.lineNum}: ${message.message}`).join("\n"));
    const [environment, brdfPipeline] = await abortableGpu(Promise.all([
      device.createComputePipelineAsync({ label: "Deep environment prefilter", layout: "auto",
        compute: { module, entryPoint: "environmentMain" } }),
      device.createComputePipelineAsync({ label: "Deep BRDF integration", layout: "auto",
        compute: { module, entryPoint: "brdfMain" } }),
    ]), signal, ABORT_MESSAGE);
    const baseSize = 128 >> selection.droppedMips;
    const specular = create("Deep specular environment", [baseSize, baseSize, 6], selection.keptMips);
    const diffuse = create("Deep diffuse irradiance", [32, 32, 6]);
    const brdf = create("Deep DFG LUT", [128, 128]);
    const stride = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
    const records = selection.keptMips + 1;
    const data = new ArrayBuffer(stride * records);
    const floats = new Float32Array(data), integers = new Uint32Array(data);
    for (let level = 0; level < records; level++) {
      const index = level * stride / 4;
      const diffuseLevel = level === selection.keptMips, originalLevel = level + selection.droppedMips;
      floats[index] = diffuseLevel ? 1 : originalLevel / 7;
      floats[index + 1] = diffuseLevel ? 32 : baseSize >> level;
      integers[index + 2] = diffuseLevel ? 1 : 0;
      integers[index + 3] = 128;
    }
    settings = createAdmittedBuffer(session, { label: "Deep environment setup", size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(settings, 0, data);
    const encoder = device.createCommandEncoder({ label: "Deep initialize environment once" });
    for (let level = 0; level < records; level++) {
      const diffuseLevel = level === selection.keptMips;
      const texture = diffuseLevel ? diffuse : specular, mip = diffuseLevel ? 0 : level;
      const size = diffuseLevel ? 32 : baseSize >> level;
      const bindGroup = device.createBindGroup({ layout: environment.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: settings, offset: level * stride, size: 16 } },
        { binding: 1, resource: texture.createView({ dimension: "2d-array",
          baseMipLevel: mip, mipLevelCount: 1 }) },
      ] });
      const pass = encoder.beginComputePass({ label: `Deep environment level ${level}` });
      pass.setPipeline(environment); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6); pass.end();
    }
    const lutPass = encoder.beginComputePass({ label: "Deep DFG integration" });
    lutPass.setPipeline(brdfPipeline);
    lutPass.setBindGroup(0, device.createBindGroup({ layout: brdfPipeline.getBindGroupLayout(0),
      entries: [{ binding: 2, resource: brdf.createView() }] }));
    lutPass.dispatchWorkgroups(16, 16); lutPass.end();
    device.queue.submit([encoder.finish()]);
    await abortableGpu(device.queue.onSubmittedWorkDone(), signal, ABORT_MESSAGE);
    const gpuErrorPromise = device.popErrorScope(); scopeOpen = false;
    const gpuError = await abortableGpu(gpuErrorPromise, signal, ABORT_MESSAGE);
    if (gpuError) throw new Error(`Studio environment GPU validation failed: ${gpuError.message}`);
    session.release(settings); settings = undefined;
    let disposed = false;
    return Object.freeze({ specular: specular.createView({ dimension: "cube" }), specularTexture: specular,
      specularMipSelection: selection,
      diffuse: diffuse.createView({ dimension: "cube" }), brdf: brdf.createView(),
      sampler: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }),
      dispose(): void { if (disposed) return; disposed = true;
        for (const resource of owned) session.release(resource); },
    });
  } catch (error) {
    if (scopeOpen) try { await device.popErrorScope(); } catch { /* Preserve the original failure. */ }
    if (settings) session.release(settings);
    for (const resource of owned) session.release(resource);
    throw error;
  }
}
