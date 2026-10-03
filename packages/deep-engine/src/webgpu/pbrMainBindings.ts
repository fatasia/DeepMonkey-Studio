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
import { packPbrEnvironmentReflections, pbrReflectionProbeViews } from "./pbrReflectionProbes.js";

/** Frame-global bindings; resources are owned by the renderer's device session. */
export class PbrMainBindings {
  private readonly diffuseBuffer: GPUBuffer;
  private diffuseData = packDiffuseIrradiance();
  private readonly fogBuffer: GPUBuffer;
  private fogData = packPbrFog(undefined);
  private readonly reflectionBuffers: readonly [GPUBuffer, GPUBuffer];
  private reflectionBufferIndex = 0;
  binding: GPUBindGroup;
  private backgroundPass: PbrBackgroundPass | undefined;

  constructor(private readonly session: DeviceSession, private readonly pipelines: Pipelines,
    private readonly frameBuffer: GPUBuffer, private shadows: CascadedShadowResources,
    environment: StudioEnvironment) {
    this.diffuseBuffer = uploadBuffer(session, "Deep authored diffuse irradiance", this.diffuseData, GPUBufferUsage.UNIFORM);
    let fogBuffer: GPUBuffer | undefined;
    const reflectionBuffers: GPUBuffer[] = [];
    try {
      fogBuffer = uploadBuffer(session, "Deep authored fog", this.fogData, GPUBufferUsage.UNIFORM);
      this.fogBuffer = fogBuffer;
      const reflectionData = packPbrEnvironmentReflections(environment);
      for (let index = 0; index < 2; index++) reflectionBuffers.push(uploadBuffer(session,
        "Deep local reflection records", reflectionData, GPUBufferUsage.UNIFORM));
      this.reflectionBuffers = reflectionBuffers as [GPUBuffer, GPUBuffer];
      this.binding = this.createBinding(environment);
    } catch (error) {
      for (const buffer of reflectionBuffers) session.release(buffer);
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

  setEnvironment(environment: StudioEnvironment): void {
    const nextIndex = 1 - this.reflectionBufferIndex;
    const data = packPbrEnvironmentReflections(environment);
    const binding = this.createBinding(environment, this.shadows, this.reflectionBuffers[nextIndex]!);
    this.session.device.queue.writeBuffer(this.reflectionBuffers[nextIndex]!, 0, data);
    this.reflectionBufferIndex = nextIndex; this.binding = binding;
  }

  setShadows(shadows: CascadedShadowResources, environment: StudioEnvironment): void {
    const binding = this.createBinding(environment, shadows);
    this.shadows = shadows; this.binding = binding;
  }

  prepareBackground(view: PbrFrameUniformView, environment: StudioEnvironment, aspect: number,
    writeGeometryBuffers: boolean): ((pass: GPURenderPassEncoder) => void) | undefined {
    if (!view.panoramaBackground) return undefined;
    this.backgroundPass ??= new PbrBackgroundPass(this.session, writeGeometryBuffers);
    if (view.panoramaBackground.toneMapped === false) return undefined;
    return this.backgroundPass.prepare(view, environment, aspect);
  }

  encodeDisplayBackground(encoder: GPUCommandEncoder, target: GPUTextureView, depth: GPUTextureView,
    view: PbrFrameUniformView, environment: StudioEnvironment, aspect: number): boolean {
    if (view.panoramaBackground?.toneMapped !== false) return false;
    this.backgroundPass ??= new PbrBackgroundPass(this.session, true);
    this.backgroundPass.encodeDisplay(encoder, target, depth, view, environment, aspect);
    return true;
  }

  private createBinding(environment: StudioEnvironment, shadows = this.shadows,
    reflectionBuffer = this.reflectionBuffers[this.reflectionBufferIndex]!): GPUBindGroup {
    const [primary, secondary] = pbrReflectionProbeViews(environment);
    return this.session.device.createBindGroup({ layout: this.pipelines.main.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.frameBuffer } }, { binding: 1, resource: shadows.legacyView },
      { binding: 2, resource: shadows.sampler }, { binding: 3, resource: environment.specular },
      { binding: 4, resource: environment.diffuse }, { binding: 5, resource: environment.brdf },
      { binding: 6, resource: environment.sampler }, { binding: 7, resource: { buffer: this.diffuseBuffer } },
      { binding: 8, resource: { buffer: this.fogBuffer } },
      { binding: 9, resource: primary }, { binding: 10, resource: secondary },
      { binding: 11, resource: { buffer: reflectionBuffer } },
    ] });
  }

}
