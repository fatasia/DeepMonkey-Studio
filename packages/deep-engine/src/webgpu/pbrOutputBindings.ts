import type { Pipelines } from "./pipelines.js";
import type { DeviceSession } from "./deviceSession.js";
import type { PbrAuthorColorEffects } from "./pbrAuthorColorEffects.js";
import { PbrAuthorColorBindings } from "./pbrAuthorColorBindings.js";
import { uploadBuffer } from "./meshBuffers.js";
import { EditorOverlayPass } from "./editorOverlayPass.js";
import type { EditorOverlaySnapshot } from "./editorOverlayTypes.js";
import type { PbrActualPassDescription } from "./pbrFramePlanResources.js";
import { PBR_HDR_FORMAT } from "./renderTargets.js";
import { SpatialAaPresent } from "./spatialAaPresent.js";
import type { FrameCaptureSourceMapRef } from "../r12/frameCapture.js";
import { DEFAULT_EXTENDED_HEADROOM, HDR_REFERENCE_WHITE_NITS, type HdrDisplayPolicy, type HdrDisplayReasonCode } from "./hdrDisplayOutput.js";
import { hdrSettingsUniform } from "./pbrHdrDisplay.js";
import { createHdrDisplayPipeline, type HdrDisplayPipeline } from "./pbrHdrDisplayPipeline.js";

export interface PbrPresentReceipt {
  readonly view: GPUTextureView;
  readonly acquireMs: number;
  readonly sourceMapRefs?: readonly FrameCaptureSourceMapRef[];
}

/** HDR present 通路运行态:activating(管线异步创建中,暂走 SDR)/active/fallback(显式原因)。 */
export type PbrHdrDisplayState = "activating" | "active" | "fallback";

/** Owns output settings, source bindings and the final presentation pass. */
export class PbrOutputBindings {
  readonly data = new Float32Array([1, 0, 0.25, 0, 0, 0, 1, 1]);
  readonly buffer: GPUBuffer;
  private readonly author: PbrAuthorColorBindings;
  private disposed = false;
  private readonly textureViews = new WeakMap<GPUTexture, GPUTextureView>();
  private readonly bindings = new WeakMap<GPUTexture, GPUBindGroup>();
  private readonly sampler: GPUSampler;
  private overlay: EditorOverlayPass | undefined;
  private spatialAa: SpatialAaPresent | undefined;
  private hdrPolicy: HdrDisplayPolicy | undefined;
  private hdrRuntime: HdrDisplayPipeline | undefined;
  private hdrState: PbrHdrDisplayState | undefined;
  private hdrFallbackReason: HdrDisplayReasonCode | undefined;
  private hdrSettingsWritten = false;
  /** 激活代际令牌:重入/复位使迟到的一次性管线成功作废,不得覆盖最新策略态。 */
  private hdrGeneration = 0;
  private hdrReady: Promise<void> | undefined;
  get ready(): Promise<void> | undefined { return this.hdrReady; }
  get spatialAaActive(): boolean { return this.spatialAaEnabled && this.hdrState !== "active"; }

  constructor(private readonly session: DeviceSession, private readonly pipelines: Pipelines, private readonly now: () => number,
    private readonly spatialAaEnabled = true, hdrDisplay?: HdrDisplayPolicy) {
    this.buffer = uploadBuffer(session, "Deep output", this.data, GPUBufferUsage.UNIFORM);
    try {
      this.sampler = session.device.createSampler({ minFilter: "linear", magFilter: "linear" });
      this.author = new PbrAuthorColorBindings(session, pipelines.output.getBindGroupLayout(1));
    } catch (error) { session.release(this.buffer); throw error; }
    if (hdrDisplay?.mode === "hdr") this.applyHdrDisplay(hdrDisplay);
  }

