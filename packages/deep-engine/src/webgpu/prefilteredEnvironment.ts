import { createAdmittedTexture } from "./resourceAdmission.js";
import type { RuntimePrefilteredIbl, RuntimeIblMip } from "../runtimePackage/environmentTypes.js";
import { validateRuntimePrefilteredIbl } from "../runtimePackage/environment.js";
import { snapshotJson } from "../runtimePackage/primitives.js";
import { visitIblBytes } from "../runtimePackage/environmentBytes.js";
import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";
import { abortableGpu, gpuAbortReason } from "./gpuAbort.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

/** Uploads validated offline IBL bytes directly; does not re-filter or decode source HDR files. */
export async function createPrefilteredEnvironment(session: DeviceSession, input: RuntimePrefilteredIbl,
  signal: AbortSignal): Promise<StudioEnvironment> {
  const cancelled = () => { if (signal.aborted) throw gpuAbortReason(signal, "IBL upload cancelled."); };
  cancelled();
  const source = snapshotJson(input) as unknown as RuntimePrefilteredIbl;
  validateRuntimePrefilteredIbl(source, source.id, source.revision);
  cancelled();
  if (session.state !== "ready") throw Error("GPU session is not ready for IBL upload.");
  const device = session.device, owned: GPUTexture[] = [];
  for (const size of [source.specular.mips[0]!.size, source.diffuse.mips[0]!.size, source.brdfLut.width]) {
    if (size > device.limits.maxTextureDimension2D) throw Error("IBL exceeds device texture dimension limit.");
  }
  const create = (label: string, size: number, layers: number, mipLevelCount: number) => {
    const texture = createAdmittedTexture(session, { label, size: [size, size, layers], mipLevelCount,
      format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    owned.push(texture); return texture;
  };
  const upload = (texture: GPUTexture, mip: RuntimeIblMip, mipLevel: number, layers: number) => {
    cancelled();
    const bytes = new Uint8Array(mip.size * mip.size * layers * 8);
    visitIblBytes(mip.dataBase64, bytes.length, "$.environment.texels", (byte, index) => { bytes[index] = byte; });
    device.queue.writeTexture({ texture, mipLevel }, bytes, { bytesPerRow: mip.size * 8, rowsPerImage: mip.size },
      { width: mip.size, height: mip.size, depthOrArrayLayers: layers });
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    const textures = owned.splice(0);
    runResourceCleanup("Prefiltered IBL cleanup failed.", textures.map(value => () => session.release(value)));
  };
  try {
    const stage = gpuValidatedStage(device, () => {
      const specular = create("Deep imported specular IBL", source.specular.mips[0]!.size, 6, source.specular.mips.length);
      const diffuse = create("Deep imported diffuse IBL", source.diffuse.mips[0]!.size, 6, 1);
      const brdf = create("Deep imported BRDF LUT", source.brdfLut.width, 1, 1);
      source.specular.mips.forEach((mip, level) => upload(specular, mip, level, 6));
      upload(diffuse, source.diffuse.mips[0]!, 0, 6);
      upload(brdf, { size: source.brdfLut.width, dataBase64: source.brdfLut.dataBase64 }, 0, 1);
      return Object.freeze({ specular: specular.createView({ dimension: "cube" }), diffuse: diffuse.createView({ dimension: "cube" }),
        brdf: brdf.createView(), sampler: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }), dispose });
    }, "Prefiltered IBL GPU validation failed");
    await abortableGpu(Promise.all([stage.checked, Promise.resolve().then(() => device.queue.onSubmittedWorkDone())]), signal, "IBL upload cancelled.");
    cancelled();
    if (session.state !== "ready") throw Error("GPU session changed during IBL upload.");
    return stage.value;
  } catch (error) { failWithResourceCleanup(error, "Prefiltered IBL preparation failed.", [dispose]); }
}
