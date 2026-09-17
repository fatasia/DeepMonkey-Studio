import { createAdmittedTexture, createAdmittedBuffer } from "./resourceAdmission.js";
import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import { prepareHdrEnvironmentUpload } from "../textures/hdrEnvironmentUpload.js";
import type { DeviceSession } from "./deviceSession.js";
import { environmentShader } from "./environmentShader.js";
import { abortableGpu, gpuAbortReason } from "./gpuAbort.js";
import type { StudioEnvironment } from "./studioEnvironment.js";

export interface HdrEnvironmentOptions {
  readonly specularSize?: 64 | 128 | 256;
  readonly diffuseSize?: 16 | 32 | 64;
  readonly sampleCount?: 64 | 128 | 256;
  readonly maxUploadBytes?: number;
  readonly maxRadiance?: number;
}

export interface HdrEnvironment extends StudioEnvironment {
  readonly clampedChannels: number;
  dispose(): void;
}

const mipCount = (size: number): number => Math.log2(size) + 1;
const ABORT_MESSAGE = "HDR environment creation was aborted.";

/** Uploads a linear HDR panorama and prefilters it into the renderer's split-sum IBL resources. */
export async function createHdrEnvironment(session: DeviceSession, image: RadianceHdrImage,
  options: HdrEnvironmentOptions = {}, signal?: AbortSignal, backgroundImage?: RadianceHdrImage): Promise<HdrEnvironment> {
  if (session.state !== "ready") throw new Error("GPU session is not ready for HDR environment creation.");
  if (signal?.aborted) throw gpuAbortReason(signal, ABORT_MESSAGE);
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid HDR environment options.");
  const specularSize = options.specularSize ?? 128, diffuseSize = options.diffuseSize ?? 32;
  const sampleCount = options.sampleCount ?? 128, levels = mipCount(specularSize);
  if (![64, 128, 256].includes(specularSize) || ![16, 32, 64].includes(diffuseSize)
    || ![64, 128, 256].includes(sampleCount)) throw new Error("Invalid HDR environment quality setting.");
  const upload = prepareHdrEnvironmentUpload(image, {
    ...(options.maxUploadBytes === undefined ? {} : { maxBytes: options.maxUploadBytes }),
    ...(options.maxRadiance === undefined ? {} : { maxRadiance: options.maxRadiance }),
  });
  const backgroundUpload = backgroundImage && backgroundImage !== image ? prepareHdrEnvironmentUpload(backgroundImage, {
    ...(options.maxUploadBytes === undefined ? {} : { maxBytes: options.maxUploadBytes }),
    ...(options.maxRadiance === undefined ? {} : { maxRadiance: options.maxRadiance }),
  }) : undefined;
  const device = session.device, owned: GPUTexture[] = [];
  let settings: GPUBuffer | undefined;
  let scopeOpen = false;
  const texture = (descriptor: GPUTextureDescriptor): GPUTexture => {
    const value = createAdmittedTexture(session, descriptor); owned.push(value); return value;
  };
  try {
    device.pushErrorScope("validation"); scopeOpen = true;
    const module = device.createShaderModule({ label: "Deep HDRI IBL generation", code: environmentShader });
    const compilation = await abortableGpu(module.getCompilationInfo(), signal, ABORT_MESSAGE);
    const errors = compilation.messages.filter(message => message.type === "error");
    if (errors.length) throw new Error(errors.map(message => `HDRI WGSL ${message.lineNum}: ${message.message}`).join("\n"));
    const [environment, brdfPipeline] = await abortableGpu(Promise.all([
      device.createComputePipelineAsync({ label: "Deep HDRI prefilter", layout: "auto",
        compute: { module, entryPoint: "environmentImageMain" } }),
      device.createComputePipelineAsync({ label: "Deep HDRI DFG integration", layout: "auto",
        compute: { module, entryPoint: "brdfMain" } }),
    ]), signal, ABORT_MESSAGE);
    if (session.state !== "ready") throw new Error("GPU session was lost during HDR environment creation.");
    const source = texture({ label: "Deep HDR panorama", size: [upload.width, upload.height], format: "rgba16float",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    device.queue.writeTexture({ texture: source }, upload.data,
      { bytesPerRow: upload.bytesPerRow, rowsPerImage: upload.height }, [upload.width, upload.height]);
    let panorama = source;
    if (backgroundUpload) {
      const background = backgroundUpload;
      panorama = texture({ label: "Deep HDR background", size: [background.width, background.height], format: "rgba16float",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
      device.queue.writeTexture({ texture: panorama }, background.data,
        { bytesPerRow: background.bytesPerRow, rowsPerImage: background.height }, [background.width, background.height]);
    }
    const specular = texture({ label: "Deep HDRI specular", size: [specularSize, specularSize, 6],
      mipLevelCount: levels, format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const diffuse = texture({ label: "Deep HDRI diffuse", size: [diffuseSize, diffuseSize, 6],
      format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const brdf = texture({ label: "Deep HDRI DFG LUT", size: [128, 128], format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const stride = Math.max(256, device.limits.minUniformBufferOffsetAlignment), records = levels + 1;
    const data = new ArrayBuffer(stride * records), floats = new Float32Array(data), integers = new Uint32Array(data);
    for (let level = 0; level < records; level++) {
      const index = level * stride / 4, diffuseLevel = level === levels;
      floats[index] = diffuseLevel ? 1 : level / Math.max(levels - 1, 1);
      floats[index + 1] = diffuseLevel ? diffuseSize : specularSize >> level;
      integers[index + 2] = diffuseLevel ? 1 : 0; integers[index + 3] = sampleCount;
    }
    settings = createAdmittedBuffer(session, { label: "Deep HDRI settings", size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(settings, 0, data);
    const sampler = device.createSampler({ addressModeU: "repeat", addressModeV: "clamp-to-edge",
      minFilter: "linear", magFilter: "linear" });
    const encoder = device.createCommandEncoder({ label: "Deep prefilter HDR environment" });
    for (let level = 0; level < records; level++) {
      const diffuseLevel = level === levels, output = diffuseLevel ? diffuse : specular;
      const size = diffuseLevel ? diffuseSize : specularSize >> level;
      const bindGroup = device.createBindGroup({ layout: environment.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: settings, offset: level * stride, size: 16 } },
        { binding: 1, resource: output.createView({ dimension: "2d-array",
          baseMipLevel: diffuseLevel ? 0 : level, mipLevelCount: 1 }) },
        { binding: 3, resource: source.createView() }, { binding: 4, resource: sampler },
      ] });
      const pass = encoder.beginComputePass({ label: `Deep HDRI level ${level}` });
      pass.setPipeline(environment); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6); pass.end();
    }
    const lutPass = encoder.beginComputePass({ label: "Deep HDRI DFG LUT" });
    lutPass.setPipeline(brdfPipeline);
    lutPass.setBindGroup(0, device.createBindGroup({ layout: brdfPipeline.getBindGroupLayout(0),
      entries: [{ binding: 2, resource: brdf.createView() }] }));
    lutPass.dispatchWorkgroups(16, 16); lutPass.end();
    device.queue.submit([encoder.finish()]);
    await abortableGpu(device.queue.onSubmittedWorkDone(), signal, ABORT_MESSAGE);
    if (session.state !== "ready") throw new Error("GPU session was lost while prefiltering the HDR environment.");
    const gpuErrorPromise = device.popErrorScope(); scopeOpen = false;
    const gpuError = await abortableGpu(gpuErrorPromise, signal, ABORT_MESSAGE);
    if (gpuError) throw new Error(`HDR environment GPU validation failed: ${gpuError.message}`);
    session.release(settings); settings = undefined;
    if (panorama !== source) { session.release(source); owned.splice(owned.indexOf(source), 1); }
    let disposed = false;
    return Object.freeze({ specular: specular.createView({ dimension: "cube" }),
      diffuse: diffuse.createView({ dimension: "cube" }), brdf: brdf.createView(),
      sampler: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }),
      panorama: Object.freeze({ view: panorama.createView(), sampler }),
      clampedChannels: upload.clampedChannels + (backgroundUpload?.clampedChannels ?? 0),
      dispose(): void {
        if (disposed) return;
        disposed = true;
        for (const resource of owned) session.release(resource);
      } });
  } catch (error) {
    if (scopeOpen) try { await device.popErrorScope(); } catch { /* Preserve the original failure. */ }
    if (settings) session.release(settings);
    for (const resource of owned) session.release(resource);
    throw error;
  }
}
