import { createAdmittedTexture } from "../webgpu/resourceAdmission.js";
import { perspective } from "../webgpu/cameraMath.js";
import { contactShadowSceneParameters, packContactShadowUniform, surfaceToLightView } from "./contactShadowUniform.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { uploadBuffer } from "../webgpu/meshBuffers.js";
import { contactShadowWgsl, CONTACT_APPLY_WGSL, CONTACT_SHADOW_UNIFORM_BYTES } from "./contactShadowWgsl.js";
import { resolveContactShadowQuality, estimateContactShadowMaskBytes,
  type ContactShadowQualitySelection, type ContactShadowQualityTier } from "./contactShadowQuality.js";
import type { ShadowVec3 } from "./types.js";
import type { PbrActualPassDescription } from "../webgpu/pbrFramePlanResources.js";

/**
 * C10 屏幕空间接触阴影资源合同(cascadedShadowResources 同款纪律):
 * 自持遮蔽贴(半分辨率 r16float,opt-in 时才存在)、uniform 单源打包、
 * prepare 签名缓存 + commit/invalidate 生命周期、dispose 释放;
 * 上一帧线性深度(外部资源)按视图身份缓存绑定组。
 */

export interface ContactShadowResourceOptions {
  readonly requestedTier?: ContactShadowQualityTier;
  readonly maxMaskDimension?: number;
}

export interface ContactShadowFrameInput {
  /** 当前帧相机投影参数(构建视空间→裁剪矩阵)。 */
  readonly verticalFovRadians: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  /** 当前帧 world→view(把世界光方向变到视空间)。 */
  readonly worldToView: readonly number[];
  /** 主光行进方向(世界);接触阴影用其反方向(表面指向光源)。 */
  readonly lightDirectionWorld: ShadowVec3;
  /** 场景 extent:派生 radius/thickness(与 AO 同纪律)。 */
  readonly extent: number;
  readonly width: number;
  readonly height: number;
  /** 相机切换:本帧强度归零(上一帧深度失效,fail-closed 不出鬼影)。 */
  readonly cameraCut: boolean;
}

export interface ContactShadowFrame {
  readonly render: boolean;
  readonly maskView: GPUTextureView;
  readonly maskWidth: number;
  readonly maskHeight: number;
  /** 遮蔽贴本帧被重建(尺寸变化);宿主必须重建主绑定组。 */
  readonly recreated: boolean;
}

interface CachedDepthBinding {
  readonly depth: GPUTextureView;
  readonly binding: GPUBindGroup;
}

/** Owns the half-resolution contact occlusion mask, its uniform and the trace pipeline. */
export class ContactShadowResources {
  readonly selection: ContactShadowQualitySelection;
  private readonly pipeline: GPUComputePipeline;
  private readonly applyPipeline: GPUComputePipeline;
  private readonly applySampler: GPUSampler;
  private applyBindings: Array<{ readonly color: GPUTexture; readonly binding: GPUBindGroup }> = [];
  private applyTexture: GPUTexture | undefined;
  private applyWidth = 0;
  private applyHeight = 0;

  private readonly uniform: GPUBuffer;
  private texture: GPUTexture | undefined;
  private currentMaskView: GPUTextureView | undefined;
  private maskWidth = 0;
  private maskHeight = 0;
  private depthBindings: CachedDepthBinding[] = [];
  private lastSignature: readonly number[] | undefined;
  private pendingSignature: readonly number[] | undefined;
  private disposed = false;
  private renderingEnabled = true;

