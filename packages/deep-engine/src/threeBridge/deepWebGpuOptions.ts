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
  if (Object.keys(options).some(key => !["shadows", "features", "environment", "deformation", "meshlets", "frameCapture", "adaptiveQuality", "probeClipmap", "pipelines",
    "resolutionScalePolicy", "gpuPassTiming", "probeDirections", "clusterLod", "virtualTextures"].includes(key))) {
    throw new TypeError("Unknown Deep WebGPU renderer option.");
  }
  if (options.deformation !== undefined && typeof options.deformation !== "boolean") {
    throw new TypeError("Deep WebGPU deformation option must be boolean.");
  }
  if (options.meshlets !== undefined && typeof options.meshlets !== "boolean") throw new TypeError("Deep WebGPU meshlets option must be boolean.");
  if (options.clusterLod !== undefined && typeof options.clusterLod !== "boolean") {
    throw new TypeError("Deep WebGPU clusterLod option must be boolean.");
  }
  // F3 虚拟纹理快照边界:非对象(含 null/标量)在 spread 下会静默吞成空对象穿透
  // 快照,fail-closed 在边界拒绝;字段级语义校验由 resolveVirtualTextureOptions
  // 的 fail-closed 解析(启用但非法 → enabled:false+reason)在渲染侧负责,不在此重复。
  if (options.virtualTextures !== undefined
    && (!options.virtualTextures || typeof options.virtualTextures !== "object" || Array.isArray(options.virtualTextures))) {
    throw new TypeError("Deep WebGPU virtualTextures option must be an object.");
  }
  return Object.freeze({
    ...(options.meshlets === undefined ? {} : { meshlets: options.meshlets }),
    ...(options.deformation === undefined ? {} : { deformation: options.deformation }),
    ...(options.shadows === undefined ? {} : { shadows: snapshotShadows(options.shadows) }),
    ...(options.features === undefined ? {} : { features: resolvePbrRendererFeatures(options.features) }),
    ...(options.environment === undefined ? {} : { environment: snapshotEnvironment(options.environment) }),
    ...(options.frameCapture === undefined ? {} : { frameCapture: options.frameCapture }),
    ...(options.adaptiveQuality === undefined ? {} : { adaptiveQuality: Object.freeze({ ...options.adaptiveQuality,
      ...(options.adaptiveQuality.overrides ? { overrides: Object.freeze({ ...options.adaptiveQuality.overrides }) } : {}) }) }),
    ...(options.probeClipmap === undefined ? {} : { probeClipmap: Object.freeze({ ...options.probeClipmap }) }),
    ...(options.pipelines === undefined ? {} : { pipelines: snapshotPipelineBootstrap(options.pipelines) }),
    // T07 动态分辨率策略 / F1 逐 pass 计时开关 / G3 GI 方向数门控：opt-in，缺省不进快照。
    ...(options.resolutionScalePolicy === undefined ? {} : { resolutionScalePolicy: Object.freeze({ ...options.resolutionScalePolicy }) }),
    ...(options.gpuPassTiming === undefined ? {} : { gpuPassTiming: options.gpuPassTiming }),
    ...(options.probeDirections === undefined ? {} : { probeDirections: options.probeDirections }),
    // G1 簇级微多边形槽位开关（opt-in）：缺省不进快照，默认路径零行为变化。
    ...(options.clusterLod === undefined ? {} : { clusterLod: options.clusterLod }),
    // F4 虚拟纹理采样接线（opt-in）：缺省不进快照；显式配置冻结快照供首屏一致性校验。
    ...(options.virtualTextures === undefined ? {} : { virtualTextures: Object.freeze({ ...options.virtualTextures }) }),
  });
}

function snapshotPipelineBootstrap(options: NonNullable<PbrRendererOptions["pipelines"]>): NonNullable<PbrRendererOptions["pipelines"]> {
  return Object.freeze({
    ...(options.firstFrameSubset === undefined ? {} : { firstFrameSubset: options.firstFrameSubset }),
    ...(options.firstFrameMainKeys === undefined ? {} : { firstFrameMainKeys: Object.freeze([...options.firstFrameMainKeys]) }),
    ...(options.deferDeformation === undefined ? {} : { deferDeformation: options.deferDeformation }),
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