  /**
   * I-C21 HDR present 通路切换(opt-in)。HDR 激活管线异步创建,首帧在就绪前暂走
   * 既有 SDR 路径(state="activating");创建失败 fail-closed 回 SDR 并记
   * "hdr-pipeline-failed"。未调用(或 mode!=="hdr")时一切行为与既有链逐字节一致。
   */
  applyHdrDisplay(policy: HdrDisplayPolicy): void {
    if (this.disposed) throw new Error("PBR output is disposed.");
    this.hdrGeneration += 1;
    this.hdrBindings = new WeakMap();
    if (this.session.hdrCanvasActive) this.session.restoreSdrCanvas();
    if (!policy || policy.mode !== "hdr") {
      if (this.hdrRuntime !== undefined) {
        try { this.session.release(this.hdrRuntime.hdrSettingsBuffer); } catch { /* 尽力退役 */ }
        this.hdrRuntime = undefined;
      }
      this.hdrPolicy = undefined; this.hdrState = undefined; this.hdrFallbackReason = undefined;
      this.hdrSettingsWritten = false;
      return;
    }
    // 重入激活:旧 HDR 运行时先退役(账面 release),新策略必须重写 settings uniform。
    if (this.hdrRuntime !== undefined) {
      try { this.session.release(this.hdrRuntime.hdrSettingsBuffer); } catch { /* 尽力退役 */ }
      this.hdrRuntime = undefined;
    }
    this.hdrSettingsWritten = false;
    this.hdrPolicy = policy;
    this.hdrState = "activating";
    this.hdrFallbackReason = undefined;
    const generation = this.hdrGeneration;
    const device = this.session.device;
    const authorLayout = this.pipelines.output.getBindGroupLayout(1);
    const current = () => !this.disposed && generation === this.hdrGeneration && device === this.session.device;
    const fallback = () => { if (current()) {
      this.hdrRuntime = undefined; this.hdrState = "fallback"; this.hdrFallbackReason = "hdr-pipeline-failed";
    } };
    this.hdrReady = createHdrDisplayPipeline(device, PBR_HDR_FORMAT, authorLayout).then(async runtime => {
      if (!current()) { runtime.hdrSettingsBuffer.destroy(); return; }
      try {
        this.session.own(runtime.hdrSettingsBuffer);
        // Legacy offscreen sinks have no negotiated surface; production sessions do.
        if (this.session.hdrDisplayCapability) await this.session.activateHdrCanvas(device, current);
        if (!current()) { this.session.release(runtime.hdrSettingsBuffer); return; }
        this.hdrRuntime = runtime; this.hdrState = "active";
      } catch {
        this.session.release(runtime.hdrSettingsBuffer); fallback();
      }
    }, error => {
      if (!current()) return;
      fallback();
      console.warn(`PBR HDR display failed closed to SDR: ${String(error instanceof Error ? error.message : error)}`);
    });
  }

  /** HDR present 运行态(未 opt-in 时 undefined;真机验收/面板读)。 */
  get hdrDisplay(): Readonly<{ state: PbrHdrDisplayState; policy?: HdrDisplayPolicy;
    fallbackReason?: HdrDisplayReasonCode }> | undefined {
    if (!this.hdrState) return undefined;
    return Object.freeze({ state: this.hdrState, ...(this.hdrPolicy ? { policy: this.hdrPolicy } : {}),
      ...(this.hdrFallbackReason ? { fallbackReason: this.hdrFallbackReason } : {}) });
  }

  acquirePresent(measure: boolean): { view: GPUTextureView; acquireMs: number } {
    if (this.disposed) throw new Error("PBR output is disposed.");
    const started = measure ? this.now() : 0;
    const view = this.session.context.getCurrentTexture().createView();
    return { view, acquireMs: measure ? this.now() - started : 0 };
  }

  encode(encoder: GPUCommandEncoder, source: GPUTexture, present: GPUTextureView,
    effects?: PbrAuthorColorEffects, queries?: GPUQuerySet, detailedTiming = false): void {
    if (this.disposed) throw new Error("PBR output is disposed.");
    this.author.update(effects);
    const hdr = this.hdrState === "active" && this.hdrRuntime !== undefined;
    if (hdr) this.encodeHdr(encoder, source, present, queries, detailedTiming);
    else this.encodeSdr(encoder, source, present, queries, detailedTiming);
  }

