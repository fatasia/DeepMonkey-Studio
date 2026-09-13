import type { CascadedShadowResources } from "./cascadedShadowResources.js";
import type { Pipelines } from "./pipelines.js";
import type { StudioEnvironment } from "./studioEnvironment.js";

export function createPbrMainBindings(device: GPUDevice, pipelines: Pipelines, frameBuffer: GPUBuffer,
  shadows: CascadedShadowResources, environment: StudioEnvironment): GPUBindGroup {
  return device.createBindGroup({ layout: pipelines.main.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: frameBuffer } }, { binding: 1, resource: shadows.legacyView },
    { binding: 2, resource: shadows.sampler }, { binding: 3, resource: environment.specular },
    { binding: 4, resource: environment.diffuse }, { binding: 5, resource: environment.brdf },
    { binding: 6, resource: environment.sampler },
  ] });
}
