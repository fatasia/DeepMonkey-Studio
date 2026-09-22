import type { DeviceSession } from "./deviceSession.js";
import type { PbrRendererOptions } from "./pbrRendererTypes.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPipelines } from "./pipelines.js";

const PIPELINE_SET_SCHEMA = "deep-pbr-pso-v1";
type PbrPipelineSet = Awaited<ReturnType<typeof buildPbrPipelineSet>>;
const pipelineSets = new WeakMap<GPUDevice,
  WeakMap<GPUBindGroupLayout, Map<string, Promise<PbrPipelineSet>>>>();

/** Explicit device-loss/test invalidation; normal device collection is weak. */
export function clearPbrPipelineSetCache(device: GPUDevice): void { pipelineSets.delete(device); }

/** 静态材质 ABI 保持原布局；变形使用单独的 storage 顶点管线。 */
export async function createPbrPipelineSet(session: DeviceSession, lightingLayout: GPUBindGroupLayout,
  options: PbrRendererOptions, features: PbrRendererFeatures) {
  if (options.deformation !== undefined && typeof options.deformation !== "boolean")
    throw new TypeError("PBR deformation capability must be boolean.");
  if (options.meshlets !== undefined && typeof options.meshlets !== "boolean") throw new TypeError("PBR meshlets capability must be boolean.");
  const writeGeometry = features.ambientOcclusion || features.screenSpaceReflection || features.temporalAa
    || options.deformation === true;
  const directDisplay = !features.environment && !features.fog && !features.groundGrid;
  const oneCascade = options.shadows?.exactProfile?.cascadeCount === 1;
  let byLayout = pipelineSets.get(session.device);
  if (!byLayout) { byLayout = new WeakMap(); pipelineSets.set(session.device, byLayout); }
  let byVariant = byLayout.get(lightingLayout);
  if (!byVariant) { byVariant = new Map(); byLayout.set(lightingLayout, byVariant); }
  const key = [PIPELINE_SET_SCHEMA, session.format, writeGeometry ? 1 : 0, directDisplay ? 1 : 0,
    oneCascade ? 1 : 0, options.deformation === true ? 1 : 0, features.textureArrays ? 1 : 0].join("/");
  const existing = byVariant.get(key);
  if (existing) return existing;
  const created = buildPbrPipelineSet(session, lightingLayout, options, writeGeometry, directDisplay,
    oneCascade, features.textureArrays);
  byVariant.set(key, created);
  void created.catch(() => { if (byVariant!.get(key) === created) byVariant!.delete(key); });
  return created;
}

async function buildPbrPipelineSet(session: DeviceSession, lightingLayout: GPUBindGroupLayout,
  options: PbrRendererOptions, writeGeometry: boolean, directDisplay: boolean, oneCascade: boolean,
  textureArrays: boolean) {
  const [fallback, array, deformationFallback, deformationArray] = await Promise.all([
    createPipelines(session.device, session.format, lightingLayout, writeGeometry, directDisplay, oneCascade),
    textureArrays ? createPipelines(session.device, session.format, lightingLayout, writeGeometry,
      directDisplay, oneCascade, { textureArrays: true }) : undefined,
    options.deformation ? createPipelines(session.device, session.format, lightingLayout, true, false, oneCascade,
      { deformation: true }) : undefined,
    options.deformation && textureArrays ? createPipelines(session.device, session.format, lightingLayout, true, false,
      oneCascade, { deformation: true, textureArrays: true }) : undefined,
  ]);
  const pipelines = array ? Object.freeze({ ...array, textureArrayFallback: fallback }) : fallback;
  const deformationPipelines = deformationArray
    ? Object.freeze({ ...deformationArray, textureArrayFallback: deformationFallback! })
    : deformationFallback;
  return { pipelines, deformationPipelines };
}