  constructor(private readonly session: DeviceSession, options: ContactShadowResourceOptions = {}) {
    if (options && typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Contact shadow resource options must be an object.");
    }
    this.selection = resolveContactShadowQuality(options.requestedTier ?? "balanced",
      options.maxMaskDimension === undefined ? undefined : { maxTextureDimension2D: options.maxMaskDimension });
    const device = session.device;
    const created: Array<GPUBuffer> = [];
    try {
      const module = device.createShaderModule({ label: "Deep contact shadow trace WGSL",
        code: contactShadowWgsl(this.selection.profile.options.steps) });
      const layout = device.createBindGroupLayout({ label: "Deep contact shadow layout", entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform",
          minBindingSize: CONTACT_SHADOW_UNIFORM_BYTES } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      ] });
      const applyLayout = device.createBindGroupLayout({ label: "Deep contact shadow apply layout", entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      ] });
      const applyModule = device.createShaderModule({ label: "Deep contact shadow apply WGSL", code: CONTACT_APPLY_WGSL });
      this.applyPipeline = device.createComputePipeline({ label: "Deep contact shadow apply pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [applyLayout] }),
        compute: { module: applyModule, entryPoint: "contactApplyMain" } });
      this.applySampler = device.createSampler({ label: "Deep contact shadow apply sampler",
        magFilter: "linear", minFilter: "linear" });
      this.pipeline = device.createComputePipeline({ label: "Deep contact shadow trace pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "contactShadowMain" } });
      this.uniform = uploadBuffer(session, "Deep contact shadow uniform",
        new Float32Array(CONTACT_SHADOW_UNIFORM_BYTES / 4), GPUBufferUsage.UNIFORM);
      created.push(this.uniform);
    } catch (error) {
      for (const resource of created.reverse()) session.release(resource);
      throw error;
    }
  }

  get metrics(): Readonly<{ contactShadowTier: ContactShadowQualityTier; contactShadowMaskBytes: number }> {
    return { contactShadowTier: this.selection.selectedTier,
      contactShadowMaskBytes: estimateContactShadowMaskBytes(this.maskWidth || 1, this.maskHeight || 1) };
  }

  /** 主绑定组(binding 9)消费的遮蔽贴视图;首帧 prepare 前为 undefined(宿主回落零纹理)。 */
  get maskView(): GPUTextureView | undefined { return this.currentMaskView; }



  /** 签名缓存 + 半分辨率遮蔽贴生命周期;render 标记本帧是否需要重新步进。 */
  prepare(input: ContactShadowFrameInput, force: boolean, enabled = true): ContactShadowFrame {
    if (this.disposed) throw new Error("Contact shadow resources are disposed.");
    if (enabled && !this.renderingEnabled) this.invalidate();
    this.renderingEnabled = enabled;
    const desiredWidth = Math.max(1, Math.ceil(input.width / 2));
    const desiredHeight = Math.max(1, Math.ceil(input.height / 2));
    let recreated = false;
    if (desiredWidth !== this.maskWidth || desiredHeight !== this.maskHeight || !this.texture) {
      const previous = this.texture;
      this.texture = createAdmittedTexture(this.session, {
        label: "Deep contact shadow mask", size: [desiredWidth, desiredHeight, 1], format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      this.currentMaskView = this.texture.createView();
      this.maskWidth = desiredWidth; this.maskHeight = desiredHeight;
      this.depthBindings = [];
      if (previous) this.session.release(previous);
      // 首建与重建都要求宿主重绑主绑定组(binding 9 从兜底纹理切到真实遮蔽贴)。
      recreated = true;
    }
    const direction = surfaceToLightView(input.lightDirectionWorld, input.worldToView);
    const tanHalfFov = Math.tan(input.verticalFovRadians * 0.5);
    const scene = contactShadowSceneParameters(input.extent, this.selection.profile.tier);
    const strength = enabled ? input.cameraCut ? 0 : this.selection.profile.options.strength : 0;
    const signature = [enabled ? 1 : 0, input.cameraCut ? 1 : 0, input.width, input.height, input.extent,
      input.verticalFovRadians, input.aspect, input.near, input.far, ...direction];
    const changed = !this.lastSignature || !same(this.lastSignature, signature);
    if (changed || recreated) {
      const projection = perspective(input.verticalFovRadians, input.aspect, input.near, input.far);
      const packed = packContactShadowUniform({ projection,
        lightView: [...direction, tanHalfFov], thickness: scene.thickness, strength,
        falloff: this.selection.profile.options.falloff, radius: scene.radius,
        width: input.width, height: input.height });
      this.session.device.queue.writeBuffer(this.uniform, 0, packed);
    }
    // 逐帧步进:深度内容每帧都变(签名恒定≠内容恒定),0.02ms 级内核不缓存跳帧。
    return Object.freeze({ render: enabled,
      maskView: this.currentMaskView!, maskWidth: this.maskWidth, maskHeight: this.maskHeight, recreated });
  }

  /**
   * 深度视图身份缓存步进绑定组 + 半分辨率 dispatch;随后 apply 全分辨率合成。
   * 返回 contact-hdr 视图(宿主把它作为后处理链的输入;无接触阴影时宿主回落原链)。
   */
  encode(encoder: GPUCommandEncoder, frame: ContactShadowFrame, depthView: GPUTextureView,
    colorView: GPUTexture,
    passTiming?: { beginMarker(encoder: GPUCommandEncoder, passId: string): void;
      endMarker(encoder: GPUCommandEncoder, passId: string): void }): { readonly texture: GPUTexture } {
    if (this.disposed) throw new Error("Contact shadow resources are disposed.");
    // apply 全分辨率目标(与 mask 同生命周期管理,尺寸随帧面变化重建)。
    const applyWidth = Math.max(1, frame.maskWidth * 2);
    const applyHeight = Math.max(1, frame.maskHeight * 2);
    if (applyWidth !== this.applyWidth || applyHeight !== this.applyHeight || !this.applyTexture) {
      const previous = this.applyTexture;
      this.applyTexture = createAdmittedTexture(this.session, {
        label: "Deep contact shadow apply", size: [applyWidth, applyHeight, 1], format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT });
      this.applyWidth = applyWidth; this.applyHeight = applyHeight;
      this.applyBindings = [];
      if (previous) this.session.release(previous);
    }
    let cached = this.depthBindings.find(entry => entry.depth === depthView);
    if (!cached) {
      cached = { depth: depthView, binding: this.session.device.createBindGroup({
        label: "Deep contact shadow trace bindings", layout: this.pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: depthView },
          { binding: 2, resource: frame.maskView },
        ] }) };
      this.depthBindings.push(cached);
      if (this.depthBindings.length > 4) this.depthBindings.shift();
    }
    let applyCached = this.applyBindings.find(entry => entry.color === colorView);
    if (!applyCached) {
      const binding = this.session.device.createBindGroup({
        label: "Deep contact shadow apply bindings", layout: this.applyPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: colorView.createView() },
          { binding: 1, resource: frame.maskView },
          { binding: 2, resource: this.applySampler },
          { binding: 3, resource: this.applyTexture.createView() },
        ] });
      applyCached = { color: colorView, binding };
      this.applyBindings.push(applyCached);
      if (this.applyBindings.length > 4) this.applyBindings.shift();
    }
    passTiming?.beginMarker(encoder, "contact-shadow");
    const trace = encoder.beginComputePass({ label: "Deep contact shadow trace" });
    trace.setPipeline(this.pipeline);
    trace.setBindGroup(0, cached.binding);
    trace.dispatchWorkgroups(Math.ceil(frame.maskWidth / 8), Math.ceil(frame.maskHeight / 8));
    trace.end();
    passTiming?.endMarker(encoder, "contact-shadow");
    passTiming?.beginMarker(encoder, "contact-apply");
    const apply = encoder.beginComputePass({ label: "Deep contact shadow apply" });
    apply.setPipeline(this.applyPipeline);
    apply.setBindGroup(0, applyCached.binding);
    apply.dispatchWorkgroups(Math.ceil(applyWidth / 8), Math.ceil(applyHeight / 8));
    apply.end();
    passTiming?.endMarker(encoder, "contact-apply");
    return { texture: this.applyTexture };
  }

  /** Publishes the prepared signature only after the command buffer was accepted by the queue. */
  commit(): void {
    if (this.pendingSignature) this.lastSignature = this.pendingSignature;
    this.pendingSignature = undefined;
  }

  invalidate(): void { this.lastSignature = undefined; this.pendingSignature = undefined; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.texture) this.session.release(this.texture);
    if (this.applyTexture) this.session.release(this.applyTexture);
    this.texture = undefined; this.currentMaskView = undefined; this.applyTexture = undefined;
    this.applyBindings = [];
    this.depthBindings = [];
    this.invalidate();
  }
}

