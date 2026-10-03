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

/** 帧全局阴影绑定源(级联/虚拟两档同形;B1 Brief-VSM 双档切换共用此结构)。 */
export interface PbrShadowBindingSource {
  readonly binding: GPUBindGroup;
  readonly legacyView: GPUTextureView;
  readonly sampler: GPUSampler;
}

/** B1 Brief-VSM 虚拟档 group 0 尾部资源(页表/页 atlas;frameLayout 绑定 12/13/14)。 */
export interface PbrVirtualFrameBinding {
  readonly metaBuffer: GPUBuffer;
  readonly layersBuffer: GPUBuffer;
  readonly atlasView: GPUTextureView;
}

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
    private readonly frameBuffer: GPUBuffer, private shadows: PbrShadowBindingSource,
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
    this.environmentRef = environment;
    const nextIndex = 1 - this.reflectionBufferIndex;
    const data = packPbrEnvironmentReflections(environment);
    const binding = this.createBinding(environment, this.shadows, this.reflectionBuffers[nextIndex]!);
    this.session.device.queue.writeBuffer(this.reflectionBuffers[nextIndex]!, 0, data);
    this.reflectionBufferIndex = nextIndex; this.binding = binding;
  }

  setShadows(shadows: PbrShadowBindingSource, environment: StudioEnvironment): void {
    this.environmentRef = environment;
    const binding = this.createBinding(environment, shadows);
    this.shadows = shadows; this.binding = binding;
  }

  /** B1 Brief-VSM:切换虚拟档页表/atlas 进组 0(以最近一次 environment 重建组 0 绑定)。 */
  setVirtualFrameBinding(virtual: PbrVirtualFrameBinding): void {
    this.virtualBinding = virtual;
    if (this.environmentRef) { this.binding = this.createBinding(this.environmentRef, this.shadows); }
  }

  /** 级联档占位页资源(每 device 一次;16B storage ×2 + 4×4 r32float,常驻可忽略)。 */
  private ensurePlaceholderBinding(): PbrVirtualFrameBinding {
    this.placeholderBinding ??= (() => {
      const device = this.session.device;
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      const metaBuffer = device.createBuffer({ label: "Deep cascade vsm placeholder meta", size: 16, usage });
      const layersBuffer = device.createBuffer({ label: "Deep cascade vsm placeholder layers", size: 16, usage });
      const atlas = device.createTexture({ label: "Deep cascade vsm placeholder atlas",
        size: [4, 4, 1], format: "r32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      return { metaBuffer, layersBuffer, atlasView: atlas.createView({ dimension: "2d-array" }) };
    })();
    return this.placeholderBinding;
  }

  prepareBackground(view: PbrFrameUniformView, environment: StudioEnvironment, aspect: number,
    writeGeometryBuffers: boolean, mainSampleCount: 1 | 4 = 1): ((pass: GPURenderPassEncoder) => void) | undefined {
    if (!view.panoramaBackground) return undefined;
    // AA-M1:HDR 全景在主 pass 内绘制,采样数必须与主 pass 附件一致(display 通路缺省 1)。
    this.backgroundPass ??= new PbrBackgroundPass(this.session, writeGeometryBuffers, mainSampleCount);
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

  /** B1 Brief-VSM:当前挂入组 0 的虚拟页表资源(缺省 = 本类自建的级联档占位)。 */
  private virtualBinding: PbrVirtualFrameBinding | undefined;
  private environmentRef: StudioEnvironment | undefined;
  private placeholderBinding: PbrVirtualFrameBinding | undefined;

  private createBinding(environment: StudioEnvironment, shadows = this.shadows,
    reflectionBuffer = this.reflectionBuffers[this.reflectionBufferIndex]!): GPUBindGroup {
    const [primary, secondary] = pbrReflectionProbeViews(environment);
    // B1 Brief-VSM:组 0 绑定 12/13/14 = 虚拟页表/atlas(virtual 档真资源;级联档占位)。
    const virtual = this.virtualBinding ?? this.ensurePlaceholderBinding();
    return this.session.device.createBindGroup({ layout: this.pipelines.main.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.frameBuffer } }, { binding: 1, resource: shadows.legacyView },
      { binding: 2, resource: shadows.sampler }, { binding: 3, resource: environment.specular },
      { binding: 4, resource: environment.diffuse }, { binding: 5, resource: environment.brdf },
      { binding: 6, resource: environment.sampler }, { binding: 7, resource: { buffer: this.diffuseBuffer } },
      { binding: 8, resource: { buffer: this.fogBuffer } },
      { binding: 9, resource: primary }, { binding: 10, resource: secondary },
      { binding: 11, resource: { buffer: reflectionBuffer } },
      { binding: 12, resource: { buffer: virtual.metaBuffer } },
      { binding: 13, resource: { buffer: virtual.layersBuffer } },
      { binding: 14, resource: virtual.atlasView },
    ] });
  }

}