  /** 既有 SDR present 链(逐字节保持;HDR 未激活/激活中/回退时唯一通路)。 */
  private encodeSdr(encoder: GPUCommandEncoder, source: GPUTexture, present: GPUTextureView,
    queries?: GPUQuerySet, detailedTiming = false): void {
    const binding = this.binding(source);
    if (this.spatialAaEnabled) this.spatialAa ??= new SpatialAaPresent(this.session);
    const displayTarget = this.spatialAa?.prepare(source.width, source.height) ?? present;
    const pass = encoder.beginRenderPass({ label: "Deep display output",
      ...(queries ? { timestampWrites: { querySet: queries,
        ...(detailedTiming ? { beginningOfPassWriteIndex: 3 } : {}),
        ...(!this.spatialAa ? { endOfPassWriteIndex: 1 } : {}) } } : {}),
      colorAttachments: [{ view: displayTarget, loadOp: "clear", storeOp: "store" }] });
    try {
      pass.setPipeline(this.pipelines.output); pass.setBindGroup(0, binding);
      pass.setBindGroup(1, this.author.binding); pass.draw(3);
    } finally { pass.end(); }
    this.spatialAa?.encode(encoder, present, queries);
  }

  /**
   * HDR present 链:HDR 变体管线直出 surface(SMAA 是 8bit 中间目标,HDR 域必须旁路,
   * 策略语义 = "extended-linear/pq/hlg 编码后的显示域不再过空间 AA")。
   */
  private encodeHdr(encoder: GPUCommandEncoder, source: GPUTexture, present: GPUTextureView,
    queries?: GPUQuerySet, detailedTiming = false): void {
    const runtime = this.hdrRuntime!;
    if (!this.hdrSettingsWritten) {
      this.session.device.queue.writeBuffer(runtime.hdrSettingsBuffer, 0,
        hdrSettingsUniform(this.hdrPolicy!, HDR_REFERENCE_WHITE_NITS, DEFAULT_EXTENDED_HEADROOM));
      this.hdrSettingsWritten = true;
    }
    const binding = this.hdrBinding(runtime, source);
    const pass = encoder.beginRenderPass({ label: "Deep HDR display output",
      ...(queries ? { timestampWrites: { querySet: queries,
        ...(detailedTiming ? { beginningOfPassWriteIndex: 3 } : {}),
        endOfPassWriteIndex: 1 } } : {}),
      colorAttachments: [{ view: present, loadOp: "clear", storeOp: "store" }] });
    try {
      pass.setPipeline(runtime.pipeline); pass.setBindGroup(0, binding);
      pass.setBindGroup(1, this.author.binding); pass.draw(3);
    } finally { pass.end(); }
  }

  present(encoder: GPUCommandEncoder, source: GPUTexture, effects: PbrAuthorColorEffects | undefined,
    measure: boolean, queries?: GPUQuerySet, captureSource = false, detailedTiming = false): PbrPresentReceipt {
    const surface = this.acquirePresent(measure);
    this.encode(encoder, source, surface.view, effects, queries, detailedTiming);
    // A logical present containing SpatialAA has multiple shader owners; keep it unmapped.
    if (captureSource && this.hdrState === "active" && this.hdrRuntime) {
      return { ...surface, sourceMapRefs: this.hdrRuntime.provenance.refsFor(this.hdrRuntime.pipeline) };
    }
    if (captureSource && !this.spatialAaEnabled) {
      const provenance = this.pipelines.outputShaderProvenance;
      if (!provenance) throw new Error("PBR output pipeline has no executable shader provenance.");
      return { ...surface, sourceMapRefs: provenance.refsFor(this.pipelines.output) };
    }
    return surface;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hdrGeneration++;
    if (this.hdrRuntime) { this.session.release(this.hdrRuntime.hdrSettingsBuffer); this.hdrRuntime = undefined; }
    this.hdrBindings = new WeakMap();
    try { this.overlay?.dispose(); }
    finally { try { this.spatialAa?.dispose(); }
      finally { try { this.author.dispose(); } finally { this.session.release(this.buffer); } } }
  }

