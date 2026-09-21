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

export interface PbrPresentReceipt {
  readonly view: GPUTextureView;
  readonly acquireMs: number;
  readonly sourceMapRefs?: readonly FrameCaptureSourceMapRef[];
}

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

  constructor(private readonly session: DeviceSession, private readonly pipelines: Pipelines, private readonly now: () => number,
    private readonly spatialAaEnabled = true) {
    this.buffer = uploadBuffer(session, "Deep output", this.data, GPUBufferUsage.UNIFORM);
    try {
      this.sampler = session.device.createSampler({ minFilter: "linear", magFilter: "linear" });
      this.author = new PbrAuthorColorBindings(session, pipelines.output.getBindGroupLayout(1));
    } catch (error) { session.release(this.buffer); throw error; }
  }

  encode(encoder: GPUCommandEncoder, source: GPUTexture, present: GPUTextureView,
    effects?: PbrAuthorColorEffects, queries?: GPUQuerySet): void {
    if (this.disposed) throw new Error("PBR output is disposed.");
    this.author.update(effects);
    const binding = this.binding(source);
    if (this.spatialAaEnabled) this.spatialAa ??= new SpatialAaPresent(this.session);
    const displayTarget = this.spatialAa?.prepare(source.width, source.height) ?? present;
    const pass = encoder.beginRenderPass({ label: "Deep display output",
      ...(!this.spatialAa && queries ? { timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } } : {}),
      colorAttachments: [{ view: displayTarget, loadOp: "clear", storeOp: "store" }] });
    try {
      pass.setPipeline(this.pipelines.output); pass.setBindGroup(0, binding);
      pass.setBindGroup(1, this.author.binding); pass.draw(3);
    } finally { pass.end(); }
    this.spatialAa?.encode(encoder, present, queries);
  }

  acquirePresent(measure: boolean): { view: GPUTextureView; acquireMs: number } {
    if (this.disposed) throw new Error("PBR output is disposed.");
    const started = measure ? this.now() : 0;
    const view = this.session.context.getCurrentTexture().createView();
    return { view, acquireMs: measure ? this.now() - started : 0 };
  }

  present(encoder: GPUCommandEncoder, source: GPUTexture, effects: PbrAuthorColorEffects | undefined,
    measure: boolean, queries?: GPUQuerySet, captureSource = false): PbrPresentReceipt {
    const surface = this.acquirePresent(measure);
    this.encode(encoder, source, surface.view, effects, queries);
    // A logical present containing SpatialAA has multiple shader owners; keep it unmapped.
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
}

/** 第一切片计划对拍声明(DE26/B03):present 显示 pass 的实际读写;纯函数,不触 GPU。 */
export function describePbrPresentPasses(inputResourceId: string, spatialAa = true): PbrActualPassDescription {
  return {
    passId: "present", executor: "PbrOutputBindings.present → \"Deep display output\"", kind: "render",
    reads: [inputResourceId], writes: ["surface"],
    claims: [{ id: inputResourceId, access: "read", format: PBR_HDR_FORMAT, sampleCount: 1,
      usages: inputResourceId === "opaque-hdr" || inputResourceId === "composited-hdr"
        ? ["render-attachment", "texture-binding", "storage-binding", "copy-src"]
        : inputResourceId === "ssr-hdr" || inputResourceId === "volumetric-fog-hdr"
          ? ["storage-binding", "texture-binding"] : inputResourceId === "temporal-hdr"
            ? ["storage-binding", "texture-binding", "copy-src"]
            : ["texture-binding", "storage-binding", "render-attachment", "copy-src"], sizeRole: "surface" },
      { id: "surface", access: "write", format: "swapchain", sampleCount: 1,
        usages: ["render-attachment"], sizeRole: "independent" }],
    ...(spatialAa ? { unplannedAttachments: [{ id: "spatial-aa-intermediate",
      reason: "SMAA 先渲染到中间纹理再拷贝到 swapchain 视图,第一切片未入图" }] } : {}),
    gpuPassCount: spatialAa ? 2 : 1,
  };
}
