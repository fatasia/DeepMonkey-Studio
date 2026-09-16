import type { CascadedShadowResources } from "./cascadedShadowResources.js";
import type { Pipelines } from "./pipelines.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import type { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import { packDiffuseIrradiance } from "../lighting/diffuseIrradiance.js";
import type { WorldClusteredLights } from "../lighting/worldLights.js";
import { PbrBackgroundPass } from "./pbrBackgroundPass.js";
import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import { packPbrFog, type PbrFog } from "./pbrFog.js";

/** Frame-global bindings; resources are owned by the renderer's device session. */
export class PbrMainBindings {
  private readonly diffuseBuffer: GPUBuffer;
  private diffuseData = packDiffuseIrradiance();
  private readonly fogBuffer: GPUBuffer;
  private fogData = packPbrFog(undefined);
  binding: GPUBindGroup;
  private backgroundPass: PbrBackgroundPass | undefined;

  constructor(private readonly session: DeviceSession, private readonly pipelines: Pipelines,
    private readonly frameBuffer: GPUBuffer, private shadows: CascadedShadowResources,
    environment: StudioEnvironment) {
    this.diffuseBuffer = uploadBuffer(session, "Deep authored diffuse irradiance", this.diffuseData, GPUBufferUsage.UNIFORM);
    let fogBuffer: GPUBuffer | undefined;
    try {
      fogBuffer = uploadBuffer(session, "Deep authored fog", this.fogData, GPUBufferUsage.UNIFORM);
      this.fogBuffer = fogBuffer;
      this.binding = this.createBinding(environment);
    } catch (error) {
      if (fogBuffer) session.release(fogBuffer);
      session.release(this.diffuseBuffer); throw error;
    }
  }

  update(lights?: WorldClusteredLights, fog?: PbrFog | null): boolean {
    const next = packDiffuseIrradiance(lights), nextFog = packPbrFog(fog);
    const diffuseChanged = !next.every((value, index) => value === this.diffuseData[index]);
    const fogChanged = !nextFog.every((value, index) => value === this.fogData[index]);
    if (diffuseChanged) this.session.device.queue.writeBuffer(this.diffuseBuffer, 0, next);
    if (fogChanged) this.session.device.queue.writeBuffer(this.fogBuffer, 0, nextFog);
    this.diffuseData = next; this.fogData = nextFog;
    return diffuseChanged || fogChanged;
  }

  setEnvironment(environment: StudioEnvironment): void { this.binding = this.createBinding(environment); }

  setShadows(shadows: CascadedShadowResources, environment: StudioEnvironment): void {
    const binding = this.createBinding(environment, shadows);
    this.shadows = shadows; this.binding = binding;
  }

  prepareBackground(view: PbrFrameUniformView, environment: StudioEnvironment, aspect: number,
    writeGeometryBuffers: boolean): ((pass: GPURenderPassEncoder) => void) | undefined {
    if (!view.panoramaBackground) return undefined;
    this.backgroundPass ??= new PbrBackgroundPass(this.session, writeGeometryBuffers);
    return this.backgroundPass.prepare(view, environment, aspect);
  }

  private createBinding(environment: StudioEnvironment, shadows = this.shadows): GPUBindGroup {
    return this.session.device.createBindGroup({ layout: this.pipelines.main.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.frameBuffer } }, { binding: 1, resource: shadows.legacyView },
      { binding: 2, resource: shadows.sampler }, { binding: 3, resource: environment.specular },
      { binding: 4, resource: environment.diffuse }, { binding: 5, resource: environment.brdf },
      { binding: 6, resource: environment.sampler }, { binding: 7, resource: { buffer: this.diffuseBuffer } },
      { binding: 8, resource: { buffer: this.fogBuffer } },
    ] });
  }
}
