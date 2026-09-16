import { snapshotJson } from "../runtimePackage/primitives.js";
import { validateRuntimePrefilteredIbl } from "../runtimePackage/environment.js";
import { resolvePbrRendererFeatures } from "../webgpu/pbrRendererFeatures.js";
import type { PbrRendererOptions } from "../webgpu/pbrRenderer.js";
import type { PbrEnvironmentSource } from "../webgpu/pbrEnvironmentSource.js";
import { snapshotShadows } from "./deepWebGpuShadowPolicy.js";

export function snapshotRendererOptions(options: PbrRendererOptions): PbrRendererOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Deep WebGPU renderer options must be an object.");
  }
  if (Object.keys(options).some(key => !["shadows", "features", "environment", "deformation", "meshlets"].includes(key))) {
    throw new TypeError("Unknown Deep WebGPU renderer option.");
  }
  if (options.deformation !== undefined && typeof options.deformation !== "boolean") {
    throw new TypeError("Deep WebGPU deformation option must be boolean.");
  }
  if (options.meshlets !== undefined && typeof options.meshlets !== "boolean") throw new TypeError("Deep WebGPU meshlets option must be boolean.");
  return Object.freeze({
    ...(options.meshlets === undefined ? {} : { meshlets: options.meshlets }),
    ...(options.deformation === undefined ? {} : { deformation: options.deformation }),
    ...(options.shadows === undefined ? {} : { shadows: snapshotShadows(options.shadows) }),
    ...(options.features === undefined ? {} : { features: resolvePbrRendererFeatures(options.features) }),
    ...(options.environment === undefined ? {} : { environment: snapshotEnvironment(options.environment) }),
  });
}

export function snapshotEnvironment(source: PbrEnvironmentSource): PbrEnvironmentSource {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Deep WebGPU environment source must be an object.");
  }
  if (source.kind === "studio") return Object.freeze({ kind: "studio" });
  if (source.kind === "prefiltered-ibl") {
    const environment = snapshotJson(source.environment) as unknown as typeof source.environment;
    validateRuntimePrefilteredIbl(environment, environment.id, environment.revision);
    return Object.freeze({ kind: "prefiltered-ibl", environment });
  }
  if (source.kind !== "radiance-hdr") throw new RangeError("Unknown Deep WebGPU environment source.");
  const image = source.image;
  if ([image, ...(source.backgroundImage !== undefined ? [source.backgroundImage] : [])].some(value =>
    !value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width < 1 || value.height < 1 || !(value.data instanceof Float32Array)
    || value.data.length !== value.width * value.height * 3)) {
    throw new TypeError("Deep WebGPU HDR environment image must be an owned RGB32F image.");
  }
  const options = source.options;
  if (options !== undefined) {
    const allowed = ["specularSize", "diffuseSize", "sampleCount", "maxUploadBytes", "maxRadiance"];
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => !allowed.includes(key))) {
      throw new TypeError("Unknown Deep WebGPU HDR environment option.");
    }
  }
  return Object.freeze({ kind: "radiance-hdr", image,
    ...(source.backgroundImage === undefined ? {} : { backgroundImage: source.backgroundImage }),
    ...(options === undefined ? {} : { options: Object.freeze({ ...options }) }) });
}
