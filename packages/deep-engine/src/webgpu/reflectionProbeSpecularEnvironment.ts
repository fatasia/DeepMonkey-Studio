import { prepareHdrEnvironmentUpload } from "../textures/hdrEnvironmentUpload.js";
import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import type { HdrEnvironmentOptions } from "./hdrEnvironment.js";
import { environmentShader } from "./environmentShader.js";
import { createAdmittedBuffer, createAdmittedTexture } from "./resourceAdmission.js";
import { abortableGpu, gpuAbortReason } from "./gpuAbort.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

export interface ReflectionProbeSpecularEnvironment extends StudioEnvironment {
  readonly specularBytes: number;
  readonly uploadBytes: number;
}
const CANCELLED = "Reflection probe preparation cancelled.";

/** Uses the existing HDR prefilter kernel; the caller shares this pipeline within one two-probe preparation. */
export async function compileReflectionProbePrefilter(session: DeviceSession, signal: AbortSignal): Promise<GPUComputePipeline> {
  if (signal.aborted) throw gpuAbortReason(signal, CANCELLED);
  const device = session.device;
  const checkEpoch = () => { if (session.device !== device || session.state !== "ready") throw new Error("GPU epoch changed during reflection probe compilation."); };
  checkEpoch();
  const module = device.createShaderModule({ label: "Deep reflection probe prefilter", code: environmentShader });
  const info = await abortableGpu(module.getCompilationInfo(), signal, CANCELLED);
  checkEpoch();
  const errors = info.messages.filter(message => message.type === "error");
  if (errors.length) throw new Error(errors.map(message => `Reflection probe WGSL ${message.lineNum}: ${message.message}`).join("\n"));
  const pipeline = await abortableGpu(device.createComputePipelineAsync({ label: "Deep reflection probe HDR prefilter",
    layout: "auto", compute: { module, entryPoint: "environmentImageMain" } }), signal, CANCELLED);
  checkEpoch(); return pipeline;
}

/** Owns only the local specular cube. Diffuse, BRDF and sampler are borrowed from the enclosing base environment. */
export async function createReflectionProbeSpecularEnvironment(session: DeviceSession, image: RadianceHdrImage,
  base: StudioEnvironment, pipeline: GPUComputePipeline, signal: AbortSignal,
  options: HdrEnvironmentOptions = {}): Promise<ReflectionProbeSpecularEnvironment> {
  const device = session.device;
  const check = () => {
    if (signal.aborted) throw gpuAbortReason(signal, CANCELLED);
    if (session.state !== "ready" || session.device !== device) throw new Error("GPU epoch changed during reflection probe preparation.");
  };
  check();
  const size = options.specularSize ?? 128, sampleCount = options.sampleCount ?? 128;
  if (![64, 128, 256].includes(size) || ![64, 128, 256].includes(sampleCount)) throw new RangeError("Invalid reflection probe quality setting.");
  const upload = prepareHdrEnvironmentUpload(image, {
    ...(options.maxUploadBytes === undefined ? {} : { maxBytes: options.maxUploadBytes }),
    ...(options.maxRadiance === undefined ? {} : { maxRadiance: options.maxRadiance }),
  });
  if (size > session.device.limits.maxTextureDimension2D || upload.width > session.device.limits.maxTextureDimension2D
    || upload.height > session.device.limits.maxTextureDimension2D) throw new RangeError("Reflection probe exceeds device texture dimensions.");
  const levels = Math.log2(size) + 1, stride = Math.max(256, session.device.limits.minUniformBufferOffsetAlignment);
  const settingsData = new ArrayBuffer(stride * levels), floats = new Float32Array(settingsData), integers = new Uint32Array(settingsData);
  for (let level = 0; level < levels; level++) {
    const offset = level * stride / 4;
    floats[offset] = level / (levels - 1); floats[offset + 1] = size >> level;
    integers[offset + 2] = 0; integers[offset + 3] = sampleCount;
  }
  let source: GPUTexture | undefined, cube: GPUTexture | undefined, settings: GPUBuffer | undefined, scopeOpen = false;
  const releaseTemporary = () => {
    const pendingSource = source, pendingSettings = settings; source = undefined; settings = undefined;
    runResourceCleanup("Reflection probe temporary cleanup failed.", [
      () => { if (pendingSource) session.release(pendingSource); }, () => { if (pendingSettings) session.release(pendingSettings); },
    ]);
  };
  const releaseCube = () => { const pending = cube; cube = undefined; if (pending) session.release(pending); };
  try {
    device.pushErrorScope("validation"); scopeOpen = true;
    source = createAdmittedTexture(session, { label: "Deep reflection probe panorama", size: [upload.width, upload.height],
      format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: source }, upload.data, { bytesPerRow: upload.bytesPerRow, rowsPerImage: upload.height }, [upload.width, upload.height]);
    cube = createAdmittedTexture(session, { label: "Deep local reflection specular", size: [size, size, 6], mipLevelCount: levels,
      format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    settings = createAdmittedBuffer(session, { label: "Deep reflection probe settings", size: settingsData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(settings, 0, settingsData);
    const sampler = device.createSampler({ addressModeU: "repeat", addressModeV: "clamp-to-edge", minFilter: "linear", magFilter: "linear" });
    const encoder = device.createCommandEncoder({ label: "Deep local reflection prefilter" });
    const sourceView = source.createView();
    for (let level = 0; level < levels; level++) {
      check(); const mipSize = size >> level;
      const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: settings, offset: level * stride, size: 16 } },
        { binding: 1, resource: cube.createView({ dimension: "2d-array", baseMipLevel: level, mipLevelCount: 1 }) },
        { binding: 3, resource: sourceView }, { binding: 4, resource: sampler },
      ] });
      const pass = encoder.beginComputePass({ label: `Deep reflection probe mip ${level}` });
      pass.setPipeline(pipeline); pass.setBindGroup(0, binding); pass.dispatchWorkgroups(Math.ceil(mipSize / 8), Math.ceil(mipSize / 8), 6); pass.end();
    }
    device.queue.submit([encoder.finish()]);
    await abortableGpu(device.queue.onSubmittedWorkDone(), signal, CANCELLED); check();
    const errorPromise = device.popErrorScope(); scopeOpen = false;
    const error = await abortableGpu(errorPromise, signal, CANCELLED);
    if (error) throw new Error(`Reflection probe GPU validation failed: ${error.message}`);
    check(); const view = cube.createView({ dimension: "cube" }); releaseTemporary();
    return Object.freeze({ specular: view, specularTexture: cube, diffuse: base.diffuse, brdf: base.brdf, sampler: base.sampler,
      specularBytes: 6 * 8 * (4 * size * size - 1) / 3, uploadBytes: upload.data.byteLength, dispose: releaseCube });
  } catch (error) {
    if (scopeOpen) try { await device.popErrorScope(); } catch { /* Retain preparation failure. */ }
    failWithResourceCleanup(error, "Reflection probe preparation failed.", [releaseTemporary, releaseCube]);
  }
}