function same(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}



/** 第一切片计划对拍声明:contact-shadow 计算步(上一帧线性深度 → 半分辨率遮蔽贴)。 */
export function describeContactShadowPass(): PbrActualPassDescription {
  return {
    passId: "contact-shadow", executor: "ContactShadowResources.encode", kind: "compute",
    reads: ["linear-depth"], writes: ["contact-shadow-mask"],
    claims: [
      { id: "linear-depth", access: "read", format: "r32float", sampleCount: 1,
        usages: ["render-attachment", "texture-binding", "copy-src"], sizeRole: "surface" },
      { id: "contact-shadow-mask", access: "write", format: "rgba16float", sampleCount: 1,
        usages: ["storage-binding", "texture-binding"], sizeRole: "half" },
    ],
    gpuPassCount: 1,
  };
}

/** 第一切片计划对拍声明:contact-apply 全分辨率合成(输入=前链颜色+遮蔽贴)。 */
export function describeContactApplyPass(inputResource: string): PbrActualPassDescription {
  return {
    passId: "contact-apply", executor: "ContactShadowResources.encode/apply", kind: "compute",
    reads: [inputResource, "contact-shadow-mask"], writes: ["contact-hdr"],
    claims: [
      { id: inputResource, access: "read", format: "rgba16float", sampleCount: 1,
        usages: ["storage-binding", "texture-binding", "render-attachment", "copy-src"], sizeRole: "surface" },
      { id: "contact-shadow-mask", access: "read", format: "rgba16float", sampleCount: 1,
        usages: ["storage-binding", "texture-binding"], sizeRole: "half" },
      { id: "contact-hdr", access: "write", format: "rgba16float", sampleCount: 1,
        usages: ["storage-binding", "texture-binding", "render-attachment", "copy-src"], sizeRole: "surface" },
    ],
    gpuPassCount: 1,
  };
}