  encodeEditorOverlay(encoder: GPUCommandEncoder, target: GPUTextureView, snapshot?: EditorOverlaySnapshot, queries?: GPUQuerySet): number {
    if (!snapshot && !this.overlay) return 0;
    this.overlay ??= new EditorOverlayPass(this.session);
    return this.overlay.encode(encoder, target, snapshot, queries);
  }

  view(texture: GPUTexture): GPUTextureView {
    let view = this.textureViews.get(texture);
    if (!view) { view = texture.createView(); this.textureViews.set(texture, view); }
    return view;
  }

  private binding(texture: GPUTexture): GPUBindGroup {
    let binding = this.bindings.get(texture);
    if (!binding) {
      binding = this.session.device.createBindGroup({ layout: this.pipelines.output.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.view(texture) }, { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.buffer } },
      ] });
      this.bindings.set(texture, binding);
    }
    return binding;
  }

  private hdrBindings = new WeakMap<GPUTexture, GPUBindGroup>();
  private hdrBinding(runtime: HdrDisplayPipeline, texture: GPUTexture): GPUBindGroup {
    let binding = this.hdrBindings.get(texture);
    if (!binding) {
      binding = this.session.device.createBindGroup({ layout: runtime.bindGroupLayout, entries: [
        { binding: 0, resource: this.view(texture) }, { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.buffer } },
        { binding: 3, resource: { buffer: runtime.hdrSettingsBuffer } },
      ] });
      this.hdrBindings.set(texture, binding);
    }
    return binding;
  }
}

/** 第一切片计划对拍声明(DE26/B03):present 显示 pass 的实际读写;纯函数,不触 GPU。 */
export function describePbrPresentPasses(inputResourceId: string, spatialAa = true, hdrDisplay = false): PbrActualPassDescription {
  return {
    passId: "present", executor: "PbrOutputBindings.present → \"Deep display output\"", kind: "render",
    reads: [inputResourceId], writes: ["surface"],
    claims: [{ id: inputResourceId, access: "read", format: PBR_HDR_FORMAT, sampleCount: 1,
      usages: inputResourceId === "opaque-hdr" || inputResourceId === "composited-hdr" || inputResourceId === "contact-hdr"
        ? ["render-attachment", "texture-binding", "storage-binding", "copy-src"]
        // ssr-hdr 自 C12 起带 COPY_SRC(present-color 读回链落点,与 ao/temporal 对齐)。
        : inputResourceId === "ssr-hdr"
          ? ["storage-binding", "texture-binding", "copy-src"]
          : inputResourceId === "volumetric-fog-hdr"
            ? ["storage-binding", "texture-binding", "copy-src"] : inputResourceId === "temporal-hdr"
              ? ["storage-binding", "texture-binding", "copy-src"]
              : inputResourceId === "upscale-hdr"
                // F4 超分输出是唯一 display 尺寸输入(读回链落点,usages 同 temporal 合同)。
                ? ["storage-binding", "texture-binding", "copy-src"]
                : ["texture-binding", "storage-binding", "render-attachment", "copy-src"],
      sizeRole: inputResourceId === "upscale-hdr" ? "display" : "surface" },
      { id: "surface", access: "write", format: hdrDisplay ? PBR_HDR_FORMAT : "swapchain", sampleCount: 1,
        usages: ["render-attachment"], sizeRole: "independent" }],
    // HDR present 直出(SMAA 8bit 中间目标在 HDR 域旁路),无 unplanned attachment。
    ...(spatialAa && !hdrDisplay ? { unplannedAttachments: [{ id: "spatial-aa-intermediate",
      reason: "SMAA 先渲染到中间纹理再拷贝到 swapchain 视图,第一切片未入图" }] } : {}),
    gpuPassCount: spatialAa && !hdrDisplay ? 2 : 1,
  };
}
