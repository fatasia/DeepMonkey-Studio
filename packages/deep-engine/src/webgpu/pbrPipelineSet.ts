import type { DeviceSession } from "./deviceSession.js";
import type { PbrRendererOptions } from "./pbrRendererTypes.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPipelines } from "./pipelines.js";

/** 静态材质 ABI 保持原布局；变形使用单独的 storage 顶点管线。 */
export async function createPbrPipelineSet(session: DeviceSession, lightingLayout: GPUBindGroupLayout,
  options: PbrRendererOptions, features: PbrRendererFeatures) {
  if (options.deformation !== undefined && typeof options.deformation !== "boolean")
    throw new TypeError("PBR deformation capability must be boolean.");
  if (options.meshlets !== undefined && typeof options.meshlets !== "boolean") throw new TypeError("PBR meshlets capability must be boolean.");
  const writeGeometry = features.ambientOcclusion || features.temporalAa || options.deformation === true;
  const [pipelines, deformationPipelines] = await Promise.all([
    createPipelines(session.device, session.format, lightingLayout, writeGeometry,
      !features.environment && !features.fog && !features.groundGrid, options.shadows?.exactProfile?.cascadeCount === 1),
    options.deformation ? createPipelines(session.device, session.format, lightingLayout, true, false, options.shadows?.exactProfile?.cascadeCount === 1,
      { deformation: true }) : undefined,
  ]);
  return { pipelines, deformationPipelines };
}
